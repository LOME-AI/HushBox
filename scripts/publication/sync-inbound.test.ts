import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { DAY_SECONDS } from '@hushbox/shared/durations';
import { TEST_DAY_START, SECOND_MS } from '@hushbox/shared/test-time';
import { scanTextBlobs } from '../lib/privacy/rules.js';
import { SYNC_BOT_IDENTITY } from '../lib/publication/git.js';
import {
  assertStamped,
  describeInboundOutcome,
  isInboundFailure,
  syncInbound,
  type InboundOutcome,
} from './sync-inbound.js';
import type { NormalizeOutcome } from '../normalize-commit-date.js';

const FIXTURE_DATE = `@${String(TEST_DAY_START / SECOND_MS)} +0000`;
const MAIN = 'main';

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-inbound-'));
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

async function commitFile(
  cwd: string,
  file: string,
  contents: string,
  message: string
): Promise<string> {
  await fs.writeFile(path.join(cwd, file), contents, 'utf8');
  await run(cwd, ['add', '-A']);
  await run(cwd, ['commit', '-m', message]);
  return run(cwd, ['rev-parse', 'HEAD']);
}

const commit = async (cwd: string, marker: string): Promise<string> =>
  commitFile(cwd, `${marker}.txt`, `${marker}\n`, marker);

async function remoteHead(url: string): Promise<string> {
  const { stdout } = await execa('git', ['ls-remote', url, `refs/heads/${MAIN}`]);
  return stdout.split(/\s/)[0] ?? '';
}

/**
 * Staging as a bare remote plus the work tree that seeds it, and a clone of
 * public checked out at the commit the queue merge produced.
 */
interface Topology {
  readonly publicClone: string;
  readonly stagingUrl: string;
  readonly stagingSeed: string;
  readonly base: string;
}

async function createTopology(): Promise<Topology> {
  const bare = path.join(sandbox, 'staging.git');
  await execa('git', ['init', '--bare', '--initial-branch', MAIN, bare]);

  const stagingSeed = path.join(sandbox, 'staging-seed');
  await initWorkRepository(stagingSeed);
  const base = await commit(stagingSeed, 'base');
  await run(stagingSeed, ['push', toPosixPath(bare), `${MAIN}:refs/heads/${MAIN}`]);

  const publicClone = path.join(sandbox, 'public-clone');
  await initWorkRepository(publicClone);
  await run(publicClone, ['fetch', toPosixPath(bare), `refs/heads/${MAIN}`]);
  await run(publicClone, ['checkout', '-B', MAIN, 'FETCH_HEAD']);

  return { publicClone, stagingUrl: toPosixPath(bare), stagingSeed, base };
}

async function pushSeed(topology: Topology): Promise<void> {
  await run(topology.stagingSeed, ['push', topology.stagingUrl, `${MAIN}:refs/heads/${MAIN}`]);
}

interface Stamps {
  readonly authorEpoch: number;
  readonly committerEpoch: number;
  readonly authorOffset: string;
  readonly committerOffset: string;
}

async function stampsOf(url: string, sha: string): Promise<Stamps> {
  const inspect = path.join(sandbox, `inspect-${sha.slice(0, 8)}`);
  await initWorkRepository(inspect);
  await run(inspect, ['fetch', url, sha]);
  const shown = await run(inspect, ['show', '-s', '--format=%at%n%ct%n%aI%n%cI', sha]);
  const [authorEpoch, committerEpoch, authorIso, committerIso] = shown.split('\n');
  return {
    authorEpoch: Number(authorEpoch),
    committerEpoch: Number(committerEpoch),
    authorOffset: (authorIso ?? '').slice(-6),
    committerOffset: (committerIso ?? '').slice(-6),
  };
}

async function syncWith(topology: Topology): Promise<InboundOutcome> {
  return syncInbound({ cwd: topology.publicClone, stagingUrl: topology.stagingUrl });
}

