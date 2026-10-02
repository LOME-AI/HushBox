import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execa } from 'execa';
import { chmodSync, existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as atomicRename from '@hushbox/shared/atomic-rename';
import { tryLock } from './claim.js';
import {
  RUN_CLAIM_ENV,
  addResource,
  addSpawnedProcess,
  claimsDir,
  enumerateClaims,
  enumerateRegistry,
  unreadLiveRuns,
  lockPathFor,
  readSlotLiveness,
  registerRun,
  releaseBeforeRecordDrops,
  retireRecordedGroup,
  type RunInit,
} from './registry.js';

/**
 * A process adopts a run only by inheriting it, so the cases about adoption run
 * a real child. It goes through tsx's loader in-process (`--import`) rather than
 * through its CLI, which forks: what the fixture reports has to be what the
 * process the case started saw.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const ADOPTED_ENTRY = fileURLToPath(new URL('adopted-run-entry.mjs', import.meta.url));

/** Fails the next rename outright, leaving the directory it was landing in writable. */
function failTheNextRename(): void {
  vi.spyOn(atomicRename, 'renameWithRetry').mockRejectedValueOnce(
    Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
  );
}

/**
 * Seals the directory the write is landing in and then fails. Sealing is what
 * makes the clean-up after a failed write genuinely unable to unlink, and no
 * filesystem state produces that on its own: the staging file is written while
 * the directory is still writable, and the only moment between that write and
 * the clean-up belongs to the rename.
 */
function sealTheDirectoryAndFail(): void {
  vi.spyOn(atomicRename, 'renameWithRetry').mockImplementationOnce((_from, to) => {
    chmodSync(path.dirname(to), 0o555);
    return Promise.reject(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
  });
}

/** The name the shared module stages a write to `target` under, less its random half. */
function stagingNameFor(target: string): string {
  return `${target}.${String(process.pid)}-in-flight.tmp`;
}

let registryDir: string;

function init(overrides: Partial<RunInit> = {}): RunInit {
  return {
    command: 'pnpm dev',
    mode: 'development',
    slot: 0,
    gitCommonDir: path.join(registryDir, 'checkout', '.git'),
    registryDir,
    ...overrides,
  };
}

/**
 * Runs the adopting fixture as a child of this process, and hands back the line
 * it printed. Called from inside a run, which is what puts the claim it adopts
 * into the environment the child inherits.
 */
async function adoptedRun(): Promise<string> {
  const { stdout } = await execa(process.execPath, [
    '--import',
    TSX_LOADER,
    ADOPTED_ENTRY,
    registryDir,
    'pnpm build',
    'development',
    '0',
    path.join(registryDir, 'checkout', '.git'),
  ]);
  return stdout;
}

/**
 * The run claim this file was invoked under. It is cleared before every case
 * below, and a hook that puts back an empty string instead leaves every later
 * suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

beforeEach(async () => {
  // Canonical, so a path a case builds under it is the spelling the registry
  // stores: a temp directory is under a symlinked root on some platforms.
  registryDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claim-registry-')));
  process.env[RUN_CLAIM_ENV] = '';
});

afterEach(async () => {
  await fs.rm(registryDir, { recursive: true, force: true });
});

/**
 * Once per file rather than per case, because a per-case restore is skipped
 * whole by a throw in any teardown that runs before it — every nested one, and
 * this file has one that calls the mock-restoration helper. The runner runs a
 * once-per-file teardown regardless of a failing per-case one, and this is the
 * only one this file registers at its own scope, so nothing can skip it.
 *
 * Empty string rather than absent: every reader treats an empty claim variable
 * as no claim, and a computed key cannot be deleted.
 */
afterAll(() => {
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
});

describe('where the registry lives', () => {
  it('places the registry in a per-user directory of the OS temp directory', () => {
    const dir = claimsDir();

    expect(path.dirname(dir)).toBe(os.tmpdir());
    expect(path.basename(dir)).toContain(os.userInfo().username);
  });
});

describe('registerRun', () => {
  it('runs the body and returns its value', async () => {
    await expect(registerRun(init(), () => Promise.resolve('ran'))).resolves.toBe('ran');
  });

  it('records the mode, slot, pid and git common directory of the run', async () => {
    let seen: Awaited<ReturnType<typeof enumerateClaims>> = [];

    await registerRun(init({ mode: 'e2e', slot: 7 }), async () => {
      seen = await enumerateClaims(registryDir);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.claim).toMatchObject({
      command: 'pnpm dev',
      mode: 'e2e',
      slot: 7,
      pid: process.pid,
      gitCommonDir: init().gitCommonDir,
    });
  });

  /**
   * The checkout identity is what every reclaimer compares a claim against to
   * decide whether the run is one of this checkout's — `pnpm clean` refuses on
   * it, and `pnpm dev:clean --all` spares another checkout's ports on it. A
   * checkout reached through a symlink has two absolute spellings, so a
   * registry storing whichever one its caller happened to hold would answer
   * that question wrongly for a run entered by the other.
   */
  it('records one checkout identity however the caller spelled the directory', async () => {
    await fs.mkdir(path.join(registryDir, 'real', '.git'), { recursive: true });
    await fs.symlink(path.join(registryDir, 'real'), path.join(registryDir, 'link'), 'dir');
    let seen: Awaited<ReturnType<typeof enumerateClaims>> = [];

    await registerRun(init({ gitCommonDir: path.join(registryDir, 'link', '.git') }), async () => {
      seen = await enumerateClaims(registryDir);
    });

    expect(seen[0]?.claim.gitCommonDir).toBe(path.join(registryDir, 'real', '.git'));
  });

  it('holds the lock on its own claim file while the body runs', async () => {
    let held = false;

    await registerRun(init(), async () => {
      const [found] = await enumerateClaims(registryDir);
      const probe = await tryLock(lockPathFor(registryDir, found?.claim.runId ?? ''));
      held = probe.held;
    });

    expect(held).toBe(true);
  });

  it('names the run as the holder of its claim', async () => {
    let holder: string | null = null;

    await registerRun(init(), async () => {
      const [found] = await enumerateClaims(registryDir);
      const probe = await tryLock(lockPathFor(registryDir, found?.claim.runId ?? ''));
      holder = probe.holder;
    });

    expect(holder).toBe('pnpm dev');
  });

  it('classifies its own claim as owned-live while the body runs', async () => {
    let state: string | undefined;

    await registerRun(init(), async () => {
      const [found] = await enumerateClaims(registryDir);
      state = found?.state;
    });

    expect(state).toBe('owned-live');
  });

  it('removes the claim on a clean exit', async () => {
    await registerRun(init(), () => Promise.resolve());

    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });

  it('leaves the claim for reclamation when the body throws', async () => {
    await expect(
      registerRun(init(), () => Promise.reject(new Error('the run failed')))
    ).rejects.toThrow('the run failed');

    await expect(enumerateClaims(registryDir)).resolves.toHaveLength(1);
  });

  it('classifies the claim of a run that is no longer holding as owned-expired', async () => {
    await registerRun(init(), () => Promise.reject(new Error('the run failed'))).catch(() => {});

    const [found] = await enumerateClaims(registryDir);

    expect(found?.state).toBe('owned-expired');
  });
});

describe('releasing what the run created', () => {
  it('releases while the record naming it is still there', async () => {
    let claimsWhileReleasing = -1;

    await registerRun(init(), () => {
      releaseBeforeRecordDrops(async () => {
        const claims = await enumerateClaims(registryDir);
        claimsWhileReleasing = claims.length;
      });
      return Promise.resolve();
    });

    expect(claimsWhileReleasing).toBe(1);
  });

  it('removes the record once everything it named has been released', async () => {
    let releases = 0;

    await registerRun(init(), () => {
      releaseBeforeRecordDrops(() => {
        releases += 1;
      });
      return Promise.resolve();
    });

    expect(releases).toBe(1);
    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });

  it('leaves what a run that threw created for the next run to reclaim', async () => {
    let releases = 0;

    await registerRun(init(), () => {
      releaseBeforeRecordDrops(() => {
        releases += 1;
      });
      return Promise.reject(new Error('the run was killed'));
    }).catch(() => undefined);

    expect(releases).toBe(0);
    await expect(enumerateClaims(registryDir)).resolves.toHaveLength(1);
  });

  it('releases nothing twice, a later run having its own to release', async () => {
    let releases = 0;

    await registerRun(init(), () => {
      releaseBeforeRecordDrops(() => {
        releases += 1;
      });
      return Promise.resolve();
    });
    await registerRun(init(), () => Promise.resolve());

    expect(releases).toBe(1);
  });
});

describe('recording what a run owns', () => {
  it('records a resource claimed during the run', async () => {
    let resources: readonly unknown[] = [];

    await registerRun(init(), async () => {
      await addResource({ kind: 'port', id: '10042' });
      const [found] = await enumerateClaims(registryDir);
      resources = found?.claim.resources ?? [];
    });

    expect(resources).toEqual([{ kind: 'port', id: '10042' }]);
  });

  it('keeps an earlier resource when a later one is recorded', async () => {
    let resources: readonly unknown[] = [];

    await registerRun(init(), async () => {
      await addResource({ kind: 'port', id: '10042' });
      await addResource({ kind: 'database', id: 'hb_t_one' });
      const [found] = await enumerateClaims(registryDir);
      resources = found?.claim.resources ?? [];
    });

    expect(resources).toHaveLength(2);
  });

  it('records a spawned process group', async () => {
    let spawned: readonly unknown[] = [];

    await registerRun(init(), async () => {
      await addSpawnedProcess({ pid: 4321, pgid: 4321 });
      const [found] = await enumerateClaims(registryDir);
      spawned = found?.claim.spawned ?? [];
    });

    expect(spawned).toEqual([{ pid: 4321, pgid: 4321 }]);
  });

  it('refuses to record a resource outside a registered run', async () => {
    await expect(addResource({ kind: 'port', id: '10042' })).rejects.toThrow(/registerRun/);
  });

  it('reads no entry out of the staging file of a write in flight', async () => {
    let resources: readonly unknown[] = [];

    await registerRun(init(), async () => {
      await addResource({ kind: 'port', id: '10042' });
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      await fs.writeFile(
        stagingNameFor(path.join(runDir, 'entry-a.json')),
        JSON.stringify({ entry: 'resource', resource: { kind: 'port', id: '10043' } }),
        'utf8'
      );
      const [found] = await enumerateClaims(registryDir);
      resources = found?.claim.resources ?? [];
    });

    expect(resources).toEqual([{ kind: 'port', id: '10042' }]);
  });

  it('clears its staging file away when a record cannot land', async () => {
    let left: readonly string[] = [];

    await registerRun(init(), async () => {
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      failTheNextRename();
      await expect(addResource({ kind: 'port', id: '10042' })).rejects.toThrow();
      const names = await fs.readdir(runDir);
      left = names.filter((name) => name.endsWith('.tmp'));
    });

    expect(left).toEqual([]);
  });

  it('names the failure that stopped the write rather than the one met clearing up', async () => {
    await registerRun(init(), async () => {
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      sealTheDirectoryAndFail();
      try {
        await expect(addResource({ kind: 'port', id: '10042' })).rejects.toMatchObject({
          cause: { code: 'EXDEV' },
        });
      } finally {
        chmodSync(runDir, 0o700);
      }
    });
  });
});

/**
 * The inverse of {@link addSpawnedProcess}, and the only edit anything makes to
 * a record it did not write. It is reached with a run's own record left behind
 * by that run's death, so nothing is writing it while these cases read it back.
 */
describe('retiring a recorded group', () => {
  /** Leaves an owned-expired record behind: the run throws, so nothing removes it. */
  async function leaveExpiredClaim(record: () => Promise<void>): Promise<string> {
    let runId = '';
    await registerRun(init(), async () => {
      runId = path.basename(process.env[RUN_CLAIM_ENV] ?? '');
      await record();
      throw new Error('the run was killed');
    }).catch(() => undefined);
    return runId;
  }

  it('removes the entry naming the group it was given', async () => {
    const runId = await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    await retireRecordedGroup(runId, 4321, registryDir);

    const [found] = await enumerateClaims(registryDir);
    expect(found?.claim.spawned).toEqual([]);
  });

  it('leaves the staging file of a write in flight alone', async () => {
    const runId = await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));
    const staging = stagingNameFor(path.join(registryDir, runId, 'entry-a.json'));
    await fs.writeFile(
      staging,
      JSON.stringify({ entry: 'process', process: { pid: 4321, pgid: 4321 } }),
      'utf8'
    );

    await retireRecordedGroup(runId, 4321, registryDir);

    expect(existsSync(staging)).toBe(true);
  });

  it('leaves an entry naming a different group', async () => {
    const runId = await leaveExpiredClaim(async () => {
      await addSpawnedProcess({ pid: 4321, pgid: 4321 });
      await addSpawnedProcess({ pid: 8642, pgid: 8642 });
    });

    await retireRecordedGroup(runId, 4321, registryDir);

    const [found] = await enumerateClaims(registryDir);
    expect(found?.claim.spawned).toEqual([{ pid: 8642, pgid: 8642 }]);
  });

  it('removes every entry of that run naming the group', async () => {
    const runId = await leaveExpiredClaim(async () => {
      await addSpawnedProcess({ pid: 4321, pgid: 4321 });
      await addSpawnedProcess({ pid: 4322, pgid: 4321 });
    });

    await retireRecordedGroup(runId, 4321, registryDir);

    const [found] = await enumerateClaims(registryDir);
    expect(found?.claim.spawned).toEqual([]);
  });

  it('leaves the resources the record also names', async () => {
    const runId = await leaveExpiredClaim(async () => {
      await addResource({ kind: 'port', id: '10042' });
      await addResource({ kind: 'database', id: 'hb_t_one' });
      await addSpawnedProcess({ pid: 4321, pgid: 4321 });
    });

    await retireRecordedGroup(runId, 4321, registryDir);

    const [found] = await enumerateClaims(registryDir);
    // Order is the directory's rather than the recording's: an entry is its own
    // file, which is what lets concurrent recorders never contend.
    expect(found?.claim.resources).toEqual(
      expect.arrayContaining([
        { kind: 'port', id: '10042' },
        { kind: 'database', id: 'hb_t_one' },
      ])
    );
    expect(found?.claim.resources).toHaveLength(2);
  });

  it('leaves the run itself claimed, its record being the only thing that owns anything', async () => {
    const runId = await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    await retireRecordedGroup(runId, 4321, registryDir);

    const [found] = await enumerateClaims(registryDir);
    expect(found).toMatchObject({ state: 'owned-expired', claim: { runId, command: 'pnpm dev' } });
  });

  it('leaves an entry it cannot make sense of, which names no group to match', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let runId = '';
    await registerRun(init(), async () => {
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      runId = path.basename(runDir);
      await addSpawnedProcess({ pid: 4321, pgid: 4321 });
      await fs.writeFile(path.join(runDir, 'entry-broken.json'), '{ not json');
      throw new Error('the run was killed');
    }).catch(() => undefined);

    await retireRecordedGroup(runId, 4321, registryDir);

    const files = await fs.readdir(path.join(registryDir, runId));
    warn.mockRestore();
    expect(files).toContain('entry-broken.json');
  });

  it('passes over a run whose record has already gone', async () => {
    await expect(
      retireRecordedGroup('a-run-that-never-registered', 4321, registryDir)
    ).resolves.toBeUndefined();
  });
});

