import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  closeIssue,
  findOpenIssue,
  isBorrowable,
  latestSuccessfulRunMillis,
  newestCompletedRun,
  openIssue,
  readTrustedRun,
  reconcileIssue,
  runArtifactNames,
  stagingRunReaderToken,
  type RepositoryApi,
  type TrustedRun,
  type TrustedRunJob,
} from './api.js';
import { APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE } from './sync-bot-credential.js';

const TOKEN = 'installation-token';
const MIRROR_FILE = 'publish-mirror.yml';
const ISSUE_TITLE = 'Publication stalled';
const REPOSITORY = 'Example-Org/Example';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly authorization: string | undefined;
}

/** An API surface that answers one queued response per call and records what it was asked. */
function stubApi(responses: readonly { status: number; body: unknown }[]): {
  api: RepositoryApi;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      authorization: headers.get('authorization') ?? undefined,
    });
    const answer = responses[index] ?? { status: 500, body: {} };
    index += 1;
    return Promise.resolve(Response.json(answer.body, { status: answer.status }));
  }) as unknown as typeof fetch;
  return { api: { fetchImpl, token: TOKEN, repository: REPOSITORY }, calls };
}

describe('latestSuccessfulRunMillis', () => {
  it('answers the instant the newest successful run of one workflow finished', async () => {
    const { api, calls } = stubApi([
      {
        status: 200,
        body: { workflow_runs: [{ updated_at: new Date(TEST_DAY_START).toISOString() }] },
      },
    ]);

    expect(await latestSuccessfulRunMillis(api, MIRROR_FILE)).toBe(TEST_DAY_START);
    expect(calls[0]?.url).toContain(`workflows/${MIRROR_FILE}/runs?status=success&per_page=1`);
  });

  it('answers nothing for a workflow that has never succeeded', async () => {
    const { api } = stubApi([{ status: 200, body: { workflow_runs: [] } }]);

    expect(await latestSuccessfulRunMillis(api, MIRROR_FILE)).toBeNull();
  });

  it('refuses a run whose completion instant is unreadable', async () => {
    const { api } = stubApi([
      { status: 200, body: { workflow_runs: [{ updated_at: 'not an instant' }] } },
    ]);

    await expect(latestSuccessfulRunMillis(api, MIRROR_FILE)).rejects.toThrow(/instant/);
  });

  it('refuses an answer carrying no runs field', async () => {
    const { api } = stubApi([{ status: 200, body: {} }]);

    await expect(latestSuccessfulRunMillis(api, MIRROR_FILE)).rejects.toThrow(/workflow runs/);
  });
});

describe('findOpenIssue', () => {
  it('answers the number of the open issue carrying the title', async () => {
    const { api, calls } = stubApi([{ status: 200, body: [{ number: 7, title: ISSUE_TITLE }] }]);

    expect(await findOpenIssue(api, ISSUE_TITLE)).toBe(7);
    expect(calls[0]?.url).toContain(`/repos/${REPOSITORY}/issues?state=open&per_page=100`);
  });

  it('ignores a pull request carrying the same title, since the API lists both', async () => {
    const { api } = stubApi([
      {
        status: 200,
        body: [{ number: 7, title: ISSUE_TITLE, pull_request: { url: 'somewhere' } }],
      },
    ]);

    expect(await findOpenIssue(api, ISSUE_TITLE)).toBeNull();
  });

  it('answers nothing when no open issue carries the title', async () => {
    const { api } = stubApi([{ status: 200, body: [{ number: 7, title: 'Something else' }] }]);

    expect(await findOpenIssue(api, ISSUE_TITLE)).toBeNull();
  });

  it('refuses an answer that is not a listing', async () => {
    const { api } = stubApi([{ status: 200, body: {} }]);

    await expect(findOpenIssue(api, ISSUE_TITLE)).rejects.toThrow(/listing/);
  });
});

describe('openIssue', () => {
  it('files the title and body it was given', async () => {
    const { api, calls } = stubApi([{ status: 201, body: { number: 9 } }]);

    await openIssue(api, ISSUE_TITLE, 'the reason');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain(`/repos/${REPOSITORY}/issues`);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      title: ISSUE_TITLE,
      body: 'the reason',
    });
  });
});

describe('closeIssue', () => {
  it('closes the issue it was given as completed', async () => {
    const { api, calls } = stubApi([{ status: 200, body: { number: 9 } }]);

    await closeIssue(api, 9);

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain(`/repos/${REPOSITORY}/issues/9`);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      state: 'closed',
      state_reason: 'completed',
    });
  });
});