describe('the inbound sync', () => {
  it('does nothing when staging already carries the public commit', async () => {
    const topology = await createTopology();

    expect(await syncWith(topology)).toEqual({
      status: 'already-contained',
      sha: topology.base,
    });
    expect(await remoteHead(topology.stagingUrl)).toBe(topology.base);
  });

  it('fast-forwards staging when it sits exactly where public branched from', async () => {
    const topology = await createTopology();
    const merged = await commit(topology.publicClone, 'queue-merge');

    expect(await syncWith(topology)).toEqual({ status: 'fast-forwarded', sha: merged });
    expect(await remoteHead(topology.stagingUrl)).toBe(merged);
  });

  it('merges into staging when the two have diverged, carrying both histories', async () => {
    const topology = await createTopology();
    const maintainer = await commitFile(
      topology.stagingSeed,
      'staging.txt',
      'work\n',
      'maintainer'
    );
    await pushSeed(topology);
    const merged = await commitFile(topology.publicClone, 'public.txt', 'fix\n', 'queue-merge');

    const outcome = await syncWith(topology);

    expect(outcome).toMatchObject({ status: 'merged' });
    const head = await remoteHead(topology.stagingUrl);
    expect(head).toBe(outcome.status === 'merged' ? outcome.sha : '');

    const inspect = path.join(sandbox, 'inspect-parents');
    await initWorkRepository(inspect);
    await run(inspect, ['fetch', topology.stagingUrl, `refs/heads/${MAIN}`]);
    const parents = await run(inspect, ['rev-list', '--parents', '-n', '1', head]);
    expect(parents.split(' ')).toEqual([head, maintainer, merged]);
  });

  it('stamps the merge it mints at day resolution in UTC', async () => {
    const topology = await createTopology();
    await commitFile(topology.stagingSeed, 'staging.txt', 'work\n', 'maintainer');
    await pushSeed(topology);
    await commitFile(topology.publicClone, 'public.txt', 'fix\n', 'queue-merge');

    const outcome = await syncWith(topology);
    const stamps = await stampsOf(
      topology.stagingUrl,
      outcome.status === 'merged' ? outcome.sha : ''
    );

    expect({
      author: stamps.authorEpoch % DAY_SECONDS,
      committer: stamps.committerEpoch % DAY_SECONDS,
      authorOffset: stamps.authorOffset,
      committerOffset: stamps.committerOffset,
    }).toEqual({ author: 0, committer: 0, authorOffset: '+00:00', committerOffset: '+00:00' });
  });

  it('reports a conflict and leaves staging and the work tree alone', async () => {
    const topology = await createTopology();
    await commitFile(topology.stagingSeed, 'shared.txt', 'staging side\n', 'maintainer');
    await pushSeed(topology);
    const held = await remoteHead(topology.stagingUrl);
    await commitFile(topology.publicClone, 'shared.txt', 'public side\n', 'queue-merge');

    expect(await syncWith(topology)).toEqual({ status: 'conflicted' });
    expect(await remoteHead(topology.stagingUrl)).toBe(held);
    expect(await run(topology.publicClone, ['status', '--porcelain'])).toBe('');
  });

  it('still reads public main on a second run after a conflict abandoned the first', async () => {
    const topology = await createTopology();
    await commitFile(topology.stagingSeed, 'shared.txt', 'staging side\n', 'maintainer');
    await pushSeed(topology);
    const held = await remoteHead(topology.stagingUrl);
    await commitFile(topology.publicClone, 'shared.txt', 'public side\n', 'queue-merge');

    // The first run abandons its merge. The second must resolve public's trunk
    // from the branch, not from wherever the first left this checkout.
    await syncWith(topology);

    expect(await syncWith(topology)).toEqual({ status: 'conflicted' });
    expect(await remoteHead(topology.stagingUrl)).toBe(held);
  });

  it('reports the push being refused rather than reaching for force', async () => {
    // A staging remote with the branch checked out refuses every push to it,
    // which is how a remote that moved underneath this run behaves.
    const staging = path.join(sandbox, 'checked-out-staging');
    await initWorkRepository(staging);
    const held = await commit(staging, 'base');

    const publicClone = path.join(sandbox, 'public-clone');
    await initWorkRepository(publicClone);
    await run(publicClone, ['fetch', toPosixPath(staging), `refs/heads/${MAIN}`]);
    await run(publicClone, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    await commit(publicClone, 'queue-merge');

    expect(await syncInbound({ cwd: publicClone, stagingUrl: toPosixPath(staging) })).toEqual({
      status: 'rejected',
      stagingHead: held,
    });
    expect(await run(staging, ['rev-parse', MAIN])).toBe(held);
  });

  it('carries what public main stands at rather than the branch the run was dispatched from', async () => {
    const topology = await createTopology();
    const merged = await commit(topology.publicClone, 'queue-merge');
    // A dispatch can start this run from any ref, and this one carries work the
    // queue has not landed on public `main`.
    await run(topology.publicClone, ['checkout', '--quiet', '-b', 'dispatch-target']);
    const unmerged = await commit(topology.publicClone, 'unmerged');

    expect(await syncWith(topology)).toEqual({ status: 'fast-forwarded', sha: merged });
    expect({
      head: await remoteHead(topology.stagingUrl),
      sameCommit: unmerged === merged,
    }).toEqual({ head: merged, sameCommit: false });
  });

  it('reports git declining to merge rather than failing on an abort with nothing to abort', async () => {
    // Two repositories with no commit in common: git refuses the merge outright,
    // so no merge is ever in progress for an abort to end.
    const staging = path.join(sandbox, 'unrelated-staging.git');
    await execa('git', ['init', '--bare', '--initial-branch', MAIN, staging]);
    const stagingSeed = path.join(sandbox, 'unrelated-staging-seed');
    await initWorkRepository(stagingSeed);
    const held = await commit(stagingSeed, 'staging-root');
    await run(stagingSeed, ['push', toPosixPath(staging), `${MAIN}:refs/heads/${MAIN}`]);

    const publicClone = path.join(sandbox, 'unrelated-public');
    await initWorkRepository(publicClone);
    await commit(publicClone, 'public-root');

    const outcome = await syncInbound({ cwd: publicClone, stagingUrl: toPosixPath(staging) });

    expect(outcome).toMatchObject({ status: 'declined' });
    expect(outcome.status === 'declined' ? outcome.reason : '').toMatch(/unrelated histories/);
    expect(await remoteHead(toPosixPath(staging))).toBe(held);
  });
});

describe('the day-resolution guard on a minted merge', () => {
  it('accepts a commit the rewrite stamped', () => {
    expect(() => {
      assertStamped({ status: 'normalized', sha: 'a'.repeat(40), previousSha: 'b'.repeat(40) });
    }).not.toThrow();
  });

  it('accepts a commit that already read at day resolution', () => {
    expect(() => {
      assertStamped({ status: 'conforming' });
    }).not.toThrow();
  });

  it('stops the sync on every outcome that leaves the stamp unchanged', () => {
    const untouched: NormalizeOutcome[] = [
      { status: 'no-commit' },
      { status: 'published' },
      { status: 'refused', reason: 'non-ssh-signature', detail: 'openpgp' },
    ];

    for (const outcome of untouched) {
      expect(() => {
        assertStamped(outcome);
      }).toThrow(/day resolution/);
    }
  });
});

describe('the inbound sync report', () => {
  const outcomes: InboundOutcome[] = [
    { status: 'already-contained', sha: 'a'.repeat(40) },
    { status: 'fast-forwarded', sha: 'b'.repeat(40) },
    { status: 'merged', sha: 'c'.repeat(40) },
    { status: 'conflicted' },
    { status: 'declined', reason: 'fatal: refusing to merge unrelated histories' },
    { status: 'rejected', stagingHead: 'd'.repeat(40) },
  ];

  it('describes every outcome it can reach', () => {
    for (const outcome of outcomes) {
      expect(describeInboundOutcome(outcome).length).toBeGreaterThan(0);
    }
  });

  it('treats every outcome that needs a human as a failure and the rest as ordinary', () => {
    expect(outcomes.map((outcome) => isInboundFailure(outcome))).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it('discloses no timing in anything it prints', () => {
    const findings = outcomes.flatMap((outcome) =>
      scanTextBlobs(
        [
          {
            path: 'publication/inbound-report.txt',
            bytes: new TextEncoder().encode(describeInboundOutcome(outcome)),
          },
        ],
        []
      )
    );

    expect(findings).toEqual([]);
  });
});