describe('answering which runs hold a slot', () => {
  it('returns the live claim on the slot', async () => {
    let live: readonly { slot: number }[] = [];

    await registerRun(init({ slot: 3 }), async () => {
      const liveness = await readSlotLiveness(3, registryDir);
      live = liveness.claimed;
    });

    expect(live).toHaveLength(1);
    expect(live[0]?.slot).toBe(3);
  });

  it('ignores a live claim on another slot', async () => {
    let live: readonly unknown[] = [];

    await registerRun(init({ slot: 3 }), async () => {
      const liveness = await readSlotLiveness(4, registryDir);
      live = liveness.claimed;
    });

    expect(live).toEqual([]);
  });

  it('ignores a claim on the slot that is no longer held', async () => {
    await registerRun(init({ slot: 3 }), () => Promise.reject(new Error('the run failed'))).catch(
      () => {}
    );

    await expect(readSlotLiveness(3, registryDir)).resolves.toEqual({ claimed: [], unknown: [] });
  });
});

describe('a process that inherited a run', () => {
  it('adopts the run rather than registering a second one', async () => {
    let claims: readonly unknown[] = [];

    await registerRun(init(), async () => {
      await registerRun(init({ command: 'pnpm build' }), async () => {
        claims = await enumerateClaims(registryDir);
      });
    });

    expect(claims).toHaveLength(1);
  });

  it('records a resource against the run it adopted', async () => {
    let resources: readonly unknown[] = [];

    await registerRun(init(), async () => {
      await registerRun(init({ command: 'pnpm build' }), async () => {
        await addResource({ kind: 'container', id: 'hushbox-postgres' });
      });
      const [found] = await enumerateClaims(registryDir);
      resources = found?.claim.resources ?? [];
    });

    expect(resources).toEqual([{ kind: 'container', id: 'hushbox-postgres' }]);
  });

  it('takes no lock of its own', async () => {
    let locks: string[] = [];

    await registerRun(init(), async () => {
      await registerRun(init({ command: 'pnpm build' }), () => Promise.resolve());
      const present = await fs.readdir(registryDir);
      locks = present.filter((name) => name.endsWith('.lock'));
    });

    expect(locks).toHaveLength(1);
  });

  it('releases what it registered', async () => {
    let reported = '';

    await registerRun(init(), async () => {
      reported = await adoptedRun();
    });

    expect(reported.split(' ')[0]).toBe('1');
  });

  it('releases it while the record naming what it released is still there', async () => {
    let reported = '';

    await registerRun(init(), async () => {
      reported = await adoptedRun();
    });

    expect(reported).toContain('record still there');
  });
});

