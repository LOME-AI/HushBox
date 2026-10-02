import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { TEST_DAY_START, SECOND_MS } from '@hushbox/shared/test-time';
import { scanTextBlobs } from '../lib/privacy/rules.js';
import { SYNC_BOT_IDENTITY } from '../lib/publication/git.js';
import { BORROWED_JOBS, TRUSTED_WORKFLOW_FILE } from '../lib/publication/borrowed-jobs.js';
import { APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE } from '../lib/publication/sync-bot-credential.js';
import {
  describePublication,
  dispatchFor,
  main,
  publicationChecks,
  publishRequest,
  publishStagingTip,
  runCheckProcess,
  type PublicationCheck,
  type PublicationOutcome,
  type PublishRequest,
} from './publish-staging-tip.js';
import type { RepositoryApi, TrustedRunJob } from '../lib/publication/api.js';

const FIXTURE_DATE = `@${String(TEST_DAY_START / SECOND_MS)} +0000`;
const MAIN = 'main';
const STAGING_REPOSITORY = 'Example-Org/Example-staging';
const PUBLIC_REPOSITORY = 'Example-Org/Example';
const TOKEN = 'read-token';
const GITLEAKS_BIN = path.join('cache', 'gitleaks', 'gitleaks');

/** One `ci.yml` push run on a commit, as staging's Actions API would report it. */
interface RunFixture {
  readonly status: string;
  readonly conclusion: string | null;
  readonly jobs: readonly TrustedRunJob[];
}

const jobsConcluding = (conclusion: string): TrustedRunJob[] =>
  BORROWED_JOBS.map((name) => ({ name, status: 'completed', conclusion }));

const PUSH_GREEN: RunFixture = {
  status: 'completed',
  conclusion: 'success',
  jobs: jobsConcluding('success'),
};
const PUSH_RED: RunFixture = {
  status: 'completed',
  conclusion: 'failure',
  jobs: [
    ...jobsConcluding('success').slice(1),
    { name: 'lint', status: 'completed', conclusion: 'failure' },
  ],
};

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-staging-tip-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(sandbox, { recursive: true, force: true });
});

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa('git', [...args], {
    cwd,
    env: {
      GIT_AUTHOR_DATE: FIXTURE_DATE,
      GIT_COMMITTER_DATE: FIXTURE_DATE,
      GIT_AUTHOR_NAME: SYNC_BOT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: SYNC_BOT_IDENTITY.email,
      GIT_COMMITTER_NAME: SYNC_BOT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: SYNC_BOT_IDENTITY.email,
    },
  });
  return stdout.trim();
}

async function initWorkRepository(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await run(directory, ['init', '--initial-branch', MAIN]);
  await run(directory, ['config', 'user.name', SYNC_BOT_IDENTITY.name]);
  await run(directory, ['config', 'user.email', SYNC_BOT_IDENTITY.email]);
}

async function commit(cwd: string, marker: string): Promise<string> {
  await fs.writeFile(path.join(cwd, `${marker}.txt`), `${marker}\n`, 'utf8');
  await run(cwd, ['add', '-A']);
  await run(cwd, ['commit', '-m', marker]);
  return run(cwd, ['rev-parse', 'HEAD']);
}

async function remoteHead(url: string): Promise<string> {
  const { stdout } = await execa('git', ['ls-remote', url, `refs/heads/${MAIN}`]);
  return stdout.split(/\s/)[0] ?? '';
}

/**
 * The bare repository standing in for public, a staging work repository, and
 * the clone of public the publisher runs in — all seeded from one commit, so
 * the publisher starts from the aligned state.
 */
interface Topology {
  readonly checkout: string;
  readonly staging: string;
  readonly publicUrl: string;
  readonly stagingUrl: string;
  readonly base: string;
}

