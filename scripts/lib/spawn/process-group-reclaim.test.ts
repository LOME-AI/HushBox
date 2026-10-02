import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELD_CLAIMS_ENV } from '../claims/claim.js';
import {
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  untilObserved,
} from '../bounded-wait.setup.js';
import {
  RUN_CLAIM_ENV,
  addResource,
  addSpawnedProcess,
  enumerateClaims,
  registerRun,
} from '../claims/registry.js';
import {
  addressesOneTree,
  attributeLiveGroup,
  groupIsAlive,
  groupMembers,
  groupSignalWasRefused,
  readRecordedProcessGroups,
  reclaimProcessGroups,
  recordedGroupAddressesATree,
} from './long-lived.js';
import type { RunInit } from '../claims/registry.js';
import type { KillTreeDeps } from './long-lived.js';

/**
 * What a killed run's recorded tree meets on the next command, and what a live
 * run's does not.
 *
 * Every tree here is a real one the kernel made: a case that recorded a number
 * and asserted about it would be asserting over its own fixture rather than
 * over the thing this pass has to decide the fate of, and the number is the
 * whole of what a record carries.
 */

let registryDir: string;
/** Every group a case started, ended in teardown whether the case passed or not. */
let started: number[];
/** What the invocation running this suite holds, put back where it was found. */
let inheritedRunClaim: string | undefined;

function init(overrides: Partial<RunInit> = {}): RunInit {
  return {
    command: 'pnpm dev',
    mode: 'development',
    slot: 3,
    gitCommonDir: path.join(registryDir, 'checkout', '.git'),
    registryDir,
    ...overrides,
  };
}

/** A child that stays up until something ends it. */
const IDLE = 'setInterval(() => {}, 1000)';

/**
 * The same, having first started a child of its own with the environment
 * replaced, so the group holds one process naming no run at all. A live run on
 * this machine really is shaped this way: its own fixtures start helpers with
 * the run identity removed, and those helpers sit in the run's group.
 *
 * A case waiting for the group to hold both is waiting on a boot: the second
 * process exists only once the first has started far enough to spawn it, which
 * is why those waits carry the boot budget while the wait for a member to go
 * again carries the one for a process that is already running.
 */
const IDLE_BESIDE_A_PROCESS_NAMING_NO_RUN =
  "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], " +
  "{ stdio: 'ignore', env: { PATH: process.env.PATH } });" +
  IDLE;

/**
 * A real detached child, leading a group of its own exactly as a spawn does.
 *
 * What it inherits is whatever the caller's environment holds, so a case that
 * calls it outside a run gets a tree naming no run — a stranger to every claim
 * here, which is what a reissued id points at.
 */
function detachedGroup(script: string = IDLE): number {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const { pid } = child;
  if (pid === undefined) throw new Error('the fixture child did not start');
  started.push(pid);
  return pid;
}

/** Leaves an owned-expired claim behind: the run throws, so its record survives. */
async function leaveExpiredClaim(record: () => Promise<void>): Promise<void> {
  await registerRun(init(), async () => {
    await record();
    throw new Error('the run was killed');
  }).catch(() => undefined);
}

/**
 * The tree of a run that was killed: started from inside the run, so it carries
 * that run's record in its environment the way every spawned child does, and
 * recorded against the claim the run leaves behind.
 */
async function orphanedTree(script?: string): Promise<{ pgid: number; runDir: string }> {
  let pgid = 0;
  let runDir = '';
  await leaveExpiredClaim(async () => {
    pgid = detachedGroup(script);
    runDir = process.env[RUN_CLAIM_ENV] ?? '';
    await addSpawnedProcess({ pid: pgid, pgid });
  });
  return { pgid, runDir };
}

/** Every process group the registry still records, whoever recorded it. */
async function recordedGroups(): Promise<number[]> {
  const claims = await enumerateClaims(registryDir);
  return claims.flatMap((found) => found.claim.spawned.map((spawned) => spawned.pgid));
}