describe('reading a registry that is not pristine', () => {
  it('reports no claims when the registry has never been written', async () => {
    await expect(enumerateClaims(path.join(registryDir, 'absent'))).resolves.toEqual([]);
  });

  it('ignores the lock file a released claim leaves behind', async () => {
    await registerRun(init(), () => Promise.resolve());

    const left = await fs.readdir(registryDir);

    expect(left.some((name) => name.endsWith('.lock'))).toBe(true);
    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });

  it('ignores a run directory whose record was never written', async () => {
    await fs.mkdir(path.join(registryDir, 'half-written'));

    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });

  it('skips an entry that is not a run directory at all', async () => {
    await fs.writeFile(path.join(registryDir, 'stray'), 'left by something else');

    await registerRun(init(), async () => {
      await expect(enumerateClaims(registryDir)).resolves.toHaveLength(1);
    });
  });

  it('skips a claim record it cannot make sense of', async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: string) => {
      warnings.push(line);
    });
    await fs.mkdir(path.join(registryDir, 'corrupt'));
    await fs.writeFile(path.join(registryDir, 'corrupt', 'run.json'), '{ not json');

    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
    warn.mockRestore();
    expect(warnings).toHaveLength(1);
  });

  it('skips a resource entry it cannot make sense of', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resources: readonly unknown[] = [];

    await registerRun(init(), async () => {
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      await fs.writeFile(path.join(runDir, 'entry-broken.json'), '{ not json');
      const [found] = await enumerateClaims(registryDir);
      resources = found?.claim.resources ?? [];
    });
    warn.mockRestore();

    expect(resources).toEqual([]);
  });
});