async function createTopology(): Promise<Topology> {
  const bare = path.join(sandbox, 'public.git');
  await execa('git', ['init', '--bare', '--initial-branch', MAIN, bare]);

  const staging = path.join(sandbox, 'staging');
  await initWorkRepository(staging);
  const base = await commit(staging, 'base');
  await run(staging, ['push', toPosixPath(bare), `${MAIN}:refs/heads/${MAIN}`]);

  const checkout = path.join(sandbox, 'checkout');
  await execa('git', ['clone', '--quiet', toPosixPath(bare), checkout]);

  return {
    checkout,
    staging,
    publicUrl: toPosixPath(bare),
    stagingUrl: toPosixPath(staging),
    base,
  };
}

/** Lands a commit on public that staging never saw, and answers it. */
async function divergePublic(topology: Topology, marker: string): Promise<string> {
  const other = path.join(sandbox, marker);
  await initWorkRepository(other);
  await run(other, ['fetch', topology.publicUrl, `refs/heads/${MAIN}`]);
  await run(other, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
  const diverged = await commit(other, marker);
  await run(other, ['push', topology.publicUrl, `${MAIN}:refs/heads/${MAIN}`]);
  return diverged;
}

/**
 * Staging's Actions API over one push run per commit. `status` refuses every
 * read with that status instead.
 */
function stagingRuns(
  runs: Readonly<Record<string, RunFixture>>,
  status?: number
): { fetchImpl: typeof fetch; reads: string[] } {
  const reads: string[] = [];
  const listed = Object.entries(runs).map(([sha, fixture], index) => ({
    sha,
    fixture,
    id: index + 1,
  }));
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    reads.push(url);
    if (status !== undefined) return Promise.resolve(Response.json({}, { status }));
    const { pathname, searchParams } = new URL(url);
    const jobList = /\/actions\/runs\/(\d+)\/jobs$/.exec(pathname);
    if (jobList !== null) {
      const jobs = listed.find(({ id }) => id === Number(jobList[1]))?.fixture.jobs ?? [];
      return Promise.resolve(Response.json({ total_count: jobs.length, jobs }));
    }
    const matching = listed.filter(({ sha }) => sha === searchParams.get('head_sha'));
    return Promise.resolve(
      Response.json({
        total_count: matching.length,
        workflow_runs: matching.map(({ id, sha, fixture }) => ({
          id,
          run_number: id,
          head_sha: sha,
          status: fixture.status,
          conclusion: fixture.conclusion,
        })),
      })
    );
  };
  return { fetchImpl, reads };
}

function stagingApiOver(fetchImpl: typeof fetch): () => Promise<RepositoryApi> {
  return () => Promise.resolve({ fetchImpl, token: TOKEN, repository: STAGING_REPOSITORY });
}

function requestFor(
  topology: Topology,
  overrides: Partial<Pick<PublishRequest, 'runCheck' | 'stagingApi'>> = {}
): PublishRequest {
  return {
    cwd: topology.checkout,
    publicUrl: topology.publicUrl,
    stagingUrl: topology.stagingUrl,
    ensureGitleaks: () => Promise.resolve(GITLEAKS_BIN),
    runCheck: () => Promise.resolve(0),
    stagingApi: stagingApiOver(stagingRuns({}).fetchImpl),
    ...overrides,
  };
}

/** A check runner that records every check and fails the one named, if any. */
function recordingRunner(failing?: string): {
  runCheck: (check: PublicationCheck) => Promise<number>;
  ran: PublicationCheck[];
} {
  const ran: PublicationCheck[] = [];
  return {
    ran,
    runCheck: (check) => {
      ran.push(check);
      return Promise.resolve(check.name === failing ? 1 : 0);
    },
  };
}

const CHECK_NAMES = [
  'gitleaks range scan',
  'gitleaks tree scan',
  'privacy sweep',
  'commit-date check',
] as const;

