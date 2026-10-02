/**
 * Refuses a native release unless the commit its tag points at passed CI.
 *
 * A store binary cannot be rolled back the way an OTA bundle can, so the only
 * run that counts is a push-event `ci.yml` run on `main` for exactly that
 * commit: a dispatched `ci.yml` run deploys with the check jobs skipped, so it
 * proves nothing about the code. The newest such run is judged, so a newer
 * failure is never passed over for an older success. Anything the API does not
 * answer readably throws, which stops the release rather than admitting it.
 */
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { isMainModule } from '../lib/cli/is-main.js';
import { runMain } from '../lib/cli/run-main.js';

const CI_WORKFLOW_FILE = 'ci.yml';
const TRUSTED_EVENT = 'push';
const TRUSTED_BRANCH = 'main';
/** The largest page the run listing serves; one commit never has more push runs on one branch. */
const RUN_PAGE = 100;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

interface ListedRun {
  readonly runNumber: number;
  readonly headSha: string;
  readonly event: string;
  readonly headBranch: string;
  readonly status: string;
  readonly conclusion: string | null;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

function readRun(value: unknown): ListedRun {
  const runNumber = field(value, 'run_number');
  const headSha = field(value, 'head_sha');
  const event = field(value, 'event');
  const headBranch = field(value, 'head_branch');
  const status = field(value, 'status');
  const conclusion = field(value, 'conclusion');
  if (
    typeof runNumber !== 'number' ||
    typeof headSha !== 'string' ||
    typeof event !== 'string' ||
    typeof headBranch !== 'string' ||
    typeof status !== 'string' ||
    (conclusion !== null && typeof conclusion !== 'string')
  ) {
    throw new TypeError('The CI run listing reported a run it could not describe.');
  }
  return { runNumber, headSha, event, headBranch, status, conclusion };
}

async function listRuns(
  env: NodeJS.ProcessEnv,
  commit: string,
  fetchImpl: typeof fetch
): Promise<ListedRun[]> {
  const query = new URLSearchParams({
    head_sha: commit,
    event: TRUSTED_EVENT,
    branch: TRUSTED_BRANCH,
    per_page: String(RUN_PAGE),
  });
  const url = `${required(env, 'GITHUB_API_URL')}/repos/${required(env, 'GITHUB_REPOSITORY')}/actions/workflows/${CI_WORKFLOW_FILE}/runs?${query.toString()}`;
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${required(env, 'GITHUB_TOKEN')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  // The status alone: an authenticated endpoint's error body can quote the request back.
  if (!response.ok) {
    throw new Error(`The CI run listing failed with status ${String(response.status)}.`);
  }
  const runs = field(await response.json(), 'workflow_runs');
  if (!Array.isArray(runs)) {
    throw new TypeError('The CI run listing answered with no workflow runs.');
  }
  return (runs as unknown[]).map((run) => readRun(run));
}

/**
 * The listing's filters are re-checked here rather than trusted: a run the
 * server should have left out must still never count.
 */
function newestTrustedRun(runs: readonly ListedRun[], commit: string): ListedRun | undefined {
  let newest: ListedRun | undefined;
  for (const run of runs) {
    const trusted =
      run.headSha === commit && run.event === TRUSTED_EVENT && run.headBranch === TRUSTED_BRANCH;
    if (trusted && (newest === undefined || run.runNumber > newest.runNumber)) newest = run;
  }
  return newest;
}

/** 0 when the tagged commit's newest push run of `ci.yml` on `main` succeeded, 1 otherwise. */
export async function main(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<number> {
  const commit = required(env, 'RELEASE_COMMIT');
  const tag = required(env, 'RELEASE_TAG');
  const run = newestTrustedRun(await listRuns(env, commit, fetchImpl), commit);
  if (run?.status === 'completed' && run.conclusion === 'success') {
    process.stdout.write(`OK: ${tag} (${commit}) passed CI on ${TRUSTED_BRANCH}.\n`);
    return 0;
  }
  const seen =
    run === undefined
      ? `has no ${TRUSTED_EVENT}-event ${CI_WORKFLOW_FILE} run on ${TRUSTED_BRANCH}`
      : `has a newest ${TRUSTED_EVENT}-event ${CI_WORKFLOW_FILE} run on ${TRUSTED_BRANCH} that is ${run.status} with conclusion ${String(run.conclusion)}`;
  process.stdout.write(
    `::error::${tag} points at ${commit}, which ${seen}. Release only a commit CI passed.\n`
  );
  return 1;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/release/release-ci-gate.ts',
  summary:
    "Refuses a native release unless the tagged commit's push run of ci.yml on main succeeded.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through the release workflow */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    return main(process.env, fetch);
  });
}
/* v8 ignore stop */
