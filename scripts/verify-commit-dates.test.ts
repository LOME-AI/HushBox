import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TEST_DAY_START, HOUR_MS, SECOND_MS } from '@hushbox/shared/test-time';

import { SYNC_BOT_IDENTITY } from './lib/publication/git.js';
import {
  BASE_VARIABLE,
  HEAD_VARIABLE,
  revisionsFromEnvironment,
  runCommitDateCheck,
} from './verify-commit-dates.js';

const ABSENT = '0000000000000000000000000000000000000000';

describe('revisionsFromEnvironment', () => {
  it('spans the commits between what the event started from and what it carries', () => {
    expect(
      revisionsFromEnvironment({ [BASE_VARIABLE]: 'aaa1111', [HEAD_VARIABLE]: 'bbb2222' })
    ).toEqual(['aaa1111..bbb2222']);
  });

  it('refuses when the event named no starting point, rather than judging history', () => {
    expect(() => revisionsFromEnvironment({ [HEAD_VARIABLE]: 'bbb2222' })).toThrow(BASE_VARIABLE);
  });

  it('refuses when the event named nothing to judge', () => {
    expect(() => revisionsFromEnvironment({ [BASE_VARIABLE]: 'aaa1111' })).toThrow(HEAD_VARIABLE);
  });

  it('refuses the absent object a branch creation reports, which would name all of history', () => {
    expect(() =>
      revisionsFromEnvironment({ [BASE_VARIABLE]: ABSENT, [HEAD_VARIABLE]: 'bbb2222' })
    ).toThrow(/no starting commit/);
  });
});

/**
 * A real repository, because the check reads stamps git wrote rather than a
 * string a fixture chose. Three commits, each minted at a named instant:
 * `base` and `conforming` sit on UTC day boundaries, and `finer` sits at an
 * hour within `conforming`'s own day — which is the only property separating
 * the two of them.
 */
describe('the check over a range a real repository carries', () => {
  let repository = '';
  let base = '';
  let conforming = '';
  let head = '';

  const stampOf = (instantMs: number): string => `${String(instantMs / SECOND_MS)} +0000`;

  async function git(args: readonly string[], stamp?: string): Promise<string> {
    const { stdout } = await execa('git', ['-C', repository, ...args], {
      env:
        stamp === undefined ? {} : { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp, TZ: 'UTC' },
    });
    return stdout.trim();
  }

  async function commit(name: string, instantMs: number): Promise<string> {
    await fs.writeFile(path.join(repository, name), name, 'utf8');
    await git(['add', name]);
    await git(['commit', '-m', name], stampOf(instantMs));
    return git(['rev-parse', 'HEAD']);
  }

  beforeAll(async () => {
    repository = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-dates-'));
    await git(['init', '--initial-branch=main', '.']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@hushbox.ai']);
    base = await commit('base', TEST_DAY_START);
    conforming = await commit('conforming', TEST_DAY_START + 24 * HOUR_MS);
    head = await commit('finer', TEST_DAY_START + 24 * HOUR_MS + 14 * HOUR_MS);
  });

  afterAll(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  it('passes a range whose every commit sits on a day boundary', async () => {
    const outcome = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: base,
      [HEAD_VARIABLE]: conforming,
    });

    expect(outcome.code).toBe(0);
  });

  it('refuses a range carrying a commit stamped finer than a day', async () => {
    const outcome = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: base,
      [HEAD_VARIABLE]: head,
    });

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(head.slice(0, 12));
    expect(outcome.report).toContain('finer than a UTC day');
  });

  it('never reaches behind the starting point the event named', async () => {
    const outcome = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: head,
      [HEAD_VARIABLE]: head,
    });

    expect(outcome).toEqual({ report: expect.stringContaining('day resolution'), code: 0 });
  });
});

/**
 * The contributor merge, driven along both routes it takes to a trunk. The
 * queue mints one commit under the forge's own identity and stamps it with the
 * platform's clock; the sync bot then carries that commit onto staging, by
 * fast-forward when staging has nothing of its own and by a merge when it has.
 * The walked range differs between the two routes and again between the two
 * trunks, which is exactly why the disposition of such a commit cannot be
 * keyed to the event that surfaced it.
 */
