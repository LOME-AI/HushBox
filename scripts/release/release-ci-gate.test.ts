import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { main } from './release-ci-gate.js';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const REPOSITORY = 'owner/repo';
const API_URL = 'https://api.example.invalid';

const ENV: NodeJS.ProcessEnv = {
  GITHUB_API_URL: API_URL,
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_TOKEN: 'token-value',
  RELEASE_COMMIT: COMMIT,
  RELEASE_TAG: 'v1.2.3',
};

interface RunFixture {
  readonly run_number: number;
  readonly head_sha: string;
  readonly event: string;
  readonly head_branch: string;
  readonly status: string;
  readonly conclusion: string | null;
}

const GREEN_PUSH_RUN: RunFixture = {
  run_number: 7,
  head_sha: COMMIT,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
};

const runsAnswer = (runs: readonly RunFixture[]): Response =>
  Response.json({ total_count: runs.length, workflow_runs: runs });

/** A fetch that answers every request with `answer` and records what was asked. */
function fixtureFetch(answer: () => Response): { fetchImpl: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(answer());
  };
  return { fetchImpl, requests };
}

const gate = (runs: readonly RunFixture[]): Promise<number> =>
  main(ENV, fixtureFetch(() => runsAnswer(runs)).fetchImpl);

let stdoutSpy: MockInstance<typeof process.stdout.write>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
});

describe('the release CI gate', () => {
  it('passes a commit whose push-event run on main succeeded', async () => {
    expect(await gate([GREEN_PUSH_RUN])).toBe(0);
  });

  it('refuses a commit whose only run was dispatched', async () => {
    expect(await gate([{ ...GREEN_PUSH_RUN, event: 'workflow_dispatch' }])).toBe(1);
  });

  it('refuses a commit whose run was on a branch other than main', async () => {
    expect(await gate([{ ...GREEN_PUSH_RUN, head_branch: 'feature' }])).toBe(1);
  });

  it('refuses a commit whose run failed', async () => {
    expect(await gate([{ ...GREEN_PUSH_RUN, conclusion: 'failure' }])).toBe(1);
  });

  it('refuses a commit whose run has not completed', async () => {
    expect(await gate([{ ...GREEN_PUSH_RUN, status: 'in_progress', conclusion: null }])).toBe(1);
  });

  it('refuses when the only green run is of a different commit', async () => {
    expect(await gate([{ ...GREEN_PUSH_RUN, head_sha: OTHER_COMMIT }])).toBe(1);
  });

  it('refuses when the API lists no run at all', async () => {
    expect(await gate([])).toBe(1);
  });

  it('judges the newest push run on main, not an older green one', async () => {
    expect(
      await gate([GREEN_PUSH_RUN, { ...GREEN_PUSH_RUN, run_number: 8, conclusion: 'failure' }])
    ).toBe(1);
  });

  it('refuses through an error when the API answers with a failure status', async () => {
    const { fetchImpl } = fixtureFetch(() => new Response('', { status: 500 }));

    await expect(main(ENV, fetchImpl)).rejects.toThrow(/status 500/);
  });

  it('refuses through an error when the API answers with no run listing', async () => {
    const { fetchImpl } = fixtureFetch(() => Response.json({ message: 'unexpected' }));

    await expect(main(ENV, fetchImpl)).rejects.toThrow(/no workflow runs/);
  });

  it('refuses through an error when a listed run cannot be described', async () => {
    const { fetchImpl } = fixtureFetch(() =>
      Response.json({ workflow_runs: [{ ...GREEN_PUSH_RUN, conclusion: 7 }] })
    );

    await expect(main(ENV, fetchImpl)).rejects.toThrow(/could not describe/);
  });

  it('refuses through an error when a listed run is not an object', async () => {
    const { fetchImpl } = fixtureFetch(() => Response.json({ workflow_runs: [null] }));

    await expect(main(ENV, fetchImpl)).rejects.toThrow(/could not describe/);
  });

  it("asks for the commit's push runs of ci.yml on main", async () => {
    const { fetchImpl, requests } = fixtureFetch(() => runsAnswer([GREEN_PUSH_RUN]));

    await main(ENV, fetchImpl);

    const url = new URL(requests[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(
      `${API_URL}/repos/${REPOSITORY}/actions/workflows/ci.yml/runs`
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      head_sha: COMMIT,
      event: 'push',
      branch: 'main',
      per_page: '100',
    });
  });

  it('reads the runs under the workflow token', async () => {
    const { fetchImpl, requests } = fixtureFetch(() => runsAnswer([GREEN_PUSH_RUN]));

    await main(ENV, fetchImpl);

    expect(requests[0]?.headers.get('authorization')).toBe('Bearer token-value');
  });

  it.each(['GITHUB_API_URL', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'RELEASE_COMMIT', 'RELEASE_TAG'])(
    'refuses to judge without %s',
    async (name) => {
      const { fetchImpl } = fixtureFetch(() => runsAnswer([GREEN_PUSH_RUN]));

      await expect(main({ ...ENV, [name]: '' }, fetchImpl)).rejects.toThrow(`${name} is required`);
    }
  );

  it('names the tag and commit it refused', async () => {
    await gate([]);

    expect(stdoutSpy.mock.calls.join('')).toContain(`::error::v1.2.3 points at ${COMMIT}`);
  });
});
