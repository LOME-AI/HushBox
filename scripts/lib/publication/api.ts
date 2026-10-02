/**
 * The GitHub REST surface this repository's automation reads and writes.
 *
 * Every call goes out under the sync app's installation token, and every
 * failure reports the status alone: an error body from an authenticated
 * endpoint can quote back what was sent to it.
 */
import { scopedInstallationAccessToken } from './github-app-token.js';
import { readSyncAppCredentials } from './sync-bot-credential.js';

const API = 'https://api.github.com';

/** Who is asking, of which repository, with what. */
export interface RepositoryApi {
  readonly fetchImpl: typeof fetch;
  readonly token: string;
  readonly repository: string;
}

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'hushbox-sync',
});

interface Write {
  readonly method: string;
  readonly payload: unknown;
}

async function request(
  api: RepositoryApi,
  route: string,
  what: string,
  write?: Write
): Promise<unknown> {
  const response = await api.fetchImpl(`${API}${route}`, {
    method: write?.method ?? 'GET',
    headers:
      write === undefined
        ? headers(api.token)
        : { ...headers(api.token), 'content-type': 'application/json' },
    ...(write === undefined ? {} : { body: JSON.stringify(write.payload) }),
  });
  if (!response.ok) {
    throw new Error(`${what} failed with status ${String(response.status)}.`);
  }
  return response.json();
}

const field = (answer: unknown, key: string): unknown =>
  typeof answer === 'object' && answer !== null
    ? (answer as Record<string, unknown>)[key]
    : undefined;

function listing(answer: unknown, what: string): unknown[] {
  if (!Array.isArray(answer)) throw new TypeError(`${what} answered with no listing.`);
  return answer as unknown[];
}

/** One job of a workflow run, as the jobs listing reports it. */
export interface TrustedRunJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** The newest push run of one workflow on `main` for one commit, and its latest jobs. */
export interface TrustedRun {
  /** The commit the run reports it ran, re-read rather than trusted to the filter. */
  readonly runHeadSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly jobs: readonly TrustedRunJob[];
  /** How many jobs the listing says the run holds, which `jobs` must account for. */
  readonly totalCount: number;
}

/** The largest page the run and job listings serve, which is also what they are asked for. */
const RUN_PAGE = 100;