describe('the staging tip publisher', () => {
  it("fast-forwards public main to staging's tip once every check passes", async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');

    const outcome = await publishStagingTip(requestFor(topology));

    expect(outcome).toMatchObject({ status: 'published', sha: tip });
    expect(await remoteHead(topology.publicUrl)).toBe(tip);
  });

  it('runs the four checks in order over the published range and tip', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const { runCheck, ran } = recordingRunner();

    await publishStagingTip(requestFor(topology, { runCheck }));

    expect(ran).toEqual(publicationChecks(GITLEAKS_BIN, topology.base, tip));
  });

  it.each(CHECK_NAMES)('leaves public main where it was when the %s fails', async (failing) => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const { runCheck } = recordingRunner(failing);

    const outcome = await publishStagingTip(requestFor(topology, { runCheck }));

    expect(outcome).toEqual({ status: 'check-failed', check: failing, exitCode: 1, tip });
    expect(await remoteHead(topology.publicUrl)).toBe(topology.base);
  });

  it.each(CHECK_NAMES)('runs no check after the %s fails', async (failing) => {
    const topology = await createTopology();
    await commit(topology.staging, 'work');
    const { runCheck, ran } = recordingRunner(failing);

    await publishStagingTip(requestFor(topology, { runCheck }));

    expect(ran.map((check) => check.name)).toEqual(
      CHECK_NAMES.slice(0, CHECK_NAMES.indexOf(failing) + 1)
    );
  });

  it('publishes nothing and runs no check when public already stands at the tip', async () => {
    const topology = await createTopology();
    const { runCheck, ran } = recordingRunner();

    const outcome = await publishStagingTip(requestFor(topology, { runCheck }));

    expect(outcome).toEqual({ status: 'nothing-to-publish', sha: topology.base });
    expect(ran).toEqual([]);
  });

  it("refuses without checking or pushing when staging's tip does not descend from public main", async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'staging-only');
    const diverged = await divergePublic(topology, 'public-only');
    const { runCheck, ran } = recordingRunner();

    const outcome = await publishStagingTip(requestFor(topology, { runCheck }));

    expect(outcome).toEqual({ status: 'diverged', publicHead: diverged, tip });
    expect(ran).toEqual([]);
    expect(await remoteHead(topology.publicUrl)).toBe(diverged);
  });

  it('refuses when public main moves between the fetch and the push', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    let moved = '';
    const runCheck = async (check: PublicationCheck): Promise<number> => {
      if (check.name === 'commit-date check') moved = await divergePublic(topology, 'racing');
      return 0;
    };

    const outcome = await publishStagingTip(requestFor(topology, { runCheck }));

    expect(outcome).toEqual({ status: 'refused', publicHead: moved, tip });
    expect(await remoteHead(topology.publicUrl)).toBe(moved);
  });

  it('reads the proof when public main reached the tip by another path during the run', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const runCheck = async (): Promise<number> => {
      await run(topology.staging, ['push', topology.publicUrl, `${MAIN}:refs/heads/${MAIN}`]);
      return 0;
    };
    const { fetchImpl } = stagingRuns({ [tip]: PUSH_GREEN });

    const outcome = await publishStagingTip(
      requestFor(topology, { runCheck, stagingApi: stagingApiOver(fetchImpl) })
    );

    expect(outcome).toEqual({ status: 'published', sha: tip, proof: { status: 'borrowable' } });
  });

  it("publishes staging's main rather than the branch its clone has checked out", async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    await run(topology.staging, ['checkout', '--quiet', '-b', 'unmerged-work']);
    await commit(topology.staging, 'unmerged');

    await publishStagingTip(requestFor(topology));

    expect(await remoteHead(topology.publicUrl)).toBe(tip);
  });

  it('answers a tip whose trusted push run proved it as borrowable', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const { fetchImpl } = stagingRuns({ [tip]: PUSH_GREEN });

    const outcome = await publishStagingTip(
      requestFor(topology, { stagingApi: stagingApiOver(fetchImpl) })
    );

    expect(outcome).toEqual({ status: 'published', sha: tip, proof: { status: 'borrowable' } });
  });

  it('answers a tip whose trusted push run failed as unproven', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const { fetchImpl } = stagingRuns({ [tip]: PUSH_RED });

    const outcome = await publishStagingTip(
      requestFor(topology, { stagingApi: stagingApiOver(fetchImpl) })
    );

    expect(outcome).toEqual({ status: 'published', sha: tip, proof: { status: 'unproven' } });
  });

  it('answers a tip staging has no push run for as unproven', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');

    const outcome = await publishStagingTip(requestFor(topology));

    expect(outcome).toEqual({ status: 'published', sha: tip, proof: { status: 'unproven' } });
  });

  it('answers a refused run read as unreadable, carrying the failure', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const { fetchImpl } = stagingRuns({ [tip]: PUSH_GREEN }, 403);

    const outcome = await publishStagingTip(
      requestFor(topology, { stagingApi: stagingApiOver(fetchImpl) })
    );

    expect(outcome).toEqual({
      status: 'published',
      sha: tip,
      proof: { status: 'unreadable', reason: 'the trusted-run read failed with status 403.' },
    });
  });

  it('answers a refused read-credential mint as unreadable, carrying the failure', async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const stagingApi = (): Promise<RepositoryApi> =>
      Promise.reject(new Error('the token mint failed with status 422.'));

    const outcome = await publishStagingTip(requestFor(topology, { stagingApi }));

    expect(outcome).toEqual({
      status: 'published',
      sha: tip,
      proof: { status: 'unreadable', reason: 'the token mint failed with status 422.' },
    });
  });

  it("reads staging's trusted push run of the CI workflow for the tip", async () => {
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const { fetchImpl, reads } = stagingRuns({ [tip]: PUSH_GREEN });

    await publishStagingTip(requestFor(topology, { stagingApi: stagingApiOver(fetchImpl) }));

    expect(reads[0]).toContain(
      `/repos/${STAGING_REPOSITORY}/actions/workflows/${TRUSTED_WORKFLOW_FILE}/runs?head_sha=${tip}`
    );
  });

  it('keeps the token out of the failure when a remote cannot be reached', async () => {
    const topology = await createTopology();
    const unreachable = 'https://x-access-token:secret-token@localhost:1/absent.git';

    const failure = publishStagingTip({
      ...requestFor(topology),
      stagingUrl: unreachable,
    });

    await expect(failure).rejects.toThrow(/git fetch failed/);
    await expect(failure).rejects.not.toThrow(/secret-token/);
  });
});

