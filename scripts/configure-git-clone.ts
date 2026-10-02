/**
 * Configures a clone at install time (wired to the root `prepare`, alongside
 * husky). Three effects, all local to the clone:
 *
 * - `user.useConfigOnly` — git otherwise invents an identity from the machine's
 *   hostname and login name and stamps it onto commits. Refusing that guess is
 *   the only way an unconfigured clone cannot publish whose machine it is.
 * - the push URL of `origin` — a maintainer who cloned the public repository and
 *   can reach staging pushes to staging while fetching from public, which is the
 *   whole of `docs/PUBLICATION.md` §Maintainer setup. Everyone else is left
 *   exactly as they were.
 * - the records overlay — a maintainer who can reach the records repository and
 *   has no overlay and no record files gets them restored (`pnpm records restore`).
 *
 * Both are conveniences, never gates: an unreachable staging repository, a
 * clone of a fork, a repository with no `origin`, a directory that is not a
 * repository, and a machine with no usable git all end as silent no-ops, because
 * this runs inside `pnpm install` and must never fail or stall it.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { messageChain, runMain } from './lib/cli/run-main.js';
import { presentRecordFiles, restore } from './records/operations.js';
import { overlayDirectory } from './records/overlay.js';
import { recordsRemote } from './records/remote.js';

const REPOSITORIES_FILE = 'repositories.json';

/** Long enough for a reachable remote to answer, short enough to never stall an install. */
const PROBE_TIMEOUT_MS = 10_000;

// `.strict()`, because a typo'd key under a permissive object would be stripped
// and leave the remaining slug matching a repository nobody meant.
const repositoriesSchema = z
  .object({
    publicRepo: z.string().min(1),
    stagingRepo: z.string().min(1),
    recordsRepo: z.string().min(1),
  })
  .strict();

export type Repositories = z.infer<typeof repositoriesSchema>;

export type RoutingOutcome =
  | { status: 'no-origin' }
  | { status: 'origin-not-canonical' }
  | { status: 'manual-push-url' }
  | { status: 'already-routed' }
  | { status: 'staging-unreachable' }
  | { status: 'routed' };

export type RecordsOutcome =
  | { status: 'overlay-present' }
  | { status: 'records-unreachable' }
  | { status: 'records-present' }
  | { status: 'restored' }
  | { status: 'restore-failed'; reason: string };

/** `no-repository` covers both an unpacked archive and a machine whose git cannot run. */
export type CloneOutcome =
  | { status: 'no-repository' }
  | { status: 'configured'; routing: RoutingOutcome; records: RecordsOutcome };

export function parseRepositories(source: string): Repositories {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error(`${REPOSITORIES_FILE} is not valid JSON.`);
  }
  const parsed = repositoriesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${REPOSITORIES_FILE} is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

export async function readRepositories(): Promise<Repositories> {
  const file = path.join(import.meta.dirname, REPOSITORIES_FILE);
  return parseRepositories(await fs.readFile(file, 'utf8'));
}

/**
 * The `owner/name` a git URL addresses, lowercased — GitHub treats a slug
 * case-insensitively, so a clone taken under a differently-cased URL is the same
 * repository. Every git URL form ends in those two segments, whether they follow
 * a host, an scp-style colon, or a path.
 */
function slugOf(url: string): string | null {
  const trimmed = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const segments = trimmed.split(/[/:]/).filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  return segments.slice(-2).join('/').toLowerCase();
}

/**
 * The staging URL for a clone of the canonical public repository, or null when
 * `origin` is anything else — a fork, another owner's mirror, an unrelated
 * remote. The slug is substituted inside the URL rather than a URL being built
 * from a template, so the clone's own transport, host, credentials and `.git`
 * suffix all carry through: a maintainer who clones over ssh keeps pushing over
 * ssh.
 */
