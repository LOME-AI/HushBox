import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  MIRROR_SCAN_DEPTH,
  describeMirrorOutcome,
  isMirrorRefusal,
  mirror,
  mirrorRequest,
  type MirrorOutcome,
} from './publish-mirror.js';
import type { TrustedRunJob } from '../lib/publication/api.js';

const FIXTURE_DATE = `@${String(TEST_DAY_START / SECOND_MS)} +0000`;
const MAIN = 'main';
const STAGING_REPOSITORY = 'Example-Org/Example-staging';
const PUBLIC_REPOSITORY = 'Example-Org/Example';
const TOKEN = 'installation-token';

/** One `ci.yml` run on a commit, as staging's Actions API would report it. */
interface RunFixture {
  readonly event: 'push' | 'pull_request';
  readonly status: string;
  readonly conclusion: string | null;
  readonly jobs: readonly TrustedRunJob[];
}

const jobsConcluding = (conclusion: string): TrustedRunJob[] =>
  BORROWED_JOBS.map((name) => ({
    name: name === 'e2e' ? 'e2e (chromium)' : name,
    status: 'completed',
    conclusion,
  }));

const PUSH_GREEN: RunFixture = {
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  jobs: [
    ...jobsConcluding('success'),
    { name: 'deploy', status: 'completed', conclusion: 'skipped' },
  ],
};
const PUSH_RED: RunFixture = {
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  jobs: [
    ...jobsConcluding('success').slice(1),
    { name: 'lint', status: 'completed', conclusion: 'failure' },
  ],
};
const PUSH_RUNNING: RunFixture = {
  event: 'push',
  status: 'in_progress',
  conclusion: null,
  jobs: BORROWED_JOBS.map((name) => ({ name, status: 'in_progress', conclusion: null })),
};
/** A pull-request run, whose event gate skips the build, E2E and mobile jobs. */
const PULL_REQUEST_GREEN: RunFixture = {
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  jobs: BORROWED_JOBS.map((name) => ({
    name,
    status: 'completed',
    conclusion: ['e2e-build', 'e2e', 'mobile-test'].includes(name) ? 'skipped' : 'success',
  })),
};

const GREEN: readonly RunFixture[] = [PUSH_GREEN];
const RED: readonly RunFixture[] = [PUSH_RED];
const RUNNING: readonly RunFixture[] = [PUSH_RUNNING];

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-mirror-'));
});