/** A killer whose signal fails with `code`, so a refusal can be put to the pass. */
function refusingKiller(code: string): KillTreeDeps {
  return {
    platform: 'linux',
    signal: () => {
      throw Object.assign(new Error(`kill: ${code}`), { code });
    },
  };
}

beforeEach(async () => {
  // The invocation running this suite is itself a registered run and advertises
  // it in the environment every child inherits, so a case calling `registerRun`
  // would adopt that run instead of registering its own. Kept rather than
  // stubbed: `registerRun` blanks the variable by raw assignment on its way
  // out, which no unstubbing reaches.
  inheritedRunClaim = process.env[RUN_CLAIM_ENV];
  process.env[RUN_CLAIM_ENV] = '';
  vi.stubEnv(HELD_CLAIMS_ENV, '');
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-group-registry-'));
  started = [];
});

afterEach(async () => {
  // Ahead of the kill loop, which throws when setup failed before it assigned
  // the group list, and ahead of the removal. Restored as the empty string
  // rather than removed: every reader treats an empty claim variable as no
  // claim, and a computed key cannot be deleted.
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  for (const pgid of started) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone is the outcome this wanted.
    }
  }
  await fs.rm(registryDir, { recursive: true, force: true });
});

describe('the process groups the registry records', () => {
  it('names the group an expired claim recorded, with the run that recorded it', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    await expect(readRecordedProcessGroups(registryDir)).resolves.toEqual([
      { pgid: 4321, runLive: false, claim: expect.objectContaining({ command: 'pnpm dev' }) },
    ]);
  });

  it('attributes a group two runs recorded to the live one, because an id is reusable', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    const found = await registerRun(init({ command: 'pnpm e2e' }), async () => {
      await addSpawnedProcess({ pid: 4321, pgid: 4321 });
      return readRecordedProcessGroups(registryDir);
    });

    expect(found).toEqual([
      { pgid: 4321, runLive: true, claim: expect.objectContaining({ command: 'pnpm e2e' }) },
    ]);
  });
});

describe('asking whether a recorded group is still there', () => {
  it('says a real detached tree is', () => {
    expect(groupIsAlive(detachedGroup())).toBe(true);
  });

  it('says a group nothing is in is not', async () => {
    const pgid = detachedGroup();
    process.kill(-pgid, 'SIGKILL');

    expect(await untilObserved(() => !groupIsAlive(pgid), SIGNAL_REACTION_BUDGET_MS)).toBe(true);
  });
});

describe('which recorded ids name one tree', () => {
  it('takes an ordinary group id', () => {
    expect(addressesOneTree(4321)).toBe(true);
  });

  it('refuses the two ids that negate into every process this user may signal', () => {
    expect(addressesOneTree(0)).toBe(false);
    expect(addressesOneTree(1)).toBe(false);
  });

  it('refuses an id that is no whole number at all', () => {
    expect(addressesOneTree(Number.NaN)).toBe(false);
  });
});

describe('the platforms a recorded id addresses a tree on', () => {
  it('addresses one where a spawn gives its child a group', () => {
    expect(recordedGroupAddressesATree('linux')).toBe(true);
    expect(recordedGroupAddressesATree('darwin')).toBe(true);
  });

  it('addresses none where the platform has no such thing', () => {
    expect(recordedGroupAddressesATree('win32')).toBe(false);
  });
});