export function stagingPushUrl(originUrl: string, repositories: Repositories): string | null {
  const publicSlug = repositories.publicRepo.toLowerCase();
  if (slugOf(originUrl) !== publicSlug) return null;
  const at = originUrl.toLowerCase().lastIndexOf(publicSlug);
  // The two segments are adjacent in every git URL form, but a string whose
  // owner and name are separated some other way would splice into nonsense.
  if (at === -1) return null;
  return (
    originUrl.slice(0, at) + repositories.stagingRepo + originUrl.slice(at + publicSlug.length)
  );
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await execa('git', [...args], { cwd, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function configuredValue(cwd: string, key: string): Promise<string | null> {
  return git(cwd, ['config', '--local', '--get', key]);
}

/**
 * Whether a private repository answers for this developer's credentials.
 * Prompting is disabled so a clone without access fails immediately instead of
 * stopping the install on a password prompt, and the timeout bounds every other
 * way a remote can decline to answer.
 */
async function canReach(cwd: string, url: string): Promise<boolean> {
  const result = await execa('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
    cwd,
    reject: false,
    timeout: PROBE_TIMEOUT_MS,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  return result.exitCode === 0;
}

async function route(cwd: string, repositories: Repositories): Promise<RoutingOutcome> {
  const originUrl = await configuredValue(cwd, 'remote.origin.url');
  if (originUrl === null) return { status: 'no-origin' };

  const stagingUrl = stagingPushUrl(originUrl, repositories);
  if (stagingUrl === null) return { status: 'origin-not-canonical' };

  // A push URL that is already staging is the cache of a successful probe: a
  // routed clone never probes again. A failed probe caches nothing on purpose —
  // a dedicated "staging is unreachable" key would make one offline install
  // permanent, and the maintainer who was on a plane would never be routed.
  const pushUrl = await configuredValue(cwd, 'remote.origin.pushurl');
  if (pushUrl !== null) {
    const routed = slugOf(pushUrl) === repositories.stagingRepo.toLowerCase();
    return { status: routed ? 'already-routed' : 'manual-push-url' };
  }

  if (!(await canReach(cwd, stagingUrl))) return { status: 'staging-unreachable' };
  await git(cwd, ['remote', 'set-url', '--push', 'origin', stagingUrl]);
  return { status: 'routed' };
}

/**
 * The probe comes before the record-file check: a fork's own runs write record
 * files too, and a fork must see no output, so nothing is said to anyone the
 * records repository does not answer. Nothing here throws — a restore that
 * cannot finish is reported and the install goes on.
 */
async function restoreRecords(cwd: string, repositories: Repositories): Promise<RecordsOutcome> {
  if (existsSync(overlayDirectory(cwd))) return { status: 'overlay-present' };
  const remote = recordsRemote(repositories);
  if (!(await canReach(cwd, remote))) return { status: 'records-unreachable' };
  try {
    const present = await presentRecordFiles(cwd);
    if (present.length > 0) return { status: 'records-present' };
    await restore({ root: cwd, remote, log: () => undefined });
  } catch (error) {
    return { status: 'restore-failed', reason: messageChain(error) };
  }
  return { status: 'restored' };
}

export async function configureGitClone(
  cwd: string,
  repositories: Repositories
): Promise<CloneOutcome> {
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') {
    return { status: 'no-repository' };
  }
  // Reasserted on every install rather than set once: this is a privacy floor,
  // not a preference, and a clone that has turned it off stamps its machine's
  // name onto the next commit.
  await git(cwd, ['config', '--local', 'user.useConfigOnly', 'true']);
  return {
    status: 'configured',
    routing: await route(cwd, repositories),
    records: await restoreRecords(cwd, repositories),
  };
}

/**
 * The pre-push belt: from a clone whose pushes are routed to staging, a push
 * aimed at the public repository is somebody bypassing the mirror by hand.
 * Returns the refusal, or null when there is nothing to refuse.
 */
export async function checkPushDestination(
  cwd: string,
  destinationUrl: string,
  repositories: Repositories
): Promise<string | null> {
  const pushUrl = await configuredValue(cwd, 'remote.origin.pushurl');
  if (pushUrl === null || slugOf(pushUrl) !== repositories.stagingRepo.toLowerCase()) return null;
  if (slugOf(destinationUrl) !== repositories.publicRepo.toLowerCase()) return null;
  return (
    `refusing to push to ${repositories.publicRepo}: this clone pushes to ` +
    `${repositories.stagingRepo}, and the public repository is written only by the mirror.`
  );
}

export function describeOutcome(outcome: CloneOutcome): string | null {
  if (outcome.status !== 'configured') return null;
  if (outcome.routing.status === 'routed') {
    return 'git push now goes to the staging repository; fetch is unchanged (git remote -v).';
  }
  if (outcome.routing.status === 'manual-push-url') {
    return 'leaving the push URL of origin as you set it.';
  }
  return null;
}

export function describeRecords(records: RecordsOutcome): string | null {
  if (records.status === 'restored') {
    return 'records: restored .records.git from the records repository.';
  }
  if (records.status === 'records-present') {
    return 'records: record files exist but .records.git does not; run pnpm records init to start the overlay.';
  }
  if (records.status === 'restore-failed') {
    const [first] = records.reason.replace(/^records: /u, '').split('\n');
    return `records: .records.git was not restored (${String(first)}); run pnpm records restore to retry.`;
  }
  return null;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/configure-git-clone.ts',
  summary: "Configures this clone's git settings at install time.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = await configureGitClone(process.cwd(), await readRepositories());
    const lines = [
      describeOutcome(outcome),
      outcome.status === 'configured' ? describeRecords(outcome.records) : null,
    ];
    for (const line of lines) if (line !== null) console.log(line);
  });
}
/* v8 ignore stop */