describe('a claim whose record cannot be read', () => {
  /** The one run directory in the registry, whatever its record now says. */
  async function onlyRunDir(): Promise<string> {
    const present = await fs.readdir(registryDir);
    return path.join(registryDir, present.find((name) => !name.endsWith('.lock')) ?? '');
  }

  /** A run that died with its record still on disk, and its lock already free. */
  async function abandonRun(overrides: Partial<RunInit> = {}): Promise<string> {
    await registerRun(init(overrides), () => Promise.reject(new Error('the run died'))).catch(
      () => undefined
    );
    return onlyRunDir();
  }

  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((line: string) => {
      warnings.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the run whose record is not JSON rather than reporting nothing there', async () => {
    const runDir = await abandonRun();
    await fs.writeFile(path.join(runDir, 'run.json'), '{ not json');

    const reading = await enumerateRegistry(registryDir);

    expect(reading.unreadable.map((found) => found.runId)).toEqual([path.basename(runDir)]);
    // A run whose record is present but unreadable is not an ended run. Reading
    // it as one answers `owned-expired` for a live run whose record is damaged,
    // and a reclaimer then culls what that run is still using.
    expect(reading.endedRuns).toEqual([]);
  });

  it('reports a record whose contents this version does not recognise', async () => {
    const runDir = await abandonRun();
    const raw: unknown = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
    await fs.writeFile(
      path.join(runDir, 'run.json'),
      JSON.stringify({ ...(raw as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
    );

    const reading = await enumerateRegistry(registryDir);

    expect(reading.unreadable).toHaveLength(1);
  });

  it('names the live runs among the records that were not read, and only those', async () => {
    const dead = await abandonRun();
    await fs.writeFile(path.join(dead, 'run.json'), '{ not json');
    let named: readonly string[] = [];
    let alive = '';

    await registerRun(init(), async () => {
      alive = path.basename(process.env[RUN_CLAIM_ENV] ?? '');
      await fs.writeFile(path.join(registryDir, alive, 'run.json'), '{ not json');
      const reading = await enumerateRegistry(registryDir);
      named = unreadLiveRuns(reading).map((found) => found.runId);
    });

    expect(named).toEqual([alive]);
  });

  it('names a run whose lock file outlived the record it removed on the way out', async () => {
    let ended = '';

    await registerRun(init(), () => {
      ended = path.basename(process.env[RUN_CLAIM_ENV] ?? '');
      return Promise.resolve();
    });

    const reading = await enumerateRegistry(registryDir);

    expect(reading.endedRuns).toEqual([ended]);
  });

  it('names no ended run while the record is still on disk', async () => {
    let seen: readonly string[] = [];

    await registerRun(init(), async () => {
      const reading = await enumerateRegistry(registryDir);
      seen = reading.endedRuns;
    });

    expect(seen).toEqual([]);
  });

  it('reads a lock file it never minted as no run at all', async () => {
    await fs.writeFile(path.join(registryDir, 'idle-daemon-8787.lock'), 'a daemon');

    const reading = await enumerateRegistry(registryDir);

    expect(reading.endedRuns).toEqual([]);
    expect(reading.claims).toEqual([]);
    expect(reading.unreadable).toEqual([]);
  });

  it('leaves it out of the claims, which are the records that were read', async () => {
    const runDir = await abandonRun();
    await fs.writeFile(path.join(runDir, 'run.json'), '{ not json');

    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });

  it('takes its liveness from its lock like any other claim, held', async () => {
    let state: string | undefined;

    await registerRun(init(), async () => {
      await fs.writeFile(path.join(await onlyRunDir(), 'run.json'), '{ not json');
      const reading = await enumerateRegistry(registryDir);
      state = reading.unreadable[0]?.state;
    });

    expect(state).toBe('owned-live');
  });

  it('takes its liveness from its lock like any other claim, released', async () => {
    const runDir = await abandonRun();
    await fs.writeFile(path.join(runDir, 'run.json'), '{ not json');

    const reading = await enumerateRegistry(registryDir);

    expect(reading.unreadable[0]?.state).toBe('owned-expired');
  });

  it('holds every slot while its run is alive, because it names none', async () => {
    let unknown: readonly unknown[] = [];

    await registerRun(init({ slot: 3 }), async () => {
      await fs.writeFile(path.join(await onlyRunDir(), 'run.json'), '{ not json');
      const liveness = await readSlotLiveness(9, registryDir);
      unknown = liveness.unknown;
    });

    expect(unknown).toHaveLength(1);
  });

  it('holds no slot once its run has gone, the lock being the whole predicate', async () => {
    const runDir = await abandonRun({ slot: 3 });
    await fs.writeFile(path.join(runDir, 'run.json'), '{ not json');

    const liveness = await readSlotLiveness(3, registryDir);

    expect(liveness).toEqual({ claimed: [], unknown: [] });
  });

  it('names the run directory a human has to go and look at', async () => {
    const runDir = await abandonRun();
    await fs.writeFile(path.join(runDir, 'run.json'), '{ not json');

    await enumerateRegistry(registryDir);

    expect(warnings.join('\n')).toContain(runDir);
  });

  it('says nothing about a run directory whose record is merely not there', async () => {
    await fs.mkdir(path.join(registryDir, 'half-written'));

    const reading = await enumerateRegistry(registryDir);

    expect(reading).toEqual({ claims: [], unreadable: [], endedRuns: [] });
    expect(warnings).toEqual([]);
  });

  it('says nothing about an entry in the registry that is no run directory at all', async () => {
    await fs.writeFile(path.join(registryDir, 'stray'), 'left by something else');

    const reading = await enumerateRegistry(registryDir);

    expect(reading).toEqual({ claims: [], unreadable: [], endedRuns: [] });
    expect(warnings).toEqual([]);
  });
});

describe('a registry that cannot be read', () => {
  it('surfaces the failure rather than reporting that nothing is owned', async () => {
    const unreadable = path.join(registryDir, 'unreadable');
    await fs.mkdir(unreadable);
    await fs.chmod(unreadable, 0o000);

    await expect(enumerateClaims(unreadable)).rejects.toThrow(/EACCES/);

    await fs.chmod(unreadable, 0o700);
  });

  it('surfaces a claim record it cannot read rather than skipping the claim', async () => {
    const runDir = path.join(registryDir, 'guarded');
    await fs.mkdir(runDir);
    await fs.writeFile(path.join(runDir, 'run.json'), '{}');
    await fs.chmod(path.join(runDir, 'run.json'), 0o000);

    await expect(enumerateClaims(registryDir)).rejects.toThrow(/EACCES/);

    await fs.chmod(path.join(runDir, 'run.json'), 0o600);
  });

  it('surfaces a run directory it cannot list rather than reporting it gone', async () => {
    await registerRun(init(), () => Promise.reject(new Error('the run failed'))).catch(() => {});
    const present = await fs.readdir(registryDir);
    const runDir = path.join(registryDir, present.find((name) => !name.endsWith('.lock')) ?? '');
    // Listable only by traversal: the header still reads, the listing does not.
    await fs.chmod(runDir, 0o100);

    await expect(enumerateClaims(registryDir)).rejects.toThrow(/EACCES/);

    await fs.chmod(runDir, 0o700);
  });
});

describe.skipIf(process.platform === 'win32')('a record removed while it is being read', () => {
  /**
   * A named pipe in place of a record file is what makes these races
   * reproducible rather than hoped for: the enumerator blocks inside that one
   * read, and opening the pipe for writing resolves only once the reader has
   * opened it, so the record can be removed at a known point in the pass.
   * Returns the bytes it replaced, which the test writes back through the pipe.
   */
  async function pipeOver(file: string): Promise<Buffer> {
    const bytes = await fs.readFile(file);
    await fs.rm(file);
    await execa('mkfifo', [file]);
    return bytes;
  }

  /**
   * Awaits a pass deliberately left in flight, so a rejection arriving before
   * the assertion attaches is reported by that assertion rather than as an
   * unhandled one.
   */
  async function outcome(pass: Promise<unknown>): Promise<unknown> {
    try {
      return await pass;
    } catch (error) {
      return error;
    }
  }

  /** A run that died: its record is on disk and its lock is already free. */
  async function abandonedRunDir(): Promise<string> {
    await registerRun(init(), async () => {
      await addResource({ kind: 'port', id: '10001' });
      throw new Error('the run died');
    }).catch(() => undefined);
    const present = await fs.readdir(registryDir);
    return path.join(registryDir, present.find((entry) => !entry.endsWith('.lock')) ?? '');
  }

  it('reports no claim when the record goes between its header and its entries', async () => {
    const runDir = await abandonedRunDir();
    const header = await pipeOver(path.join(runDir, 'run.json'));

    const pass = outcome(enumerateClaims(registryDir));
    const writer = await fs.open(path.join(runDir, 'run.json'), 'w');
    await fs.rm(runDir, { recursive: true, force: true });
    await writer.write(header);
    await writer.close();

    await expect(pass).resolves.toEqual([]);
  });

  /**
   * The second read a record that could not be read gets, for the same reason
   * the readable path takes one: a run that finished removed its record before
   * releasing its lock, so a free lock over a record that has since gone names
   * a run that ended rather than one whose file is damaged.
   */
  it('reports no claim when a record it could not read goes before the second read', async () => {
    const runDir = await abandonedRunDir();
    await pipeOver(path.join(runDir, 'run.json'));

    const pass = outcome(enumerateRegistry(registryDir));
    const writer = await fs.open(path.join(runDir, 'run.json'), 'w');
    await fs.rm(runDir, { recursive: true, force: true });
    await writer.write(Buffer.from('{ not json'));
    await writer.close();

    await expect(pass).resolves.toEqual({
      claims: [],
      unreadable: [],
      endedRuns: [path.basename(runDir)],
    });
  });

  it('reports no claim when the run finishes cleanly while its entries are read', async () => {
    const runDir = await abandonedRunDir();
    const present = await fs.readdir(runDir);
    const entryFile = present.find((name) => name.startsWith('entry-')) ?? '';
    const entry = await pipeOver(path.join(runDir, entryFile));

    const pass = outcome(enumerateClaims(registryDir));
    const writer = await fs.open(path.join(runDir, entryFile), 'w');
    // What a clean exit does, in the order it does it: the record goes first
    // and the lock is released after, so a probe that reads free on a record
    // that has gone is a run that finished, not one that died.
    await fs.rm(runDir, { recursive: true, force: true });
    await writer.write(entry);
    await writer.close();

    await expect(pass).resolves.toEqual([]);
  });
});
