import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideBorrow, main, type BorrowContext } from './green-borrow.js';
import { BORROWED_JOBS } from '../lib/publication/borrowed-jobs.js';
import { APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE } from '../lib/publication/sync-bot-credential.js';

const SHA = 'a'.repeat(40);
const STAGING = 'Example-Org/Example-Staging';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CREDENTIALS: NodeJS.ProcessEnv = {
  [APP_ID_VARIABLE]: '1234',
  [PRIVATE_KEY_VARIABLE]: privateKey,
};

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** What each endpoint the borrow reads answers; a route left out answers 500. */
interface Staging {
  readonly installation?: Answer;
  readonly mint?: Answer;
  readonly runs?: Answer;
  readonly jobs?: Answer;
}

const ok = (body: unknown): Answer => ({ status: 200, body });

const successfulJobs = BORROWED_JOBS.map((name) => ({
  name,
  status: 'completed',
  conclusion: 'success',
}));

/** Staging as it stands when its trusted push run proved {@link SHA}. */
const PROVEN: Staging = {
  installation: ok({ id: 42 }),
  mint: { status: 201, body: { token: 'scoped' } },
  runs: ok({
    workflow_runs: [
      { id: 7, run_number: 3, head_sha: SHA, status: 'completed', conclusion: 'success' },
    ],
  }),
  jobs: ok({ total_count: successfulJobs.length, jobs: successfulJobs }),
};

function routeOf(staging: Staging, url: string): Answer | undefined {
  if (url.endsWith('/installation')) return staging.installation;
  if (url.includes('/access_tokens')) return staging.mint;
  if (url.includes('/jobs?')) return staging.jobs;
  if (url.includes('/runs?')) return staging.runs;
  return undefined;
}

/** A fetch answering each staging endpoint by route, recording the URLs it was asked for. */
function stagingApi(staging: Staging): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    urls.push(url);
    const given = routeOf(staging, url) ?? { status: 500, body: {} };
    return Promise.resolve(Response.json(given.body, { status: given.status }));
  };
  return { fetchImpl, urls };
}

const context = (staging: Staging, env: NodeJS.ProcessEnv = CREDENTIALS): BorrowContext => ({
  sha: SHA,
  stagingRepository: STAGING,
  env,
  fetchImpl: stagingApi(staging).fetchImpl,
});

describe('decideBorrow', () => {
  it("borrows when staging's trusted push run proved the exact commit", async () => {
    const decision = await decideBorrow(context(PROVEN));

    expect(decision.borrowed).toBe(true);
  });

  it("reads staging's push runs of the trusted workflow for the exact commit", async () => {
    const { fetchImpl, urls } = stagingApi(PROVEN);

    await decideBorrow({ ...context(PROVEN), fetchImpl });

    expect(urls).toContainEqual(
      expect.stringContaining(`/repos/${STAGING}/actions/workflows/ci.yml/runs?head_sha=${SHA}`)
    );
  });

  it('does not borrow for a commit staging has no push run for', async () => {
    const decision = await decideBorrow(context({ ...PROVEN, runs: ok({ workflow_runs: [] }) }));

    expect(decision).toEqual({
      borrowed: false,
      defect: false,
      reason: expect.stringContaining('no push run'),
    });
  });

  it('does not borrow for a commit whose trusted run did not prove it', async () => {
    const failed = successfulJobs.map((job) =>
      job.name === 'e2e' ? { ...job, conclusion: 'failure' } : job
    );

    const decision = await decideBorrow(
      context({ ...PROVEN, jobs: ok({ total_count: failed.length, jobs: failed }) })
    );

    expect(decision).toEqual({
      borrowed: false,
      defect: false,
      reason: expect.stringContaining('did not prove'),
    });
  });

  it.each<[string, Staging]>([
    ['the installation lookup is refused', { ...PROVEN, installation: { status: 404, body: {} } }],
    ['the scoped mint is refused', { ...PROVEN, mint: { status: 422, body: {} } }],
    ['the run listing is refused', { ...PROVEN, runs: { status: 403, body: {} } }],
    ['the jobs listing is refused', { ...PROVEN, jobs: { status: 403, body: {} } }],
    ['the run listing is malformed', { ...PROVEN, runs: ok({ runs: [] }) }],
    ['the jobs listing is malformed', { ...PROVEN, jobs: ok({ total_count: 1 }) }],
  ])('does not borrow, naming why, when %s', async (_, staging) => {
    const decision = await decideBorrow(context(staging));

    expect(decision).toEqual({
      borrowed: false,
      defect: false,
      reason: expect.stringContaining('could not be read'),
    });
  });

  it('does not borrow when the staging repository is not an owner and a name', async () => {
    const decision = await decideBorrow({ ...context(PROVEN), stagingRepository: 'Example' });

    expect(decision).toEqual({
      borrowed: false,
      defect: false,
      reason: expect.stringContaining('owner/name'),
    });
  });

  it('reads a missing credential as a configuration defect, and does not borrow', async () => {
    const decision = await decideBorrow(context(PROVEN, {}));

    expect(decision).toEqual({
      borrowed: false,
      defect: true,
      reason: expect.stringContaining("sync bot's credentials"),
    });
  });

  it('reads a missing commit as a configuration defect, and does not borrow', async () => {
    const decision = await decideBorrow({ ...context(PROVEN), sha: undefined });

    expect(decision).toEqual({
      borrowed: false,
      defect: true,
      reason: expect.stringContaining('GITHUB_SHA'),
    });
  });

  it('reads nothing from staging when the credentials are missing', async () => {
    const { fetchImpl, urls } = stagingApi(PROVEN);

    await decideBorrow({ ...context(PROVEN, {}), fetchImpl });

    expect(urls).toEqual([]);
  });
});

describe('main', () => {
  let directory: string;
  let outputFile: string;
  let summaryFile: string;
  let printed: string[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'green-borrow-'));
    outputFile = path.join(directory, 'output');
    summaryFile = path.join(directory, 'summary');
    vi.stubEnv('GITHUB_OUTPUT', outputFile);
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes exactly borrowed=true for a proven commit', async () => {
    await main(context(PROVEN));

    expect(readFileSync(outputFile, 'utf8')).toBe('borrowed=true\n');
  });

  it('writes exactly borrowed=false for a commit it could not establish', async () => {
    await main(context({ ...PROVEN, jobs: { status: 403, body: {} } }));

    expect(readFileSync(outputFile, 'utf8')).toBe('borrowed=false\n');
  });

  it('writes exactly borrowed=false when the credentials are missing', async () => {
    await main(context(PROVEN, {}));

    expect(readFileSync(outputFile, 'utf8')).toBe('borrowed=false\n');
  });

  it('puts the reason in the step summary', async () => {
    await main(context({ ...PROVEN, runs: ok({ workflow_runs: [] }) }));

    expect(readFileSync(summaryFile, 'utf8')).toContain('no push run');
  });

  it('puts the reason in the log', async () => {
    await main(context({ ...PROVEN, runs: ok({ workflow_runs: [] }) }));

    expect(printed.join('')).toContain('no push run');
  });

  it('raises an error annotation when the credentials are missing', async () => {
    await main(context(PROVEN, {}));

    expect(printed.join('')).toMatch(/^::error::.*sync bot's credentials/m);
  });

  it('raises no error annotation when staging simply could not be read', async () => {
    await main(context({ ...PROVEN, jobs: { status: 403, body: {} } }));

    expect(printed.join('')).not.toContain('::error::');
  });
});