describe('reclaiming the tree of a run that has gone', () => {
  it('ends the tree its expired claim names', async () => {
    const { pgid } = await orphanedTree();

    const report = await reclaimProcessGroups({ registryDir, log: () => undefined });

    expect(report).toEqual({ reclaimed: [pgid], live: [], refused: [] });
    expect(await untilObserved(() => !groupIsAlive(pgid), SIGNAL_REACTION_BUDGET_MS)).toBe(true);
  });

  it('says what it ended, because a destruction is something that happened', async () => {
    const { pgid } = await orphanedTree();
    const printed: string[] = [];

    await reclaimProcessGroups({ registryDir, log: (message) => printed.push(message) });

    expect(printed).toEqual([expect.stringContaining(`process group ${String(pgid)}`)]);
    expect(printed[0]).toContain('pnpm dev');
    expect(printed[0]).toContain('was ended');
    // Nothing asking a reader to do anything: the repair is that it was done.
    expect(printed[0]).not.toContain('by hand');
  });

  it('leaves the tree of a run that still holds its claim', async () => {
    const pgid = detachedGroup();

    const report = await registerRun(init(), async () => {
      await addSpawnedProcess({ pid: pgid, pgid });
      return reclaimProcessGroups({ registryDir, log: () => undefined });
    });

    expect(report).toEqual({ reclaimed: [], live: [pgid], refused: [] });
    expect(groupIsAlive(pgid)).toBe(true);
  });

  it('says nothing about a recorded group the kernel no longer knows', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));
    const sent = vi.spyOn(process, 'kill');

    try {
      const report = await reclaimProcessGroups({
        registryDir,
        groupIsAlive: () => false,
        log: () => undefined,
      });

      expect(report).toEqual({ reclaimed: [], live: [], refused: [] });
      expect(sent).not.toHaveBeenCalled();
    } finally {
      sent.mockRestore();
    }
  });

  it('passes over a record whose id, negated, addresses more than one tree', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 1, pgid: 1 }));
    const sent = vi.spyOn(process, 'kill');

    try {
      const report = await reclaimProcessGroups({
        registryDir,
        groupIsAlive: () => true,
        log: () => undefined,
      });

      expect(report).toEqual({ reclaimed: [], live: [], refused: [] });
      expect(sent).not.toHaveBeenCalled();
    } finally {
      sent.mockRestore();
    }
  });

  it('ends nothing on a platform where a recorded id addresses no tree', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));
    const ended: number[] = [];

    const report = await reclaimProcessGroups({
      registryDir,
      groupIsAlive: () => true,
      killer: { platform: 'win32', run: (_file, args) => ended.push(Number(args[1])) },
      log: () => undefined,
    });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [] });
    expect(ended).toEqual([]);
  });
});

describe('whose the processes in a live group are', () => {
  it("reads a run's own tree off the kernel as that run's", async () => {
    const { pgid, runDir } = await orphanedTree();

    await expect(attributeLiveGroup(pgid, runDir, 'linux')).resolves.toBe('this-run');
  });

  it('reads a tree that run never started as something else, whatever names its id', async () => {
    const stranger = detachedGroup();
    const { runDir } = await orphanedTree();

    await expect(attributeLiveGroup(stranger, runDir, 'linux')).resolves.toBe('not-this-run');
  });

  it("reads a group as its run's on one member's record, though another names no run", async () => {
    const { pgid, runDir } = await orphanedTree(IDLE_BESIDE_A_PROCESS_NAMING_NO_RUN);
    expect(
      await untilObserved(
        async () => ((await groupMembers(pgid)) ?? []).length === 2,
        FIXTURE_BOOT_BUDGET_MS
      )
    ).toBe(true);

    await expect(attributeLiveGroup(pgid, runDir, 'linux')).resolves.toBe('this-run');
  });

  it("stops reading it as that run's once the member carrying the record has gone", async () => {
    const { pgid, runDir } = await orphanedTree(IDLE_BESIDE_A_PROCESS_NAMING_NO_RUN);
    expect(
      await untilObserved(
        async () => ((await groupMembers(pgid)) ?? []).length === 2,
        FIXTURE_BOOT_BUDGET_MS
      )
    ).toBe(true);
    // The group's leader is the process the run started, so ending it alone
    // leaves the group standing with only the process that names no run in it.
    process.kill(pgid, 'SIGKILL');
    expect(
      await untilObserved(
        async () => ((await groupMembers(pgid)) ?? []).length === 1,
        SIGNAL_REACTION_BUDGET_MS
      )
    ).toBe(true);

    await expect(attributeLiveGroup(pgid, runDir, 'linux')).resolves.toBe('not-this-run');
  });

  it('has no answer about a group nothing is in', async () => {
    const { pgid, runDir } = await orphanedTree();
    process.kill(-pgid, 'SIGKILL');
    expect(await untilObserved(() => !groupIsAlive(pgid), SIGNAL_REACTION_BUDGET_MS)).toBe(true);

    await expect(attributeLiveGroup(pgid, runDir, 'linux')).resolves.toBe('unanswerable');
  });

  it('has no answer where the platform publishes no live process environment', async () => {
    const { pgid, runDir } = await orphanedTree();

    await expect(attributeLiveGroup(pgid, runDir, 'darwin')).resolves.toBe('unanswerable');
  });
});