describe('the publication checks', () => {
  it('scans the published range, then the tip tree, then sweeps the tip, then checks the range dates', () => {
    expect(publicationChecks(GITLEAKS_BIN, 'publicsha', 'tipsha')).toEqual([
      {
        name: 'gitleaks range scan',
        command: GITLEAKS_BIN,
        args: [
          'git',
          '--redact',
          '--no-banner',
          '--log-opts=publicsha..tipsha --diff-merges=first-parent',
        ],
        env: {},
      },
      {
        name: 'gitleaks tree scan',
        command: 'pnpm',
        args: ['gitleaks:scan', '--revision', 'tipsha'],
        env: {},
      },
      { name: 'privacy sweep', command: 'pnpm', args: ['privacy:sweep', 'tipsha'], env: {} },
      {
        name: 'commit-date check',
        command: 'pnpm',
        args: ['tsx', 'scripts/verify-commit-dates.ts'],
        env: { COMMIT_DATE_BASE: 'publicsha', COMMIT_DATE_HEAD: 'tipsha' },
      },
    ]);
  });

  it("answers the check process's exit code under the check's environment", async () => {
    const check: PublicationCheck = {
      name: 'probe',
      command: process.execPath,
      args: ['-e', 'process.exit(Number(process.env.PROBE_EXIT))'],
      env: { PROBE_EXIT: '3' },
    };

    expect(await runCheckProcess(check, sandbox)).toBe(3);
  });

  it('answers a failure for a check process killed without an exit code', async () => {
    const check: PublicationCheck = {
      name: 'probe',
      command: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGKILL")'],
      env: {},
    };

    expect(await runCheckProcess(check, sandbox)).toBe(1);
  });
});