describe('the routes a queue-minted commit takes to a trunk', () => {
  let repository = '';
  let trunkBefore = '';
  let queueMinted = '';
  let maintainerCommit = '';
  let synced = '';
  let bypassed = '';
  let impersonating = '';

  const FORGE_IDENTITY = { name: 'GitHub', email: 'noreply@github.com' } as const;
  const MAINTAINER_IDENTITY = { name: 'Maintainer', email: 'maintainer@hushbox.ai' } as const;
  const PLATFORM_CLOCK = TEST_DAY_START + 24 * HOUR_MS + 9 * HOUR_MS;

  const stampOf = (instantMs: number): string => `${String(instantMs / SECOND_MS)} +0000`;

  async function git(
    args: readonly string[],
    minting?: { instantMs: number; identity?: { name: string; email: string } | undefined }
  ): Promise<string> {
    const identity = minting?.identity;
    const stamp = minting === undefined ? undefined : stampOf(minting.instantMs);
    const { stdout } = await execa('git', ['-C', repository, ...args], {
      env: {
        TZ: 'UTC',
        ...(stamp === undefined ? {} : { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }),
        ...(identity === undefined
          ? {}
          : {
              GIT_AUTHOR_NAME: identity.name,
              GIT_AUTHOR_EMAIL: identity.email,
              GIT_COMMITTER_NAME: identity.name,
              GIT_COMMITTER_EMAIL: identity.email,
            }),
      },
    });
    return stdout.trim();
  }

  async function commit(
    name: string,
    instantMs: number,
    identity?: { name: string; email: string }
  ): Promise<string> {
    await fs.writeFile(path.join(repository, name), name, 'utf8');
    await git(['add', name]);
    await git(['commit', '-m', name], { instantMs, identity });
    return git(['rev-parse', 'HEAD']);
  }

  beforeAll(async () => {
    repository = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-routes-'));
    await git(['init', '--initial-branch=main', '.']);
    await git(['config', 'user.name', MAINTAINER_IDENTITY.name]);
    await git(['config', 'user.email', MAINTAINER_IDENTITY.email]);
    trunkBefore = await commit('trunk', TEST_DAY_START);

    await git(['checkout', '--quiet', '-b', 'public', trunkBefore]);
    queueMinted = await commit('squashed-contribution', PLATFORM_CLOCK, FORGE_IDENTITY);

    await git(['checkout', '--quiet', 'main']);
    maintainerCommit = await commit('maintainer-work', TEST_DAY_START + 24 * HOUR_MS);
    await git(['merge', '--quiet', '--no-ff', '--no-edit', '-m', 'sync', 'public'], {
      instantMs: TEST_DAY_START + 48 * HOUR_MS,
      identity: SYNC_BOT_IDENTITY,
    });
    synced = await git(['rev-parse', 'HEAD']);

    bypassed = await commit('bypassed-hook', PLATFORM_CLOCK);
    impersonating = await commit('impersonating', PLATFORM_CLOCK, {
      name: MAINTAINER_IDENTITY.name,
      email: '10000000+maintainer@users.noreply.github.com',
    });
  });

  afterAll(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  it('passes the range a fast-forward onto staging introduces', async () => {
    const outcome = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: trunkBefore,
      [HEAD_VARIABLE]: queueMinted,
    });

    expect(outcome).toEqual({ report: expect.stringContaining('day resolution'), code: 0 });
  });

  it('passes the range the bot merge onto staging introduces', async () => {
    const outcome = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: maintainerCommit,
      [HEAD_VARIABLE]: synced,
    });

    expect(outcome).toEqual({ report: expect.stringContaining('day resolution'), code: 0 });
  });

  it('judges the queue-minted commit the same way on whichever range carries it', async () => {
    const publicTrunk = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: trunkBefore,
      [HEAD_VARIABLE]: queueMinted,
    });
    const stagingTrunk = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: maintainerCommit,
      [HEAD_VARIABLE]: synced,
    });

    expect(await git(['rev-list', `${maintainerCommit}..${synced}`])).toContain(queueMinted);
    expect({
      publicTrunk: publicTrunk.report.includes(queueMinted.slice(0, 12)),
      stagingTrunk: stagingTrunk.report.includes(queueMinted.slice(0, 12)),
    }).toEqual({ publicTrunk: false, stagingTrunk: false });
    expect(publicTrunk.code).toBe(stagingTrunk.code);
  });

  it('still refuses a commit a developer authored with a stamp finer than a day', async () => {
    const outcome = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: synced,
      [HEAD_VARIABLE]: bypassed,
    });

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(bypassed.slice(0, 12));
  });

  /**
   * A mailmap is a different class of widening from a developer spelling the
   * forge address into their own configuration: it is a file in the repository,
   * so it acts on every clone and on developers who made no such choice, it acts
   * on commits already written, and the commit's own committer field still reads
   * the developer's address while a mapped read returns another. Nothing has
   * ruled that acceptable, so it must not be reachable.
   */
  it('cannot be widened by a mailmap the repository carries', async () => {
    const restoreTo = await git(['rev-parse', 'HEAD']);
    const mailmap = path.join(repository, '.mailmap');
    try {
      await fs.writeFile(
        mailmap,
        `${FORGE_IDENTITY.name} <${FORGE_IDENTITY.email}> <${MAINTAINER_IDENTITY.email}>\n`,
        'utf8'
      );
      await git(['add', '.mailmap']);
      await git(['commit', '-m', 'mailmap'], { instantMs: TEST_DAY_START + 72 * HOUR_MS });

      // Without this the fixture can go quiet: it is the commit-side address —
      // the trailing one — that is matched against commits, so a drift there
      // maps nothing, both spellings return the address the commit carries, and
      // the refusal this test asserts would be the ordinary one rather than the
      // one it claims to measure.
      expect(await git(['log', '--format=%cE', '-1', bypassed])).toBe(FORGE_IDENTITY.email);

      const outcome = await runCommitDateCheck(repository, {
        [BASE_VARIABLE]: synced,
        [HEAD_VARIABLE]: bypassed,
      });

      expect(outcome.code).toBe(1);
      expect(outcome.report).toContain(bypassed.slice(0, 12));
    } finally {
      await fs.rm(mailmap, { force: true });
      await git(['reset', '--quiet', '--hard', restoreTo]);
    }
  });

  it('refuses a developer whose no-reply address merely resembles the forge address', async () => {
    const outcome = await runCommitDateCheck(repository, {
      [BASE_VARIABLE]: bypassed,
      [HEAD_VARIABLE]: impersonating,
    });

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(impersonating.slice(0, 12));
  });
});
