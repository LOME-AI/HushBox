import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { TEST_DAY_START, SECOND_MS, HOUR_MS } from '@hushbox/shared/test-time';
import { scanTextBlobs } from '../lib/privacy/rules.js';
import { SYNC_BOT_IDENTITY } from '../lib/publication/git.js';
import {
  MIRROR_CRON,
  MIRROR_FRESHNESS_HOURS,
  MIRROR_PERIOD_HOURS,
  MIRROR_WORKFLOW_FILE,
  STALL_ISSUE_TITLE,
  audit,
  describeFindings,
  type AuditFinding,
} from './sync-auditor.js';

const FIXTURE_DATE = `@${String(TEST_DAY_START / SECOND_MS)} +0000`;
const MAIN = 'main';
const STAGING_REPOSITORY = 'Example-Org/Example-staging';
const TOKEN = 'installation-token';

/** A mirror run that finished right at the edge of the freshness window. */
const AT_THE_WINDOW = TEST_DAY_START - MIRROR_FRESHNESS_HOURS * HOUR_MS;

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-auditor-'));
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

interface Topology {
  readonly staging: string;
  readonly publicUrl: string;
}

/** Staging and public aligned: public `main` is exactly staging's head. */
async function createAlignedTopology(): Promise<Topology> {
  const bare = path.join(sandbox, 'public.git');
  await execa('git', ['init', '--bare', '--initial-branch', MAIN, bare]);

  const staging = path.join(sandbox, 'staging');
  await initWorkRepository(staging);
  await commit(staging, 'base');
  await run(staging, ['push', toPosixPath(bare), `${MAIN}:refs/heads/${MAIN}`]);

  return { staging, publicUrl: toPosixPath(bare) };
}

