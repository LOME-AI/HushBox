/**
 * The merge queue's alignment gate.
 *
 * The invariant the topology rests on is that public `main` is always an
 * ancestor of staging `main`. A queue merge that lands on public while the
 * inbound sync has not yet carried the previous one into staging breaks it, and
 * the outbound mirror then refuses every later publication as a non-fast-forward
 * — the stall the auditor exists to report. So the queue waits here instead.
 *
 * The question is asked in two parts, and the split is the point. Each
 * repository's head is resolved from its OWN address, then the staging
 * repository alone is asked whether it holds the public head — a comparison
 * between two object ids inside one repository. A single cross-repository
 * comparison would have been shorter, but the endpoint's `owner:repository:ref`
 * qualification discards the repository segment: both sides resolve inside
 * whichever repository the call names, so the gate would answer `identical`
 * against itself forever. Verified against two real repositories under one
 * owner, one of which does not carry the branch the qualification named.
 *
 * `identical` and `ahead` both mean staging already holds everything public
 * does; anything else, and any status this does not recognise, is a stop.
 * Running out of attempts is a failure rather than a pass: the whole point is
 * that the merge does not proceed on an unanswered question.
 */
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { runMain } from '../lib/cli/run-main.js';
import { readRepositories, type Repositories } from '../configure-git-clone.js';
import { syncBotToken } from '../lib/publication/sync-bot-credential.js';
import { MAIN } from '../lib/publication/git.js';

const API = 'https://api.github.com';

/** Long enough for an inbound sync to run; short enough to fail a wedged queue. */
export const ALIGNMENT_ATTEMPTS = 20;
const ALIGNMENT_DELAY_MS = 15_000;

/**
 * The comparison's answer when staging does not hold the public commit at all.
 * A wait state rather than an error: the head resolution for the same
 * repository has just succeeded, so the repository is present and readable and
 * the only thing missing is the commit the inbound sync has yet to carry.
 */
const ABSENT = 'absent';

const ALIGNED = new Set(['identical', 'ahead']);

export function isAligned(status: string): boolean {
  return ALIGNED.has(status);
}

type Sleep = (milliseconds: number) => Promise<void>;

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'hushbox-sync',
  };
}

/**
 * The object id a repository's branch points at, asked of that repository by
 * path. A path segment cannot be reinterpreted as a ref, which is exactly the
 * property the discarded qualification lacked.
 */
export async function readMainHead(
  fetchImpl: typeof fetch,
  token: string,
  repository: string
): Promise<string> {
  const response = await fetchImpl(`${API}/repos/${repository}/git/ref/heads/${MAIN}`, {
    method: 'GET',
    headers: headers(token),
  });
  if (!response.ok) {
    throw new Error(`Resolving a branch head failed with status ${String(response.status)}.`);
  }
  const body = (await response.json()) as { object?: { sha?: unknown } };
  const sha = body.object?.sha;
  if (typeof sha !== 'string' || sha === '') {
    throw new TypeError('A branch head resolved to no object id.');
  }
  return sha;
}

export async function readAlignment(
  fetchImpl: typeof fetch,
  token: string,
  repositories: Repositories
): Promise<string> {
  // Staging first. Between the two reads either head can advance, and taking
  // public's second means a publication landing mid-check is compared against
  // the older staging head — the direction that refuses rather than passes.
  const stagingHead = await readMainHead(fetchImpl, token, repositories.stagingRepo);
  const publicHead = await readMainHead(fetchImpl, token, repositories.publicRepo);

  const response = await fetchImpl(
    `${API}/repos/${repositories.stagingRepo}/compare/${publicHead}...${stagingHead}`,
    { method: 'GET', headers: headers(token) }
  );
  if (response.status === 404) return ABSENT;
  if (!response.ok) {
    throw new Error(`The commit comparison failed with status ${String(response.status)}.`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const status = body['status'];
  if (typeof status !== 'string') {
    throw new TypeError('The commit comparison answered with no status.');
  }
  return status;
}

export async function awaitAlignment(
  fetchImpl: typeof fetch,
  token: string,
  repositories: Repositories,
  sleep: Sleep
): Promise<string> {
  let status = '';
  for (let attempt = 0; attempt < ALIGNMENT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(ALIGNMENT_DELAY_MS);
    status = await readAlignment(fetchImpl, token, repositories);
    if (isAligned(status)) return status;
  }
  throw new Error(
    `Staging does not contain the public head after ${String(ALIGNMENT_ATTEMPTS)} attempts ` +
      `(last comparison: ${status}); the inbound sync has not carried public main into ` +
      'staging. Merging now would strand it.'
  );
}

export const COMMAND_LINE = {
  command: 'tsx scripts/publication/sync-alignment.ts',
  summary: 'Checks that the public and staging trunks are aligned.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const repositories = await readRepositories();
    const token = await syncBotToken(
      'The alignment gate',
      repositories.stagingRepo,
      process.env,
      fetch
    );
    const status = await awaitAlignment(
      fetch,
      token,
      repositories,
      async (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        })
    );
    console.log(`Staging and public are aligned (${status}).`);
    return 0;
  });
}
/* v8 ignore stop */