afterEach(async () => {
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
 * A staging clone and the bare repository standing in for public, both seeded
 * from one commit so the mirror starts from the aligned state.
 */
interface Topology {
  readonly staging: string;
  readonly publicUrl: string;
  readonly base: string;
}

async function createTopology(): Promise<Topology> {
  const bare = path.join(sandbox, 'public.git');
  await execa('git', ['init', '--bare', '--initial-branch', MAIN, bare]);

  const staging = path.join(sandbox, 'staging');
  await initWorkRepository(staging);
  const base = await commit(staging, 'base');
  await run(staging, ['push', toPosixPath(bare), `${MAIN}:refs/heads/${MAIN}`]);

  return { staging, publicUrl: toPosixPath(bare), base };
}

interface ListedRun {
  readonly id: number;
  readonly sha: string;
  readonly run: RunFixture;
}

/** The run listing, honouring its `head_sha`, `event` and `branch` filters; newest first. */
function answerRuns(listed: readonly ListedRun[], query: URLSearchParams): Response {
  const event = query.get('event');
  const branch = query.get('branch');
  const matching = listed
    .filter(({ sha }) => sha === query.get('head_sha'))
    .filter(({ run }) => event === null || run.event === event)
    .filter(({ run }) => branch === null || (run.event === 'push' ? MAIN : 'feature') === branch)
    .toReversed();
  return Response.json({
    total_count: matching.length,
    workflow_runs: matching.map(({ id, sha, run }) => ({
      id,
      run_number: id,
      head_sha: sha,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
    })),
  });
}

/** The commit check-run listing: every run's jobs, a newer run's shadowing an older one's of the same name. */
function answerCheckRuns(listed: readonly ListedRun[], sha: string): Response {
  const latest = new Map<string, TrustedRunJob>();
  for (const { run } of listed.filter((entry) => entry.sha === sha)) {
    for (const job of run.jobs) latest.set(job.name, job);
  }
  return Response.json({ check_runs: [...latest.values()] });
}

/**
 * Staging's Actions API over a fixture of runs per commit, oldest first. It
 * also answers the commit check-run listing, so a mirror that judged
 * publication by check runs is caught publishing what the trusted run did not
 * prove rather than failing on an unanswered read.
 */
function stagingApi(
  runs: Readonly<Record<string, readonly RunFixture[]>>,
  refuse: { readonly jobsStatus?: number } = {}
): { fetchImpl: typeof fetch; reads: string[] } {
  const reads: string[] = [];
  const listed = Object.entries(runs)
    .flatMap(([sha, fixtures]) => fixtures.map((run) => ({ sha, run })))
    .map((entry, index) => ({ ...entry, id: index + 1 }));
  const fetchImpl = ((url: string) => {
    reads.push(url);
    const { pathname, searchParams } = new URL(url);
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(pathname)) {
      return Promise.resolve(answerRuns(listed, searchParams));
    }
    const jobList = /\/actions\/runs\/(\d+)\/jobs$/.exec(pathname);
    if (jobList !== null) {
      const jobs = listed.find(({ id }) => id === Number(jobList[1]))?.run.jobs ?? [];
      return Promise.resolve(
        refuse.jobsStatus === undefined
          ? Response.json({ total_count: jobs.length, jobs })
          : Response.json({}, { status: refuse.jobsStatus })
      );
    }
    const checkList = /\/commits\/([0-9a-f]+)\/check-runs$/.exec(pathname);
    return Promise.resolve(
      checkList === null
        ? Response.json({}, { status: 404 })
        : answerCheckRuns(listed, checkList[1] ?? '')
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, reads };
}

async function mirrorWith(
  topology: Topology,
  runs: Readonly<Record<string, readonly RunFixture[]>>
): Promise<MirrorOutcome> {
  return mirror({
    cwd: topology.staging,
    publicUrl: topology.publicUrl,
    staging: {
      fetchImpl: stagingApi(runs).fetchImpl,
      token: TOKEN,
      repository: STAGING_REPOSITORY,
    },
  });
}

describe('the outbound mirror', () => {
  it('publishes the staging head when its suite is green', async () => {
    const topology = await createTopology();
    const head = await commit(topology.staging, 'work');

    expect(await mirrorWith(topology, { [head]: GREEN })).toEqual({
      status: 'published',
      sha: head,
    });
    expect(await remoteHead(topology.publicUrl)).toBe(head);
  });

  it('publishes the newest green commit rather than a red head, leaving the red one behind', async () => {
    const topology = await createTopology();
    const green = await commit(topology.staging, 'green');
    const red = await commit(topology.staging, 'red');

    expect(await mirrorWith(topology, { [green]: GREEN, [red]: RED })).toEqual({
      status: 'published',
      sha: green,
    });
    expect(await remoteHead(topology.publicUrl)).toBe(green);
  });

  it('waits rather than publishing a head whose suite has not finished', async () => {
    const topology = await createTopology();
    const green = await commit(topology.staging, 'green');
    const pending = await commit(topology.staging, 'pending');

    expect(await mirrorWith(topology, { [green]: GREEN, [pending]: RUNNING })).toEqual({
      status: 'published',
      sha: green,
    });
  });

  it('publishes nothing when no commit within the scanned depth is green', async () => {
    const topology = await createTopology();
    const head = await commit(topology.staging, 'red');
    const held = await remoteHead(topology.publicUrl);

    expect(await mirrorWith(topology, { [head]: RED })).toEqual({ status: 'nothing-green' });
    expect(await remoteHead(topology.publicUrl)).toBe(held);
  });

  it('reads a public repository already carrying the target as current', async () => {
    const topology = await createTopology();

    expect(await mirrorWith(topology, { [topology.base]: GREEN })).toEqual({
      status: 'already-current',
      sha: topology.base,
    });
  });

  it('refuses a divergence instead of forcing, and leaves public exactly where it stood', async () => {
    const topology = await createTopology();
    const target = await commit(topology.staging, 'staging-only');

    // Public gains a commit staging never saw: the state an inbound sync that
    // failed to land leaves behind.
    const other = path.join(sandbox, 'other');
    await initWorkRepository(other);
    await run(other, ['fetch', topology.publicUrl, `refs/heads/${MAIN}`]);
    await run(other, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const diverged = await commit(other, 'public-only');
    await run(other, ['push', topology.publicUrl, `${MAIN}:refs/heads/${MAIN}`]);

    expect(await mirrorWith(topology, { [target]: GREEN })).toEqual({
      status: 'refused',
      publicHead: diverged,
      target,
    });
    expect(await remoteHead(topology.publicUrl)).toBe(diverged);
  });

  it('publishes nothing rather than refusing while public stands at a head whose suite is still running', async () => {
    const topology = await createTopology();
    const green = await commit(topology.staging, 'green');
    const queueMerge = await commit(topology.staging, 'queue-merge');
    // The queue's merge landed on public first and the inbound sync carried it
    // back, so both repositories stand on it while its suite is still running.
    await run(topology.staging, ['push', topology.publicUrl, `${MAIN}:refs/heads/${MAIN}`]);

    expect(await mirrorWith(topology, { [green]: GREEN, [queueMerge]: RUNNING })).toEqual({
      status: 'nothing-green',
    });
    expect(await remoteHead(topology.publicUrl)).toBe(queueMerge);
  });

  it('publishes nothing rather than refusing while the merge carrying public back is not green', async () => {
    const topology = await createTopology();
    const maintainer = await commit(topology.staging, 'maintainer');

    const other = path.join(sandbox, 'other');
    await initWorkRepository(other);
    await run(other, ['fetch', topology.publicUrl, `refs/heads/${MAIN}`]);
    await run(other, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const contributor = await commit(other, 'contributor');
    await run(other, ['push', topology.publicUrl, `${MAIN}:refs/heads/${MAIN}`]);

    // The inbound sync's merge of the two sides, suite not concluded: the state
    // staging is in after every contributor merge until its suite goes green.
    await run(topology.staging, ['fetch', topology.publicUrl, `refs/heads/${MAIN}`]);
    await run(topology.staging, [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      'merge public',
      'FETCH_HEAD',
    ]);
    const inbound = await run(topology.staging, ['rev-parse', 'HEAD']);

    expect(
      await mirrorWith(topology, {
        [maintainer]: GREEN,
        [contributor]: GREEN,
        [inbound]: RUNNING,
      })
    ).toEqual({ status: 'nothing-green' });
    expect(await remoteHead(topology.publicUrl)).toBe(contributor);
  });

  it('publishes what the trunk stands at rather than the branch the run was dispatched from', async () => {
    const topology = await createTopology();
    await run(topology.staging, ['checkout', '--quiet', '-b', 'unmerged-work']);
    const unmerged = await commit(topology.staging, 'unmerged');

    expect(await mirrorWith(topology, { [topology.base]: GREEN, [unmerged]: GREEN })).toEqual({
      status: 'already-current',
      sha: topology.base,
    });
    expect(await remoteHead(topology.publicUrl)).toBe(topology.base);
  });

  it('never publishes the merged-in side of a merge, a state the trunk never stood at', async () => {
    const topology = await createTopology();
    await run(topology.staging, ['checkout', '--quiet', '-b', 'side']);
    const side = await commit(topology.staging, 'side');
    await run(topology.staging, ['checkout', '--quiet', MAIN]);
    await run(topology.staging, ['merge', '--no-ff', '--no-edit', '-m', 'merge side', side]);
    const merged = await run(topology.staging, ['rev-parse', 'HEAD']);

    // The side commit is the only green one, and it is reachable from the trunk
    // — so nothing but the mainline restriction keeps it off public.
    expect(await mirrorWith(topology, { [side]: GREEN, [merged]: RED })).toEqual({
      status: 'nothing-green',
    });
    expect(await remoteHead(topology.publicUrl)).toBe(topology.base);
  });

  it('refuses when the remote rejects a push its ancestry check had admitted', async () => {
    // A non-bare public with the branch checked out refuses every push to it,
    // which is the only way to reach the rejection behind a passing ancestry
    // check: public moving between the two reads.
    const publicRepository = path.join(sandbox, 'checked-out-public');
    await initWorkRepository(publicRepository);
    const held = await commit(publicRepository, 'base');

    const staging = path.join(sandbox, 'staging');
    await initWorkRepository(staging);
    await run(staging, ['fetch', toPosixPath(publicRepository), `refs/heads/${MAIN}`]);
    await run(staging, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const target = await commit(staging, 'work');

    expect(
      await mirror({
        cwd: staging,
        publicUrl: toPosixPath(publicRepository),
        staging: {
          fetchImpl: stagingApi({ [target]: GREEN }).fetchImpl,
          token: TOKEN,
          repository: STAGING_REPOSITORY,
        },
      })
    ).toEqual({ status: 'refused', publicHead: held, target });
    expect(await run(publicRepository, ['rev-parse', MAIN])).toBe(held);
  });

  it('scans no further back than its stated depth', async () => {
    const topology = await createTopology();
    const suites: Record<string, readonly RunFixture[]> = { [topology.base]: GREEN };
    for (let index = 0; index <= MIRROR_SCAN_DEPTH; index += 1) {
      suites[await commit(topology.staging, `red-${String(index)}`)] = RED;
    }

    expect(await mirrorWith(topology, suites)).toEqual({ status: 'nothing-green' });
  });

  it('publishes an older commit its trusted push run proved over a newer one only a pull-request run passed', async () => {
    const topology = await createTopology();
    const proven = await commit(topology.staging, 'proven');
    const unproven = await commit(topology.staging, 'pull-request-only');

    expect(
      await mirrorWith(topology, { [proven]: GREEN, [unproven]: [PULL_REQUEST_GREEN] })
    ).toEqual({ status: 'published', sha: proven });
    expect(await remoteHead(topology.publicUrl)).toBe(proven);
  });

  it('does not publish a commit whose push run is still in progress', async () => {
    const topology = await createTopology();
    const proven = await commit(topology.staging, 'proven');
    const pending = await commit(topology.staging, 'pending');
    // The push run has started but created no jobs yet, while a pull-request
    // run on the same commit has already finished green.
    const started: RunFixture = { ...PUSH_RUNNING, jobs: [] };

    expect(
      await mirrorWith(topology, { [proven]: GREEN, [pending]: [PULL_REQUEST_GREEN, started] })
    ).toEqual({ status: 'published', sha: proven });
  });

  it('does not publish a commit whose newest push run failed although an older one succeeded', async () => {
    const topology = await createTopology();
    const proven = await commit(topology.staging, 'proven');
    const rerun = await commit(topology.staging, 'rerun');
    // The newer run failed before creating any job, so nothing it reported
    // shadows the older run's green jobs.
    const failedAtStart: RunFixture = { ...PUSH_RED, jobs: [] };

    expect(
      await mirrorWith(topology, { [proven]: GREEN, [rerun]: [PUSH_GREEN, failedAtStart] })
    ).toEqual({ status: 'published', sha: proven });
  });

  it("fails loudly rather than publishing nothing when staging's jobs listing is refused", async () => {
    const topology = await createTopology();
    const head = await commit(topology.staging, 'work');
    const held = await remoteHead(topology.publicUrl);

    await expect(
      mirror({
        cwd: topology.staging,
        publicUrl: topology.publicUrl,
        staging: {
          fetchImpl: stagingApi({ [head]: GREEN }, { jobsStatus: 403 }).fetchImpl,
          token: TOKEN,
          repository: STAGING_REPOSITORY,
        },
      })
    ).rejects.toThrow(/403/);
    expect(await remoteHead(topology.publicUrl)).toBe(held);
  });

  it("reads staging's trusted push run of the CI workflow for each candidate", async () => {
    const topology = await createTopology();
    const head = await commit(topology.staging, 'work');
    const { fetchImpl, reads } = stagingApi({ [head]: GREEN });

    await mirror({
      cwd: topology.staging,
      publicUrl: topology.publicUrl,
      staging: { fetchImpl, token: TOKEN, repository: STAGING_REPOSITORY },
    });

    expect(reads[0]).toContain(
      `/repos/${STAGING_REPOSITORY}/actions/workflows/${TRUSTED_WORKFLOW_FILE}/runs?head_sha=${head}`
    );
  });
});

describe('the outbound mirror credentials', () => {
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
  function appMint(refuseScoped = false): typeof fetch {
    return ((url: string, init?: RequestInit) => {
      if (url.endsWith('/installation')) return Promise.resolve(Response.json({ id: 42 }));
      if (typeof init?.body === 'string') {
        return Promise.resolve(
          refuseScoped
            ? Response.json({}, { status: 422 })
            : Response.json({ token: 'read-token' }, { status: 201 })
        );
      }
      return Promise.resolve(Response.json({ token: 'push-token' }, { status: 201 }));
    }) as unknown as typeof fetch;
  }

  it("reads staging's runs under the token scoped to Actions read on staging", async () => {
    const request = await mirrorRequest(sandbox, REPOSITORIES, ENV, appMint());

    expect(request.staging).toMatchObject({ token: 'read-token', repository: STAGING_REPOSITORY });
  });

  it('fetches and pushes public main under the unscoped token, never the scoped one', async () => {
    const request = await mirrorRequest(sandbox, REPOSITORIES, ENV, appMint());

    expect(request.publicUrl).toBe(
      `https://x-access-token:push-token@github.com/${PUBLIC_REPOSITORY}.git`
    );
  });

  it('fails loudly when the scoped mint is refused', async () => {
    await expect(mirrorRequest(sandbox, REPOSITORIES, ENV, appMint(true))).rejects.toThrow(/422/);
  });
});

describe('the outbound mirror report', () => {
  const outcomes: MirrorOutcome[] = [
    { status: 'published', sha: 'a'.repeat(40) },
    { status: 'already-current', sha: 'b'.repeat(40) },
    { status: 'nothing-green' },
    { status: 'refused', publicHead: 'c'.repeat(40), target: 'd'.repeat(40) },
  ];

  it('describes every outcome it can reach', () => {
    for (const outcome of outcomes) {
      expect(describeMirrorOutcome(outcome).length).toBeGreaterThan(0);
    }
  });

  it('treats only the refusal as a failure the run must report', () => {
    expect(outcomes.map((outcome) => isMirrorRefusal(outcome))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('discloses no timing in anything it prints', () => {
    const findings = outcomes.flatMap((outcome) =>
      scanTextBlobs(
        [
          {
            path: 'publication/mirror-report.txt',
            bytes: new TextEncoder().encode(describeMirrorOutcome(outcome)),
          },
        ],
        []
      )
    );

    expect(findings).toEqual([]);
  });
});