/** Puts a commit on public that staging never saw, breaking the ancestry invariant. */
async function divergePublic(topology: Topology): Promise<void> {
  const other = path.join(sandbox, 'other');
  await initWorkRepository(other);
  await run(other, ['fetch', topology.publicUrl, `refs/heads/${MAIN}`]);
  await run(other, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
  await commit(other, 'public-only');
  await run(other, ['push', topology.publicUrl, `${MAIN}:refs/heads/${MAIN}`]);
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

interface Api {
  readonly fetchImpl: typeof fetch;
  readonly calls: Call[];
}

/**
 * The three endpoints the auditor touches: when the mirror last succeeded,
 * which issues are open, and the two writes.
 */
function stubApi(options: {
  readonly lastRunMillis: number | null;
  readonly openIssues?: readonly { number: number; title: string }[];
}): Api {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.includes('/actions/workflows/')) {
      const runs =
        options.lastRunMillis === null
          ? []
          : [{ updated_at: new Date(options.lastRunMillis).toISOString() }];
      return Promise.resolve(Response.json({ workflow_runs: runs }, { status: 200 }));
    }
    if (url.includes('/issues?')) {
      return Promise.resolve(Response.json(options.openIssues ?? [], { status: 200 }));
    }
    return Promise.resolve(Response.json({ number: 1 }, { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function auditWith(
  topology: Topology,
  api: Api,
  nowMillis = TEST_DAY_START
): Promise<Awaited<ReturnType<typeof audit>>> {
  return audit({
    cwd: topology.staging,
    publicUrl: topology.publicUrl,
    staging: { fetchImpl: api.fetchImpl, token: TOKEN, repository: STAGING_REPOSITORY },
    nowMillis,
  });
}

async function findingsOf(topology: Topology, api: Api): Promise<AuditFinding[]> {
  const result = await auditWith(topology, api);
  return result.findings;
}

async function issueOf(topology: Topology, api: Api): Promise<string> {
  const result = await auditWith(topology, api);
  return result.issue;
}

describe('the ancestry auditor', () => {
  it('finds nothing when public descends from staging and the mirror ran inside the window', async () => {
    const topology = await createAlignedTopology();
    const api = stubApi({ lastRunMillis: TEST_DAY_START - HOUR_MS });

    expect(await auditWith(topology, api)).toEqual({ findings: [], issue: 'none' });
  });

  it('finds a broken invariant when public carries a commit staging does not', async () => {
    const topology = await createAlignedTopology();
    await divergePublic(topology);
    const api = stubApi({ lastRunMillis: TEST_DAY_START - HOUR_MS });

    expect(await findingsOf(topology, api)).toEqual<AuditFinding[]>(['ancestry']);
  });

  it('reads the trunk rather than the checkout, so a dispatch from elsewhere cannot close a genuine stall', async () => {
    const topology = await createAlignedTopology();
    await divergePublic(topology);
    // The run was dispatched from a branch built on public's head, so the
    // checkout descends from public while the trunk still does not.
    await run(topology.staging, ['fetch', topology.publicUrl, `refs/heads/${MAIN}`]);
    await run(topology.staging, ['checkout', '--quiet', '-B', 'dispatch-target', 'FETCH_HEAD']);
    const api = stubApi({
      lastRunMillis: TEST_DAY_START,
      openIssues: [{ number: 4, title: STALL_ISSUE_TITLE }],
    });

    expect(await auditWith(topology, api)).toEqual({ findings: ['ancestry'], issue: 'left-open' });
    expect(api.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
  });

  it('reads a mirror run exactly at the window as still fresh', async () => {
    const topology = await createAlignedTopology();
    const api = stubApi({ lastRunMillis: AT_THE_WINDOW });

    expect(await findingsOf(topology, api)).toEqual([]);
  });

  it('reads a mirror run one instant past the window as stale', async () => {
    const topology = await createAlignedTopology();
    const api = stubApi({ lastRunMillis: AT_THE_WINDOW - 1 });

    expect(await findingsOf(topology, api)).toEqual<AuditFinding[]>(['freshness']);
  });

  it('reads a mirror that has never succeeded as stale', async () => {
    const topology = await createAlignedTopology();
    const api = stubApi({ lastRunMillis: null });

    expect(await findingsOf(topology, api)).toEqual<AuditFinding[]>(['freshness']);
  });

  it('reports both failures together rather than stopping at the first', async () => {
    const topology = await createAlignedTopology();
    await divergePublic(topology);
    const api = stubApi({ lastRunMillis: null });

    expect(await findingsOf(topology, api)).toEqual<AuditFinding[]>(['ancestry', 'freshness']);
  });

  it('asks about the mirror workflow by the name the workflow file carries', async () => {
    const topology = await createAlignedTopology();
    const api = stubApi({ lastRunMillis: TEST_DAY_START });

    await auditWith(topology, api);

    expect(api.calls[0]?.url).toContain(`/actions/workflows/${MIRROR_WORKFLOW_FILE}/runs`);
  });
});

describe('the auditor alert', () => {
  it('opens an issue on the staging repository when something is wrong', async () => {
    const topology = await createAlignedTopology();
    await divergePublic(topology);
    const api = stubApi({ lastRunMillis: TEST_DAY_START });

    expect(await issueOf(topology, api)).toBe('opened');
    const filed = api.calls.find((call) => call.method === 'POST');
    expect(JSON.parse(filed?.body ?? '{}')).toMatchObject({ title: STALL_ISSUE_TITLE });
  });

  it('leaves an already-open issue alone rather than filing one every pass', async () => {
    const topology = await createAlignedTopology();
    await divergePublic(topology);
    const api = stubApi({
      lastRunMillis: TEST_DAY_START,
      openIssues: [{ number: 4, title: STALL_ISSUE_TITLE }],
    });

    expect(await issueOf(topology, api)).toBe('left-open');
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('closes the open issue once the topology is healthy again', async () => {
    const topology = await createAlignedTopology();
    const api = stubApi({
      lastRunMillis: TEST_DAY_START,
      openIssues: [{ number: 4, title: STALL_ISSUE_TITLE }],
    });

    expect(await issueOf(topology, api)).toBe('closed');
    const closed = api.calls.find((call) => call.method === 'PATCH');
    expect(closed?.url).toContain('/issues/4');
  });
});

describe('the auditor report', () => {
  const sets: AuditFinding[][] = [[], ['ancestry'], ['freshness'], ['ancestry', 'freshness']];

  it('describes every finding set it can reach', () => {
    for (const findings of sets) {
      expect(describeFindings(findings).length).toBeGreaterThan(0);
    }
  });

  it('discloses no timing in anything it writes', () => {
    const findings = sets.flatMap((set) =>
      scanTextBlobs(
        [
          {
            path: 'publication/auditor-report.txt',
            bytes: new TextEncoder().encode(describeFindings(set)),
          },
        ],
        []
      )
    );

    expect(findings).toEqual([]);
  });
});

/**
 * How often each schedule string this repository has translated actually fires.
 * A schedule absent from the table reads as `undefined` and fails the
 * assertion below, which is the point: the freshness window is sound only for a
 * period someone worked out from the schedule the mirror really carries.
 */
const PERIOD_HOURS_BY_CRON: Readonly<Record<string, number>> = { '0 0 * * *': 24 };

describe('the freshness window', () => {
  it('is the mirror schedule the workflow actually carries, plus a margin', () => {
    const workflows = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '.github',
      'workflows'
    );
    const mirror = parse(readFileSync(path.join(workflows, MIRROR_WORKFLOW_FILE), 'utf8')) as {
      on: { schedule: { cron: string }[] };
    };

    expect(mirror.on.schedule.map((entry) => entry.cron)).toEqual([MIRROR_CRON]);
    expect(PERIOD_HOURS_BY_CRON[MIRROR_CRON]).toBe(MIRROR_PERIOD_HOURS);
    // A window no wider than the period calls every ordinary run stale.
    expect(MIRROR_FRESHNESS_HOURS).toBeGreaterThan(MIRROR_PERIOD_HOURS);
  });
});