describe('a group whose id the kernel has reissued', () => {
  it('spares a tree no run here started, however expired the claim naming its id', async () => {
    const stranger = detachedGroup();
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: stranger, pgid: stranger }));

    const report = await reclaimProcessGroups({ registryDir, log: () => undefined });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [] });
    expect(groupIsAlive(stranger)).toBe(true);
  });

  it('says which tree it left running and what stopped it ending it', async () => {
    const stranger = detachedGroup();
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: stranger, pgid: stranger }));
    const printed: string[] = [];

    await reclaimProcessGroups({ registryDir, log: (message) => printed.push(message) });

    expect(printed).toEqual([expect.stringContaining(`process group ${String(stranger)}`)]);
    expect(printed[0]).toContain('left running');
    // Nothing asking a reader to do anything: the next pass asks the same
    // question again, and the answer moves the moment the id stops naming
    // something else.
    expect(printed[0]).not.toContain('by hand');
  });

  it('leaves a real orphan running where the platform cannot say whose the tree is', async () => {
    const { pgid } = await orphanedTree();
    const printed: string[] = [];

    const report = await reclaimProcessGroups({
      registryDir,
      killer: {
        platform: 'darwin',
        signal: () => {
          throw new Error('nothing may be signalled where nothing can be attributed');
        },
      },
      log: (message) => printed.push(message),
    });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [] });
    expect(groupIsAlive(pgid)).toBe(true);
    expect(printed).toEqual([expect.stringContaining('cannot say what started')]);
  });
});

describe('a tree this user may not end', () => {
  it('reads the one code the kernel refuses a signal with as a refusal', () => {
    expect(groupSignalWasRefused(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true);
  });

  it('reads every other failure as this pass having gone wrong', () => {
    expect(groupSignalWasRefused(Object.assign(new Error('x'), { code: 'EINVAL' }))).toBe(false);
    expect(groupSignalWasRefused(new Error('no code at all'))).toBe(false);
    expect(groupSignalWasRefused('not an error')).toBe(false);
    expect(groupSignalWasRefused(null)).toBe(false);
  });

  it('names it, leaves it running and goes on to the tree behind it', async () => {
    const { pgid: refused } = await orphanedTree();
    const printed: string[] = [];

    const report = await reclaimProcessGroups({
      registryDir,
      killer: refusingKiller('EPERM'),
      signalRefused: groupSignalWasRefused,
      log: (message) => printed.push(message),
    });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [refused] });
    expect(printed).toEqual([expect.stringContaining("is not this user's to end")]);
    expect(groupIsAlive(refused)).toBe(true);
  });

  it('warns through the console for a caller that named no log of its own', async () => {
    await orphanedTree();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await reclaimProcessGroups({
        registryDir,
        killer: refusingKiller('EPERM'),
        signalRefused: groupSignalWasRefused,
      });

      expect(warned).toHaveBeenCalledWith(expect.stringContaining("is not this user's to end"));
    } finally {
      warned.mockRestore();
    }
  });

  it('raises for a caller that named no refusal it steps over', async () => {
    await orphanedTree();

    await expect(
      reclaimProcessGroups({ registryDir, killer: refusingKiller('EPERM'), log: () => undefined })
    ).rejects.toMatchObject({ code: 'EPERM' });
  });
});

/**
 * What the record carries once a pass has answered for what it names. An id
 * whose group is gone can never again mean what it meant — the kernel hands the
 * number to unrelated work — so leaving the entry there makes every later pass
 * of every command re-examine a number none of them may act on. An id the pass
 * left standing is a different matter: the answer moves the moment the world
 * does, so the entry is what the next pass asks its question of.
 */