describe('newestCompletedRun', () => {
  it('answers the newest completed run of one workflow', async () => {
    const { api, calls } = stubApi([
      {
        status: 200,
        body: { workflow_runs: [{ id: 12, html_url: 'https://example.invalid/runs/12' }] },
      },
    ]);

    expect(await newestCompletedRun(api, MIRROR_FILE)).toEqual({
      id: 12,
      url: 'https://example.invalid/runs/12',
    });
    expect(calls[0]?.url).toContain(`workflows/${MIRROR_FILE}/runs?status=completed&per_page=1`);
  });

  it('answers nothing for a workflow no run has ever completed', async () => {
    const { api } = stubApi([{ status: 200, body: { workflow_runs: [] } }]);

    expect(await newestCompletedRun(api, MIRROR_FILE)).toBeNull();
  });

  it('refuses an answer carrying no runs field', async () => {
    const { api } = stubApi([{ status: 200, body: {} }]);

    await expect(newestCompletedRun(api, MIRROR_FILE)).rejects.toThrow(/workflow runs/);
  });
});

describe('runArtifactNames', () => {
  it('answers the names of what one run published', async () => {
    const { api, calls } = stubApi([
      { status: 200, body: { artifacts: [{ name: 'mutation-report' }] } },
    ]);

    expect(await runArtifactNames(api, 12)).toEqual(['mutation-report']);
    expect(calls[0]?.url).toContain(`/repos/${REPOSITORY}/actions/runs/12/artifacts`);
  });

  it('answers an empty listing for a run that published nothing', async () => {
    const { api } = stubApi([{ status: 200, body: { artifacts: [] } }]);

    expect(await runArtifactNames(api, 12)).toEqual([]);
  });

  it('refuses an answer carrying no artifacts field', async () => {
    const { api } = stubApi([{ status: 200, body: {} }]);

    await expect(runArtifactNames(api, 12)).rejects.toThrow(/artifacts/);
  });
});