describe('the staging tip publisher credentials', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const ENV: NodeJS.ProcessEnv = { [APP_ID_VARIABLE]: '1234', [PRIVATE_KEY_VARIABLE]: privateKey };
  const REPOSITORIES = {
    publicRepo: PUBLIC_REPOSITORY,
    stagingRepo: STAGING_REPOSITORY,
    recordsRepo: 'Example-Org/Example-records',
  };

  /** The app's mint: a scoped request is answered with the read token, an unscoped one with the push token. */
  function appMint(lookups: string[] = []): typeof fetch {
    return (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/installation')) {
        lookups.push(url);
        return Promise.resolve(Response.json({ id: 42 }));
      }
      return Promise.resolve(
        Response.json(
          { token: typeof init?.body === 'string' ? 'read-token' : 'push-token' },
          { status: 201 }
        )
      );
    };
  }

  it('mints the push credential from the installation on the public repository', async () => {
    const lookups: string[] = [];

    await publishRequest(sandbox, REPOSITORIES, ENV, appMint(lookups));

    expect(lookups).toEqual([`https://api.github.com/repos/${PUBLIC_REPOSITORY}/installation`]);
  });

  it('reaches public main under the unscoped token', async () => {
    const request = await publishRequest(sandbox, REPOSITORIES, ENV, appMint());

    expect(request.publicUrl).toBe(
      `https://x-access-token:push-token@github.com/${PUBLIC_REPOSITORY}.git`
    );
  });

  it('reaches staging main under the unscoped token', async () => {
    const request = await publishRequest(sandbox, REPOSITORIES, ENV, appMint());

    expect(request.stagingUrl).toBe(
      `https://x-access-token:push-token@github.com/${STAGING_REPOSITORY}.git`
    );
  });

  it("reads staging's runs under the token scoped to Actions read on staging", async () => {
    const request = await publishRequest(sandbox, REPOSITORIES, ENV, appMint());

    expect(await request.stagingApi()).toMatchObject({
      token: 'read-token',
      repository: STAGING_REPOSITORY,
    });
  });

  it('runs each check as a process in the clone', async () => {
    const request = await publishRequest(sandbox, REPOSITORIES, ENV, appMint());

    const exitCode = await request.runCheck({
      name: 'probe',
      command: process.execPath,
      args: ['-e', 'process.exit(process.cwd() === process.env.EXPECTED_CWD ? 0 : 5)'],
      env: { EXPECTED_CWD: await fs.realpath(sandbox) },
    });

    expect(exitCode).toBe(0);
  });
});