describe('what a pass leaves in the record', () => {
  it('retires the entry of the tree it ended', async () => {
    const { pgid } = await orphanedTree();

    await reclaimProcessGroups({ registryDir, log: () => undefined });

    expect(await untilObserved(() => !groupIsAlive(pgid), SIGNAL_REACTION_BUDGET_MS)).toBe(true);
    await expect(recordedGroups()).resolves.toEqual([]);
  });

  it('retires the entry of a group the kernel says nothing is in', async () => {
    const { pgid } = await orphanedTree();
    process.kill(-pgid, 'SIGKILL');
    expect(await untilObserved(() => !groupIsAlive(pgid), SIGNAL_REACTION_BUDGET_MS)).toBe(true);

    const report = await reclaimProcessGroups({ registryDir, log: () => undefined });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [] });
    await expect(recordedGroups()).resolves.toEqual([]);
  });

  it('leaves the resources the same record names, which other reclaimers read', async () => {
    await leaveExpiredClaim(async () => {
      await addResource({ kind: 'port', id: '10042' });
      const pgid = detachedGroup();
      await addSpawnedProcess({ pid: pgid, pgid });
    });

    await reclaimProcessGroups({ registryDir, log: () => undefined });

    const [found] = await enumerateClaims(registryDir);
    expect(found?.claim.resources).toEqual([{ kind: 'port', id: '10042' }]);
  });

  it('keeps the entry of a tree a live run is still working with', async () => {
    const pgid = detachedGroup();

    const kept = await registerRun(init(), async () => {
      await addSpawnedProcess({ pid: pgid, pgid });
      await reclaimProcessGroups({ registryDir, log: () => undefined });
      return recordedGroups();
    });

    expect(kept).toEqual([pgid]);
  });

  it('keeps the entry of a live run whose group the kernel says nothing is in', async () => {
    const kept = await registerRun(init(), async () => {
      await addSpawnedProcess({ pid: 4321, pgid: 4321 });
      // A record is its own run's to write and nobody else's, whatever the
      // kernel says about what it names.
      await reclaimProcessGroups({ registryDir, groupIsAlive: () => false, log: () => undefined });
      return recordedGroups();
    });

    expect(kept).toEqual([4321]);
  });

  it('keeps the entry of a tree whose id now names something else', async () => {
    const stranger = detachedGroup();
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: stranger, pgid: stranger }));

    await reclaimProcessGroups({ registryDir, log: () => undefined });

    await expect(recordedGroups()).resolves.toEqual([stranger]);
  });

  it('keeps the entry of a tree the platform cannot say the owner of', async () => {
    const { pgid } = await orphanedTree();

    await reclaimProcessGroups({
      registryDir,
      killer: {
        platform: 'darwin',
        signal: () => {
          throw new Error('nothing may be signalled where nothing can be attributed');
        },
      },
      log: () => undefined,
    });

    await expect(recordedGroups()).resolves.toEqual([pgid]);
  });

  it('keeps the entry of a tree it was refused permission to end', async () => {
    const { pgid } = await orphanedTree();

    await reclaimProcessGroups({
      registryDir,
      killer: refusingKiller('EPERM'),
      signalRefused: groupSignalWasRefused,
      log: () => undefined,
    });

    await expect(recordedGroups()).resolves.toEqual([pgid]);
  });

  it('keeps an entry whose id, negated, addresses more than one tree', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 1, pgid: 1 }));

    await reclaimProcessGroups({
      registryDir,
      groupIsAlive: () => true,
      log: () => undefined,
    });

    await expect(recordedGroups()).resolves.toEqual([1]);
  });

  it('retires nothing where a recorded id addresses no tree at all', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    await reclaimProcessGroups({
      registryDir,
      groupIsAlive: () => false,
      killer: { platform: 'win32', run: () => undefined },
      log: () => undefined,
    });

    await expect(recordedGroups()).resolves.toEqual([4321]);
  });
});