describe('reconcileIssue', () => {
  it('files the alert when something is wrong and nothing is open', async () => {
    const { api, calls } = stubApi([
      { status: 200, body: [] },
      { status: 201, body: { number: 9 } },
    ]);

    expect(await reconcileIssue(api, ISSUE_TITLE, 'the reason')).toBe('opened');
    expect(calls[1]?.method).toBe('POST');
  });

  it('leaves the standing alert alone rather than filing a second one', async () => {
    const { api, calls } = stubApi([{ status: 200, body: [{ number: 9, title: ISSUE_TITLE }] }]);

    expect(await reconcileIssue(api, ISSUE_TITLE, 'the reason')).toBe('left-open');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('closes the standing alert once nothing is wrong', async () => {
    const { api, calls } = stubApi([
      { status: 200, body: [{ number: 9, title: ISSUE_TITLE }] },
      { status: 200, body: { number: 9 } },
    ]);

    expect(await reconcileIssue(api, ISSUE_TITLE, null)).toBe('closed');
    expect(calls[1]?.method).toBe('PATCH');
  });

  it('does nothing when nothing is wrong and nothing is open', async () => {
    const { api, calls } = stubApi([{ status: 200, body: [] }]);

    expect(await reconcileIssue(api, ISSUE_TITLE, null)).toBe('none');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

const TRUSTED_WORKFLOW_FILE = 'ci.yml';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const BORROWED = ['lint', 'test', 'e2e'] as const;

const succeeded = (name: string): TrustedRunJob => ({
  name,
  status: 'completed',
  conclusion: 'success',
});

/** Every borrowed job green, beside public-only jobs that correctly declined to run. */
const GREEN_JOBS: readonly TrustedRunJob[] = [
  succeeded('lint'),
  succeeded('test'),
  succeeded('e2e (chromium)'),
  succeeded('e2e (webkit)'),
  { name: 'deploy', status: 'completed', conclusion: 'skipped' },
  { name: 'escrow', status: 'completed', conclusion: 'skipped' },
];

const GREEN_RUN: TrustedRun = {
  runHeadSha: SHA,
  status: 'completed',
  conclusion: 'success',
  jobs: GREEN_JOBS,
  totalCount: GREEN_JOBS.length,
};

describe('isBorrowable', () => {
  it('accepts a completed successful run whose every borrowed job succeeded', () => {
    expect(isBorrowable(GREEN_RUN, SHA, BORROWED)).toBe(true);
  });

  it('refuses a commit with no trusted run', () => {
    expect(isBorrowable(null, SHA, BORROWED)).toBe(false);
  });

  it('refuses a run still in progress', () => {
    expect(
      isBorrowable({ ...GREEN_RUN, status: 'in_progress', conclusion: null }, SHA, BORROWED)
    ).toBe(false);
  });

  it('refuses a completed run that did not succeed', () => {
    expect(isBorrowable({ ...GREEN_RUN, conclusion: 'failure' }, SHA, BORROWED)).toBe(false);
  });

  it('refuses a run for another commit than the one asked about', () => {
    expect(isBorrowable({ ...GREEN_RUN, runHeadSha: OTHER_SHA }, SHA, BORROWED)).toBe(false);
  });

  it('refuses a borrowed job that was skipped, since a skip proves nothing', () => {
    const jobs = GREEN_JOBS.map((job) =>
      job.name === 'test' ? { ...job, conclusion: 'skipped' } : job
    );

    expect(isBorrowable({ ...GREEN_RUN, jobs }, SHA, BORROWED)).toBe(false);
  });

  it('refuses a run in which a borrowed job is absent', () => {
    const jobs = GREEN_JOBS.filter((job) => job.name !== 'lint');

    expect(isBorrowable({ ...GREEN_RUN, jobs, totalCount: jobs.length }, SHA, BORROWED)).toBe(
      false
    );
  });

  it('refuses a jobs listing that holds fewer jobs than the run reports', () => {
    expect(isBorrowable({ ...GREEN_RUN, totalCount: GREEN_JOBS.length + 1 }, SHA, BORROWED)).toBe(
      false
    );
  });

  it('refuses a run in which one leg of a matrix job failed', () => {
    const jobs = GREEN_JOBS.map((job) =>
      job.name === 'e2e (webkit)' ? { ...job, conclusion: 'failure' } : job
    );

    expect(isBorrowable({ ...GREEN_RUN, jobs }, SHA, BORROWED)).toBe(false);
  });

  it('does not count a job whose name merely starts with a borrowed key as that key', () => {
    const jobs = [
      ...GREEN_JOBS.filter((job) => !job.name.startsWith('e2e')),
      succeeded('e2e-build'),
    ];

    expect(isBorrowable({ ...GREEN_RUN, jobs, totalCount: jobs.length }, SHA, BORROWED)).toBe(
      false
    );
  });
});

/** One workflow-run entry as the listing reports it. */
function runEntry(
  id: number,
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    run_number: id,
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

const JOBS_BODY = { total_count: GREEN_JOBS.length, jobs: GREEN_JOBS };

describe('readTrustedRun', () => {
  it('asks for push runs of the workflow on main for exactly the commit, a full page at once', async () => {
    const { api, calls } = stubApi([
      { status: 200, body: { workflow_runs: [runEntry(7)] } },
      { status: 200, body: JOBS_BODY },
    ]);

    await readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA);

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe(
      `/repos/${REPOSITORY}/actions/workflows/${TRUSTED_WORKFLOW_FILE}/runs`
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      head_sha: SHA,
      event: 'push',
      branch: 'main',
      per_page: '100',
    });
  });

  it("asks for the latest attempt's jobs of the run it chose, a full page at once", async () => {
    const { api, calls } = stubApi([
      { status: 200, body: { workflow_runs: [runEntry(7)] } },
      { status: 200, body: JOBS_BODY },
    ]);

    await readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA);

    const url = new URL(calls[1]?.url ?? '');
    expect(url.pathname).toBe(`/repos/${REPOSITORY}/actions/runs/7/jobs`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ filter: 'latest', per_page: '100' });
  });

  it('answers the run and its jobs as the API reported them', async () => {
    const { api } = stubApi([
      { status: 200, body: { workflow_runs: [runEntry(7)] } },
      { status: 200, body: JOBS_BODY },
    ]);

    expect(await readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA)).toEqual(GREEN_RUN);
  });

  it('answers nothing for a commit with no trusted run', async () => {
    const { api, calls } = stubApi([{ status: 200, body: { workflow_runs: [] } }]);

    expect(await readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('judges the newest run, so a newer failure is never outweighed by an older success', async () => {
    const { api, calls } = stubApi([
      {
        status: 200,
        body: {
          workflow_runs: [runEntry(7), runEntry(9, { conclusion: 'failure' }), runEntry(8)],
        },
      },
      { status: 200, body: JOBS_BODY },
    ]);

    const run = await readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA);

    expect(calls[1]?.url).toContain('/actions/runs/9/jobs');
    expect(isBorrowable(run, SHA, BORROWED)).toBe(false);
  });

  it('answers the run a running workflow reports, with no conclusion yet', async () => {
    const { api } = stubApi([
      {
        status: 200,
        body: { workflow_runs: [runEntry(7, { status: 'in_progress', conclusion: null })] },
      },
      { status: 200, body: { total_count: 0, jobs: [] } },
    ]);

    expect(await readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA)).toEqual({
      runHeadSha: SHA,
      status: 'in_progress',
      conclusion: null,
      jobs: [],
      totalCount: 0,
    });
  });

  it('reports the status rather than the body when the run listing fails', async () => {
    const { api } = stubApi([{ status: 403, body: { message: TOKEN } }]);

    const failure = readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA);

    await expect(failure).rejects.toThrow(/403/);
    await expect(failure).rejects.not.toThrow(new RegExp(TOKEN));
  });

  it('reports the status when the jobs listing fails', async () => {
    const { api } = stubApi([
      { status: 200, body: { workflow_runs: [runEntry(7)] } },
      { status: 404, body: {} },
    ]);

    await expect(readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA)).rejects.toThrow(/404/);
  });

  it('refuses a run listing carrying no runs field', async () => {
    const { api } = stubApi([{ status: 200, body: {} }]);

    await expect(readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA)).rejects.toThrow(/workflow runs/);
  });

  it.each([
    ['an id', { id: 'seven' }],
    ['a run number', { run_number: null }],
    ['a head commit', { head_sha: 7 }],
    ['a status', { status: undefined }],
    ['a readable conclusion', { conclusion: 7 }],
  ])('refuses a run entry carrying no %s', async (_what, overrides) => {
    const { api } = stubApi([
      { status: 200, body: { workflow_runs: [runEntry(7, overrides)] } },
      { status: 200, body: JOBS_BODY },
    ]);

    await expect(readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA)).rejects.toThrow(TypeError);
  });

  it.each([
    ['no total', { jobs: GREEN_JOBS }],
    ['no jobs field', { total_count: 1 }],
    ['a job with no name', { total_count: 1, jobs: [{ status: 'completed', conclusion: null }] }],
    ['a job with no status', { total_count: 1, jobs: [{ name: 'lint', conclusion: null }] }],
    [
      'a job with an unreadable conclusion',
      { total_count: 1, jobs: [{ name: 'lint', status: 'completed', conclusion: 7 }] },
    ],
  ])('refuses a jobs listing with %s', async (_what, body) => {
    const { api } = stubApi([
      { status: 200, body: { workflow_runs: [runEntry(7)] } },
      { status: 200, body },
    ]);

    await expect(readTrustedRun(api, TRUSTED_WORKFLOW_FILE, SHA)).rejects.toThrow(TypeError);
  });
});