function readString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} was not reported.`);
  return value;
}

function readNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new TypeError(`${what} was not reported.`);
  return value;
}

function readConclusion(value: unknown, what: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new TypeError(`${what} was unreadable.`);
  }
  return value;
}

/**
 * Staging's trusted run for one commit: the newest `event=push` run of the
 * workflow on `main` whose head is `sha`, or `null` where there is none.
 *
 * Newest by run number rather than by listing order, which the API does not
 * document: a newer failed or running run must never be passed over for an
 * older success.
 */
export async function readTrustedRun(
  api: RepositoryApi,
  workflowFile: string,
  sha: string
): Promise<TrustedRun | null> {
  const runQuery = new URLSearchParams({
    head_sha: sha,
    event: 'push',
    branch: 'main',
    per_page: String(RUN_PAGE),
  });
  const answer = await request(
    api,
    `/repos/${api.repository}/actions/workflows/${workflowFile}/runs?${runQuery.toString()}`,
    'the trusted-run read'
  );
  const runs = field(answer, 'workflow_runs');
  if (!Array.isArray(runs)) {
    throw new TypeError('The trusted-run read answered with no workflow runs.');
  }
  let newest: unknown;
  let newestNumber = Number.NEGATIVE_INFINITY;
  for (const run of runs as unknown[]) {
    const number = readNumber(field(run, 'run_number'), 'A workflow run number');
    if (number > newestNumber) {
      newest = run;
      newestNumber = number;
    }
  }
  if (newest === undefined) return null;

  const id = readNumber(field(newest, 'id'), 'The trusted run id');
  const runHeadSha = readString(field(newest, 'head_sha'), 'The trusted run head commit');
  const status = readString(field(newest, 'status'), 'The trusted run status');
  const conclusion = readConclusion(field(newest, 'conclusion'), 'The trusted run conclusion');

  const jobQuery = new URLSearchParams({ filter: 'latest', per_page: String(RUN_PAGE) });
  const listed = await request(
    api,
    `/repos/${api.repository}/actions/runs/${String(id)}/jobs?${jobQuery.toString()}`,
    'the trusted-run job read'
  );
  const totalCount = readNumber(field(listed, 'total_count'), 'The trusted run job total');
  const jobs = field(listed, 'jobs');
  if (!Array.isArray(jobs)) {
    throw new TypeError('The trusted-run job read answered with no jobs.');
  }
  return {
    runHeadSha,
    status,
    conclusion,
    totalCount,
    jobs: (jobs as unknown[]).map((job) => ({
      name: readString(field(job, 'name'), 'A trusted run job name'),
      status: readString(field(job, 'status'), 'A trusted run job status'),
      conclusion: readConclusion(field(job, 'conclusion'), 'A trusted run job conclusion'),
    })),
  };
}

/**
 * Whether staging's trusted run proved `sha`: the run is for that commit, it
 * completed successfully, its job listing is whole, and every borrowed job —
 * each leg, for a matrix job — succeeded. A skipped job proves nothing, and
 * anything the run does not positively show reads as unproven.
 */
export function isBorrowable(
  run: TrustedRun | null,
  sha: string,
  borrowedJobs: readonly string[]
): boolean {
  if (run === null) return false;
  if (run.runHeadSha !== sha) return false;
  if (run.status !== 'completed' || run.conclusion !== 'success') return false;
  if (run.totalCount !== run.jobs.length) return false;
  return borrowedJobs.every((key) => {
    const legs = run.jobs.filter((job) => job.name === key || job.name.startsWith(`${key} (`));
    return legs.length > 0 && legs.every((job) => job.conclusion === 'success');
  });
}

/**
 * The sync bot's token for reading staging's runs, narrowed to staging alone and
 * to Actions read: the endpoints {@link readTrustedRun} calls need no more, and
 * a token that cannot push cannot be misused as the one that publishes.
 */
export async function stagingRunReaderToken(
  what: string,
  stagingRepository: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<string> {
  const [owner, name, ...rest] = stagingRepository.split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) {
    throw new Error(`${what} needs the staging repository as owner/name.`);
  }
  return scopedInstallationAccessToken(
    readSyncAppCredentials(what, env),
    {
      repository: stagingRepository,
      scope: { repositories: [name], permissions: { actions: 'read' } },
    },
    Math.floor(Date.now() / 1000),
    fetchImpl
  );
}

/**
 * The newest run of one workflow the status filter admits, or `undefined` where
 * the filter admits none. One reader for every such question: the filter and
 * what is taken off the run are all that differ between them, and two copies of
 * the listing read are two places for the refusal to go missing from.
 */
async function newestRunUnder(
  api: RepositoryApi,
  workflowFile: string,
  status: string
): Promise<unknown> {
  const answer = await request(
    api,
    `/repos/${api.repository}/actions/workflows/${workflowFile}/runs?status=${status}&per_page=1`,
    'the workflow-run read'
  );
  const runs = field(answer, 'workflow_runs');
  if (!Array.isArray(runs)) {
    throw new TypeError('The workflow-run read answered with no workflow runs.');
  }
  return (runs as unknown[])[0];
}

/**
 * When one workflow last finished successfully, in epoch milliseconds, or
 * `null` if it never has. Read rather than printed: the auditor compares it
 * against a window and reports the verdict, never the instant.
 */
export async function latestSuccessfulRunMillis(
  api: RepositoryApi,
  workflowFile: string
): Promise<number | null> {
  const newest = await newestRunUnder(api, workflowFile, 'success');
  if (newest === undefined) return null;
  const millis = Date.parse(String(field(newest, 'updated_at')));
  if (Number.isNaN(millis)) {
    throw new TypeError('A workflow run reported an unreadable completion instant.');
  }
  return millis;
}

/** One finished run of a workflow, and where a reader can open it. */
interface CompletedRun {
  readonly id: number;
  readonly url: string;
}

/**
 * The newest run of one workflow that reached an end, whatever it concluded, or
 * `null` if none ever has. Success is deliberately not filtered on: a caller
 * asking what the last run left behind is asking about the run that happened,
 * and a filter for green would answer with a run from before the breakage.
 */
export async function newestCompletedRun(
  api: RepositoryApi,
  workflowFile: string
): Promise<CompletedRun | null> {
  const newest = await newestRunUnder(api, workflowFile, 'completed');
  if (newest === undefined) return null;
  return { id: Number(field(newest, 'id')), url: String(field(newest, 'html_url')) };
}

/** The largest page the artifact listing serves, which is also what it is asked for. */
const ARTIFACT_PAGE = 100;

/**
 * What one run published, by name. An expired artifact still carries a record
 * here, so a run whose files have aged out is still evidence that it published
 * them. A run that published more than one page would read as having published
 * only the first, which over-reports a missing artifact rather than hiding one —
 * the safe direction for a reader that alerts on absence.
 */
export async function runArtifactNames(api: RepositoryApi, run: number): Promise<string[]> {
  const answer = await request(
    api,
    `/repos/${api.repository}/actions/runs/${String(run)}/artifacts?per_page=${String(ARTIFACT_PAGE)}`,
    'the artifact listing'
  );
  const artifacts = field(answer, 'artifacts');
  if (!Array.isArray(artifacts)) {
    throw new TypeError('The artifact listing answered with no artifacts.');
  }
  return (artifacts as unknown[]).map((artifact) => String(field(artifact, 'name')));
}

/**
 * The open issue carrying exactly this title, if one is open. The endpoint
 * lists pull requests alongside issues, and a pull request is not something
 * this may close.
 */
export async function findOpenIssue(api: RepositoryApi, title: string): Promise<number | null> {
  const answer = await request(
    api,
    `/repos/${api.repository}/issues?state=open&per_page=100`,
    'the issue listing'
  );
  const match = listing(answer, 'the issue listing').find(
    (entry) => field(entry, 'title') === title && field(entry, 'pull_request') === undefined
  );
  return match === undefined ? null : Number(field(match, 'number'));
}

export async function openIssue(api: RepositoryApi, title: string, body: string): Promise<void> {
  await request(api, `/repos/${api.repository}/issues`, 'the issue filing', {
    method: 'POST',
    payload: { title, body },
  });
}

export async function closeIssue(api: RepositoryApi, issue: number): Promise<void> {
  await request(api, `/repos/${api.repository}/issues/${String(issue)}`, 'the issue close', {
    method: 'PATCH',
    payload: { state: 'closed', state_reason: 'completed' },
  });
}

/** What one reconciliation pass did to the alert carrying its title. */
export type IssueAction = 'opened' | 'left-open' | 'closed' | 'none';

/**
 * One open issue per title stands for one condition: open means the condition
 * holds, closed means it does not, and a reader needs no other state to know
 * which. `body` is the alert's text while the condition holds, and `null` once
 * it no longer does.
 *
 * Shared by every auditor rather than written per auditor, because the property
 * that matters is a single alert per condition and two copies of this are two
 * places for a second one to be filed from.
 */
export async function reconcileIssue(
  api: RepositoryApi,
  title: string,
  body: string | null
): Promise<IssueAction> {
  const open = await findOpenIssue(api, title);
  if (body !== null) {
    if (open !== null) return 'left-open';
    await openIssue(api, title, body);
    return 'opened';
  }
  if (open === null) return 'none';
  await closeIssue(api, open);
  return 'closed';
}