describe('the staging tip publisher report', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const outcomes: PublicationOutcome[] = [
    { status: 'nothing-to-publish', sha: SHA },
    { status: 'diverged', publicHead: OTHER, tip: SHA },
    { status: 'check-failed', check: 'privacy sweep', exitCode: 1, tip: SHA },
    { status: 'refused', publicHead: OTHER, tip: SHA },
    { status: 'published', sha: SHA, proof: { status: 'borrowable' } },
    { status: 'published', sha: SHA, proof: { status: 'unproven' } },
    {
      status: 'published',
      sha: SHA,
      proof: { status: 'unreadable', reason: 'the trusted-run read failed with status 403.' },
    },
  ];

  it('dispatches a bypass run for every outcome but the proven publication, and none for a failure', () => {
    expect(outcomes.map((outcome) => dispatchFor(outcome))).toEqual([
      true,
      null,
      null,
      null,
      false,
      true,
      true,
    ]);
  });

  it('says there is nothing to publish when public stands at the tip', () => {
    expect(describePublication({ status: 'nothing-to-publish', sha: SHA }).join('\n')).toMatch(
      /nothing to publish/
    );
  });

  it('tells the reader to run the inbound sync on a non-fast-forward', () => {
    const text = describePublication({ status: 'diverged', publicHead: OTHER, tip: SHA }).join(
      '\n'
    );

    expect(text).toMatch(/inbound sync/);
  });

  it('names the check that failed', () => {
    const text = describePublication({
      status: 'check-failed',
      check: 'privacy sweep',
      exitCode: 1,
      tip: SHA,
    }).join('\n');

    expect(text).toMatch(/privacy sweep/);
  });

  it('names the head public main moved to when the push is refused', () => {
    const text = describePublication({ status: 'refused', publicHead: OTHER, tip: SHA }).join('\n');

    expect(text).toContain(OTHER);
  });

  it('prints the published sha whatever the proof', () => {
    for (const outcome of outcomes.filter((entry) => entry.status === 'published')) {
      expect(describePublication(outcome).join('\n')).toContain(SHA);
    }
  });

  it("says the push run deploys the tip with staging's proof when the tip is borrowable", () => {
    const text = describePublication({
      status: 'published',
      sha: SHA,
      proof: { status: 'borrowable' },
    }).join('\n');

    expect(text).toMatch(/push run .* deploy/);
  });

  it('prints the failure when the proof could not be read', () => {
    const text = describePublication({
      status: 'published',
      sha: SHA,
      proof: { status: 'unreadable', reason: 'the trusted-run read failed with status 403.' },
    }).join('\n');

    expect(text).toContain('the trusted-run read failed with status 403.');
  });

  it('discloses no timing in anything it prints', () => {
    const findings = outcomes.flatMap((outcome) =>
      scanTextBlobs(
        [
          {
            path: 'publication/staging-tip-report.txt',
            bytes: new TextEncoder().encode(describePublication(outcome).join('\n')),
          },
        ],
        []
      )
    );

    expect(findings).toEqual([]);
  });
});

describe('the staging tip publisher entry point', () => {
  function silenceConsole(): void {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  }

  it.each([
    ['unset', {}],
    ['empty', { GITHUB_OUTPUT: '' }],
  ])('refuses, naming GITHUB_OUTPUT, before publishing when it is %s', async (_label, env) => {
    const topology = await createTopology();
    await commit(topology.staging, 'work');
    const build = vi.fn(() => Promise.resolve(requestFor(topology)));

    await expect(main(env, build)).rejects.toThrow(/GITHUB_OUTPUT/);
    expect(build).not.toHaveBeenCalled();
    expect(await remoteHead(topology.publicUrl)).toBe(topology.base);
  });

  it('writes the dispatch output and exits 0 after publishing', async () => {
    silenceConsole();
    const topology = await createTopology();
    const tip = await commit(topology.staging, 'work');
    const { fetchImpl } = stagingRuns({ [tip]: PUSH_GREEN });
    const outputFile = path.join(sandbox, 'output');

    const exitCode = await main({ GITHUB_OUTPUT: outputFile }, () =>
      Promise.resolve(requestFor(topology, { stagingApi: stagingApiOver(fetchImpl) }))
    );

    expect(exitCode).toBe(0);
    expect(await fs.readFile(outputFile, 'utf8')).toBe('dispatch=false\n');
  });

  it('writes dispatch=true when there is nothing to publish', async () => {
    silenceConsole();
    const topology = await createTopology();
    const outputFile = path.join(sandbox, 'output');

    await main({ GITHUB_OUTPUT: outputFile }, () => Promise.resolve(requestFor(topology)));

    expect(await fs.readFile(outputFile, 'utf8')).toBe('dispatch=true\n');
  });

  it('exits 1 and writes no output when a check fails', async () => {
    silenceConsole();
    const topology = await createTopology();
    await commit(topology.staging, 'work');
    const outputFile = path.join(sandbox, 'output');
    const { runCheck } = recordingRunner('gitleaks range scan');

    const exitCode = await main({ GITHUB_OUTPUT: outputFile }, () =>
      Promise.resolve(requestFor(topology, { runCheck }))
    );

    expect(exitCode).toBe(1);
    await expect(fs.access(outputFile)).rejects.toThrow();
    expect(await remoteHead(topology.publicUrl)).toBe(topology.base);
  });
});