describe('stagingRunReaderToken', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const ENV: NodeJS.ProcessEnv = { [APP_ID_VARIABLE]: '1234', [PRIVATE_KEY_VARIABLE]: privateKey };

  it('mints a token that reaches only the staging repository, with Actions read and nothing else', async () => {
    const { api, calls } = stubApi([
      { status: 200, body: { id: 42 } },
      { status: 201, body: { token: 'scoped' } },
    ]);

    expect(await stagingRunReaderToken('The reader', REPOSITORY, ENV, api.fetchImpl)).toBe(
      'scoped'
    );
    expect(calls[0]?.url).toContain(`/repos/${REPOSITORY}/installation`);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      repositories: ['Example'],
      permissions: { actions: 'read' },
    });
  });

  it('refuses a repository that is not an owner and a name', async () => {
    const { api, calls } = stubApi([]);

    await expect(
      stagingRunReaderToken('The reader', 'Example', ENV, api.fetchImpl)
    ).rejects.toThrow(/owner\/name/);
    expect(calls).toEqual([]);
  });

  it('names the caller when the credentials are missing', async () => {
    const { api } = stubApi([]);

    await expect(
      stagingRunReaderToken('The reader', REPOSITORY, {}, api.fetchImpl)
    ).rejects.toThrow(/The reader/);
  });

  it('fails when the scoped mint is refused', async () => {
    const { api } = stubApi([
      { status: 200, body: { id: 42 } },
      { status: 422, body: {} },
    ]);

    await expect(
      stagingRunReaderToken('The reader', REPOSITORY, ENV, api.fetchImpl)
    ).rejects.toThrow(/422/);
  });
});
