/* eslint-disable @typescript-eslint/require-await -- mock callbacks need to be async to satisfy the dep contract's Promise return shape; vitest fixture, not real async code */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tryLock } from '../claims/claim.js';
import { readOwnership } from '../claims/ownership.js';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { composeProjectName } from '../cli/worktree.js';
import { ensureStack, type EnsureStackDeps, type EnsureStackOptions } from './ensure-stack.js';
import type { OwnershipState } from '../claims/ownership.js';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * A claim is live only while a process holds its lock, so the run standing in
 * the way of a wipe has to be a real one. It runs through tsx's loader
 * in-process (`--import`) rather than through the CLI, which forks: the lock
 * must belong to the process the test can end.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RUN_ENTRY = fileURLToPath(new URL('../claims/registry-run-entry.mjs', import.meta.url));

let workDir = '';
let registryDir = '';

const SLOT = 7;

function makeDeps(overrides: Partial<EnsureStackDeps> = {}): EnsureStackDeps {
  return {
    generateEnvFiles: vi.fn(),
    generateComposeFiles: vi.fn(() => []),
    installDeps: vi.fn(async () => {}),
    cleanupOrphans: vi.fn(async () => {}),
    ensureContainersHealthy: vi.fn(async () => {}),
    ensurePostgresAcceptsPassword: vi.fn(async () => {}),
    ensureDatabase: vi.fn(async () => {}),
    runMigrations: vi.fn(async () => {}),
    installDevTracking: vi.fn(async () => {}),
    provisionAdminSqlPanelRole: vi.fn(async () => {}),
    readMeta: vi.fn().mockResolvedValue({ seedHash: '', seededAt: null, dirty: true }),
    markClean: vi.fn(async () => {}),
    composeDown: vi.fn(async () => {}),
    ensureDaemonRunning: vi.fn(async () => {}),
    readDepsHash: vi.fn().mockResolvedValue(null),
    writeDepsHash: vi.fn(async () => {}),
    computeDepsFingerprint: vi.fn().mockResolvedValue('deps-fp'),
    computeMigrationFingerprint: vi.fn().mockResolvedValue('mig-fp'),
    ensureTestTemplate: vi.fn(async () => {}),
    assertNoSchemaDrift: vi.fn(async () => {}),
    reportProgress: vi.fn(),
    auditStackWorld: vi.fn(async () => {}),
    sqlExecutor: { exec: vi.fn(), query: vi.fn() },
    ...overrides,
  };
}

function makeOptions(overrides: Partial<EnsureStackOptions> = {}): EnsureStackOptions {
  return {
    repoRoot: workDir,
    slot: SLOT,
    daemonScriptPath: '/fake/daemon.ts',
    idleDaemonPort: 7707,
    // Never the machine-wide registry: a test asking who is live on this slot
    // would otherwise read the runs of whoever is using the machine.
    registryDir: registryDir,
    ...overrides,
  };
}

function sectionLock(): string {
  return path.join(workDir, 'scripts', '.cache', 'local', String(SLOT), 'ensure-stack.lock');
}

async function heldNow(): Promise<boolean> {
  const probe = await tryLock(sectionLock());
  return probe.held;
}

interface ForeignRun {
  /** The directory its record lives in, which is also the whole of what names it. */
  readonly runId: string;
  release(): Promise<void>;
}

/** Registers a run on this slot in another process and holds it until released. */
async function startForeignRun(command: string): Promise<ForeignRun> {
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      RUN_ENTRY,
      registryDir,
      command,
      'development',
      String(SLOT),
      workDir,
      'hold',
    ],
    {
      // Cleared, or the child adopts this process's run instead of taking a
      // claim of its own, and nothing would be live on the slot.
      env: { ...process.env, [RUN_CLAIM_ENV]: '' },
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  );
  foreignRuns.push(child);

  const runId = await new Promise<string>((resolve) => {
    child.stdout.once('data', (chunk: Buffer) => {
      resolve(chunk.toString('utf8').trim());
    });
  });

  return {
    runId,
    release: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        child.stdin.write('go\n');
      }),
  };
}

let foreignRuns: ChildProcessByStdio<Writable, Readable, null>[] = [];

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-'));
  registryDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-claims-'));
  foreignRuns = [];
  // The invocation running this suite is itself a registered run, and it stamps
  // its run directory into the environment. Left in place, the bring-up records
  // its compose project against the machine-wide record of that run, and
  // `registerRun` below adopts it instead of registering in the scratch
  // registry.
  vi.stubEnv(RUN_CLAIM_ENV, '');
});

afterEach(() => {
  // Ahead of the kill and the removals, because one that throws would otherwise
  // skip it. The runner restores stubs before each test and never after the last
  // one, so the claim this file blanks in setup outlives the file without this.
  vi.unstubAllEnvs();
  for (const child of foreignRuns) child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

describe('ensureStack', () => {
  it('regenerates env files always (cheap, sub-100ms)', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.generateEnvFiles).toHaveBeenCalledWith(workDir);
  });

  it('runs installDeps when pnpm-lock fingerprint differs from cached', async () => {
    const deps = makeDeps({
      computeDepsFingerprint: vi.fn().mockResolvedValue('new-fp'),
      readDepsHash: vi.fn().mockResolvedValue('old-fp'),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.installDeps).toHaveBeenCalledWith(workDir);
    expect(deps.writeDepsHash).toHaveBeenCalledWith(expect.any(String), 'new-fp');
  });

  it('skips installDeps when fingerprint matches the cached value', async () => {
    const deps = makeDeps({
      computeDepsFingerprint: vi.fn().mockResolvedValue('same-fp'),
      readDepsHash: vi.fn().mockResolvedValue('same-fp'),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.installDeps).not.toHaveBeenCalled();
    expect(deps.writeDepsHash).not.toHaveBeenCalled();
  });

  it('always ensures containers are healthy (idempotent for the helper)', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.ensureContainersHealthy).toHaveBeenCalled();
  });

  it('creates this stack own database before anything reads or migrates it', async () => {
    // A stack brought up on this cluster for the first time has no database of
    // its own: the cluster comes up with one, and every other stack's is made
    // here. Reading the meta row or migrating first would hit a database that
    // does not exist yet.
    const order: string[] = [];
    const deps = makeDeps({
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
      ensureDatabase: vi.fn(async () => {
        order.push('ensureDatabase');
      }),
      readMeta: vi.fn(async () => {
        order.push('readMeta');
        return { seedHash: '', seededAt: null, dirty: true };
      }),
      runMigrations: vi.fn(async () => {
        order.push('runMigrations');
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(order).toEqual([
      'ensureContainersHealthy',
      'ensureDatabase',
      'readMeta',
      'runMigrations',
    ]);
  });

  it('repairs the cluster authentication method before the first connection is opened', async () => {
    // The driver's pipelined connect answers an authentication request it has
    // not read, so a cluster asking for anything but a password refuses every
    // connection this bring-up goes on to make — the maintenance one included.
    const order: string[] = [];
    const deps = makeDeps({
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
      ensurePostgresAcceptsPassword: vi.fn(async () => {
        order.push('ensurePostgresAcceptsPassword');
      }),
      ensureDatabase: vi.fn(async () => {
        order.push('ensureDatabase');
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(order).toEqual([
      'ensureContainersHealthy',
      'ensurePostgresAcceptsPassword',
      'ensureDatabase',
    ]);
  });

  it('recreates the e2e data plane after the authentication repair and before the database is ensured', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      ensurePostgresAcceptsPassword: vi.fn(async () => {
        order.push('ensurePostgresAcceptsPassword');
      }),
      resetDataPlane: vi.fn(async () => {
        order.push('resetDataPlane');
      }),
      ensureDatabase: vi.fn(async () => {
        order.push('ensureDatabase');
      }),
    });

    await ensureStack(makeOptions({ stackMode: 'e2e' }), deps);

    expect(order).toEqual(['ensurePostgresAcceptsPassword', 'resetDataPlane', 'ensureDatabase']);
  });

  it.each(['development', 'test'] as const)(
    'never resets the data plane of the %s stack',
    async (stackMode) => {
      const deps = makeDeps({ resetDataPlane: vi.fn(async () => {}) });

      await ensureStack(makeOptions({ stackMode }), deps);

      expect(deps.resetDataPlane).not.toHaveBeenCalled();
    }
  );

  it('never resets a data plane for a caller that names no stack', async () => {
    const deps = makeDeps({ resetDataPlane: vi.fn(async () => {}) });

    await ensureStack(makeOptions(), deps);

    expect(deps.resetDataPlane).not.toHaveBeenCalled();
  });

  it('migrates a reset data plane without the optimistic meta read', async () => {
    const deps = makeDeps({ resetDataPlane: vi.fn(async () => {}) });

    await ensureStack(makeOptions({ stackMode: 'e2e' }), deps);

    expect(deps.readMeta).not.toHaveBeenCalled();
    expect(deps.runMigrations).toHaveBeenCalled();
  });

  it('refuses the e2e bring-up when it is handed nothing to reset the data plane with', async () => {
    const deps = makeDeps();

    await expect(ensureStack(makeOptions({ stackMode: 'e2e' }), deps)).rejects.toThrow(
      'data plane'
    );
    expect(deps.ensureDatabase).not.toHaveBeenCalled();
  });

  it('stops the bring-up when the authentication method cannot be repaired', async () => {
    const deps = makeDeps({
      ensurePostgresAcceptsPassword: vi.fn(() => Promise.reject(new Error('run pnpm db:reset'))),
    });

    await expect(ensureStack(makeOptions(), deps)).rejects.toThrow('run pnpm db:reset');
    expect(deps.ensureDatabase).not.toHaveBeenCalled();
  });

  it('creates the database on the migration hot path too, so a dropped one comes back', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(deps.ensureDatabase).toHaveBeenCalled();
  });

  it('recreates the database after a wipe has destroyed the volumes it lived on', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      composeDown: vi.fn(async () => {
        order.push('composeDown');
      }),
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
      ensureDatabase: vi.fn(async () => {
        order.push('ensureDatabase');
      }),
    });

    await ensureStack(makeOptions({ wipe: true }), deps);

    expect(order).toEqual(['composeDown', 'ensureContainersHealthy', 'ensureDatabase']);
  });

  it('runs migrations when current fingerprint differs from stored seed_hash', async () => {
    const deps = makeDeps({
      computeMigrationFingerprint: vi.fn().mockResolvedValue('mig-fp-new'),
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'old:any',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
  });

  it('records the migration fingerprint in the meta row after migrating', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.markClean).toHaveBeenCalledWith(expect.anything(), 'mig-fp');
  });

  it('provisions the admin SQL panel LOGIN role after migrating', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.provisionAdminSqlPanelRole).toHaveBeenCalledWith(deps.sqlExecutor);
  });

  it('provisions the admin SQL panel LOGIN role even on the migration hot path', async () => {
    // The migration creates the role NOLOGIN; local LOGIN provisioning is
    // dev-only and must survive a DB that was migrated by another path
    // (e.g. a bare db:migrate) — so it runs on every ensure, not only when
    // migrations do.
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(deps.provisionAdminSqlPanelRole).toHaveBeenCalledWith(deps.sqlExecutor);
  });

  it('does not rewrite the meta row on the hot path', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.markClean).not.toHaveBeenCalled();
  });

  it('treats a stored legacy composed hash (mig-fp:seed-fp) as current', async () => {
    // Local DBs written before the seed phase was retired store
    // "<migrationFp>:<seedFp>" in seed_hash; the migration portion still
    // gates the skip.
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp:seed-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).not.toHaveBeenCalled();
  });

  it('--wipe runs composeDown -v before everything else', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      composeDown: vi.fn(async () => {
        order.push('composeDown');
      }),
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
    });
    await ensureStack(makeOptions({ wipe: true }), deps);
    expect(deps.composeDown).toHaveBeenCalledWith(workDir, { volumes: true });
    expect(order.indexOf('composeDown')).toBeLessThan(order.indexOf('ensureContainersHealthy'));
  });

  it('--wipe migrates even when the meta row is current', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions({ wipe: true }), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
    expect(deps.markClean).toHaveBeenCalledWith(expect.anything(), 'mig-fp');
  });

  it('installs dev-only tracking after migrations on a cold path (seededAt=null)', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      runMigrations: vi.fn(async () => {
        order.push('runMigrations');
      }),
      installDevTracking: vi.fn(async () => {
        order.push('installDevTracking');
      }),
      markClean: vi.fn(async () => {
        order.push('markClean');
      }),
      readMeta: vi.fn(async () => {
        order.push('readMeta');
        return { seedHash: '', seededAt: null, dirty: true };
      }),
    });
    await ensureStack(makeOptions(), deps);
    // Optimistic readMeta first (probe). Cold path detects seededAt=null →
    // runMigrations + installDevTracking (creates the meta row) → markClean
    // records the applied migration fingerprint.
    expect(order).toEqual(['readMeta', 'runMigrations', 'installDevTracking', 'markClean']);
  });

  it('skips runMigrations and installDevTracking on the hot path (migration fingerprint matches)', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(deps.installDevTracking).not.toHaveBeenCalled();
  });

  it('compares the database against the recorded schema before skipping the migration', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
      assertNoSchemaDrift: vi.fn(async () => {
        order.push('assertNoSchemaDrift');
      }),
      provisionAdminSqlPanelRole: vi.fn(async () => {
        order.push('provisionAdminSqlPanelRole');
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(order).toEqual(['assertNoSchemaDrift', 'provisionAdminSqlPanelRole']);
  });

  it('refuses the bring-up when the database the fingerprint accepted has drifted', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
      assertNoSchemaDrift: vi.fn(async () => {
        throw new Error('Schema drift: view growth_daily: the migrations record it');
      }),
    });
    await expect(ensureStack(makeOptions(), deps)).rejects.toThrow(/growth_daily/);
  });

  it('leaves the comparison to the migration on the path that migrates', async () => {
    // `pnpm db:migrate` ends in the same comparison, so running it again here
    // would be a second reading of a database the first one just settled.
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
    expect(deps.assertNoSchemaDrift).not.toHaveBeenCalled();
  });

  it('still runs migrations when the stored migration fingerprint differs', async () => {
    const deps = makeDeps({
      computeMigrationFingerprint: vi.fn().mockResolvedValue('new-mig-fp'),
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'old-mig-fp:seed-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
    expect(deps.installDevTracking).toHaveBeenCalled();
  });

  it('falls through to migrate when readMeta throws (table not yet created)', async () => {
    const deps = makeDeps({
      readMeta: vi
        .fn()
        .mockRejectedValueOnce(new Error('__stack_meta does not exist'))
        .mockResolvedValue({ seedHash: '', seededAt: null, dirty: true }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
    expect(deps.installDevTracking).toHaveBeenCalled();
  });

  it('stringifies non-Error readMeta failures in the fall-through warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      readMeta: vi
        .fn()
        .mockRejectedValueOnce('connection refused')
        .mockResolvedValue({ seedHash: '', seededAt: null, dirty: true }),
    });
    await ensureStack(makeOptions(), deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    warnSpy.mockRestore();
  });

  it('builds the vitest clone-source template from the same migration fingerprint', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.ensureTestTemplate).toHaveBeenCalledWith('mig-fp');
  });

  it('builds the clone-source template after the containers are up and the schema is current', async () => {
    // The build issues DDL and runs db:migrate/db:seed against the cluster, so
    // it cannot precede the healthcheck; every consumer of the template forks
    // only after ensureStack returns, which is what removes the race.
    const order: string[] = [];
    const deps = makeDeps({
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
      runMigrations: vi.fn(async () => {
        order.push('runMigrations');
      }),
      ensureTestTemplate: vi.fn(async () => {
        order.push('ensureTestTemplate');
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(order).toEqual(['ensureContainersHealthy', 'runMigrations', 'ensureTestTemplate']);
  });

  it('names the clone-source template step before entering it', async () => {
    // The build captures its child output, so a rebuild is a multi-minute
    // silence in a command whose every other step streams.
    const reportProgress = vi.fn();
    let narration: unknown;
    const deps = makeDeps({
      reportProgress,
      ensureTestTemplate: vi.fn(async () => {
        narration = reportProgress.mock.calls[0]?.[0];
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(narration).toContain('clone-source template');
  });

  it('starts the idle daemon at the end (after all other work)', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      markClean: vi.fn(async () => {
        order.push('markClean');
      }),
      ensureDaemonRunning: vi.fn(async () => {
        order.push('ensureDaemonRunning');
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(order.indexOf('ensureDaemonRunning')).toBeGreaterThan(order.indexOf('markClean'));
  });

  it('creates the per-slot cache directory on first run', async () => {
    const deps = makeDeps();
    const options = makeOptions();
    await ensureStack(options, deps);
    const expectedDir = path.join(workDir, 'scripts', '.cache', 'local', String(SLOT));
    const stat = await import('node:fs/promises').then((m) => m.stat(expectedDir));
    expect(stat.isDirectory()).toBe(true);
  });

  it('passes the right port/slot/cacheDir to ensureDaemonRunning', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    const callArgument = (deps.ensureDaemonRunning as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as
      | {
          port: number;
          slot: number;
          cacheDir: string;
        }
      | undefined;
    expect(callArgument?.port).toBe(7707);
    expect(callArgument?.slot).toBe(SLOT);
    expect(callArgument?.cacheDir).toBe(
      path.join(workDir, 'scripts', '.cache', 'local', String(SLOT))
    );
  });
});

describe('readDepsHash + writeDepsHash round-trip (file-backed defaults)', () => {
  // Smoke test for the default file-IO implementations used by ensureStack.
  it('writes a hash to <cacheDir>/deps.hash and reads it back', async () => {
    const deps = makeDeps({
      readDepsHash: vi.fn().mockImplementation(async (cacheDir: string) => {
        const file = path.join(cacheDir, 'deps.hash');
        const fsPromises = await import('node:fs/promises');
        try {
          const contents = await fsPromises.readFile(file, 'utf8');
          return contents.trim();
        } catch {
          return null;
        }
      }),
      writeDepsHash: vi.fn().mockImplementation(async (cacheDir: string, hash: string) => {
        const file = path.join(cacheDir, 'deps.hash');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(file, hash);
      }),
      computeDepsFingerprint: vi.fn().mockResolvedValue('hash-A'),
    });
    const options = makeOptions();
    await ensureStack(options, deps);
    const cacheDir = path.join(workDir, 'scripts', '.cache', 'local', String(SLOT));
    const fsPromises = await import('node:fs/promises');
    const writtenRaw = await fsPromises.readFile(path.join(cacheDir, 'deps.hash'), 'utf8');
    expect(writtenRaw.trim()).toBe('hash-A');
  });

  // Verify cache file presence ensures fingerprint comparison works.
  it('keeps installDeps callable even when the deps.hash file is missing', async () => {
    // Pre-populate a stale cache dir that's empty (simulates first run)
    const cacheDir = path.join(workDir, 'scripts', '.cache', 'local', String(SLOT));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, 'unrelated.txt'), '');
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.installDeps).toHaveBeenCalled();
  });
});

/** The two steps of the bring-up that must find the record already written. */
type OrderingHook = 'cleanupOrphans' | 'ensureContainersHealthy';

describe('the compose project ensureStack records', () => {
  /**
   * Reads the registry from inside a dependency, at the moment that dependency
   * runs, so what these cases assert is the ordering rather than the state the
   * bring-up ends in.
   */
  async function stateWhen(hook: OrderingHook): Promise<OwnershipState> {
    let seen: OwnershipState | undefined;
    const observe = async (): Promise<void> => {
      const ownership = await readOwnership(registryDir);
      seen = ownership.stateOfResource('compose-project', composeProjectName(SLOT));
    };
    const deps = makeDeps(
      hook === 'cleanupOrphans' ? { cleanupOrphans: observe } : { ensureContainersHealthy: observe }
    );

    await registerRun(
      { command: 'pnpm dev', mode: 'development', slot: SLOT, gitCommonDir: workDir, registryDir },
      () => ensureStack(makeOptions(), deps)
    );

    if (seen === undefined) throw new Error(`ensureStack never reached ${hook}`);
    return seen;
  }

  it('records it before the orphan cleanup can tear a project down', async () => {
    await expect(stateWhen('cleanupOrphans')).resolves.toBe('owned-live');
  });

  it('records it before the bring-up brings a project into existence', async () => {
    await expect(stateWhen('ensureContainersHealthy')).resolves.toBe('owned-live');
  });
});

describe('the world audit ensureStack ends on', () => {
  it('runs last, so it classifies the stack the command is about to use', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      ensureDaemonRunning: vi.fn(async () => {
        order.push('ensureDaemonRunning');
      }),
      auditStackWorld: vi.fn(async () => {
        order.push('auditStackWorld');
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(order).toEqual(['ensureDaemonRunning', 'auditStackWorld']);
  });

  it('audits the checkout the stack was ensured for', async () => {
    const deps = makeDeps();

    await ensureStack(makeOptions(), deps);

    expect(deps.auditStackWorld).toHaveBeenCalledWith(workDir);
  });
});

describe('the critical section ensureStack runs inside', () => {
  it('holds a claim for the whole run, so no step is exposed to a second caller', async () => {
    let heldDuringAStep: boolean | null = null;
    const deps = makeDeps({
      runMigrations: vi.fn(async () => {
        const probe = await tryLock(sectionLock());
        heldDuringAStep = probe.held;
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(heldDuringAStep).toBe(true);
  });

  it('releases the claim once the run ends, so the next caller is not queued behind it', async () => {
    await ensureStack(makeOptions(), makeDeps());

    expect(existsSync(sectionLock())).toBe(true);
    expect(await heldNow()).toBe(false);
  });

  it('releases the claim when a step throws, so a failed run blocks nobody', async () => {
    const deps = makeDeps({
      runMigrations: vi.fn(() => Promise.reject(new Error('migrate blew up'))),
    });

    await expect(ensureStack(makeOptions(), deps)).rejects.toThrow('migrate blew up');
    expect(existsSync(sectionLock())).toBe(true);
    expect(await heldNow()).toBe(false);
  });

  it('names itself in the claim, so whoever queues behind it knows what to wait for', async () => {
    let holder: string | null = null;
    const deps = makeDeps({
      runMigrations: vi.fn(async () => {
        const probe = await tryLock(sectionLock());
        holder = probe.holder;
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(holder).toContain('ensure-stack');
    expect(holder).toContain(String(SLOT));
  });

  it('runs a nested call inside the claim it already holds rather than taking a second one', async () => {
    // A second claim from the same process meets its own lock, which `wait`
    // never escapes: nothing will release it. Without the pass-down this test
    // does not fail, it hangs.
    const inner = makeDeps();
    const outer = makeDeps({
      runMigrations: vi.fn(async () => {
        await ensureStack(makeOptions(), inner);
      }),
    });

    await ensureStack(makeOptions(), outer);

    expect(inner.ensureContainersHealthy).toHaveBeenCalled();
  });
});

describe('the wipe refusal', () => {
  it('refuses when another run is live on the slot, naming it', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    try {
      await expect(ensureStack(makeOptions({ wipe: true }), makeDeps())).rejects.toThrow(
        'pnpm test:pkg'
      );
    } finally {
      await other.release();
    }
  });

  it('does not wipe while another run is live on the slot', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    const deps = makeDeps();
    try {
      await expect(ensureStack(makeOptions({ wipe: true }), deps)).rejects.toThrow();
    } finally {
      await other.release();
    }
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('wipes when the only claims on the slot belong to runs that have died', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    await other.release();
    const deps = makeDeps();

    await ensureStack(makeOptions({ wipe: true }), deps);

    expect(deps.composeDown).toHaveBeenCalledWith(workDir, { volumes: true });
  });

  it('ignores this run’s own claim, so a wipe is not blocked by its own caller', async () => {
    const deps = makeDeps();

    await registerRun(
      {
        command: 'pnpm db:reset',
        mode: 'development',
        slot: SLOT,
        gitCommonDir: workDir,
        registryDir,
      },
      () => ensureStack(makeOptions({ wipe: true }), deps)
    );

    expect(deps.composeDown).toHaveBeenCalledWith(workDir, { volumes: true });
  });

  it('names every live run when more than one is in the way', async () => {
    const one = await startForeignRun('pnpm test:pkg');
    const two = await startForeignRun('pnpm e2e');
    try {
      // Named without ordering: the registry is a directory of runs, so which
      // of two live claims is read first is not a property of anything.
      const failure = await ensureStack(makeOptions({ wipe: true }), makeDeps()).then(
        () => 'the wipe was not refused at all',
        String
      );

      expect(failure).toContain('pnpm test:pkg');
      expect(failure).toContain('pnpm e2e');
      expect(failure).toContain('are still running');
    } finally {
      await one.release();
      await two.release();
    }
  });

  it('wipes for a caller that belongs to no run at all, rather than failing on the absent claim', async () => {
    // Nothing guarantees a wipe is invoked from inside a registered run: the
    // variable naming one is simply not there, and asking which run owns the
    // slot has to answer "none" rather than throw on it.
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.stubEnv requires a value; undefined unsets the var
    vi.stubEnv(RUN_CLAIM_ENV, undefined);
    const deps = makeDeps();

    await ensureStack(makeOptions({ wipe: true }), deps);

    expect(deps.composeDown).toHaveBeenCalledWith(workDir, { volumes: true });
  });

  it('leaves a run without --wipe alone, however many others are live on the slot', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    const deps = makeDeps();
    try {
      await ensureStack(makeOptions(), deps);
    } finally {
      await other.release();
    }
    expect(deps.ensureContainersHealthy).toHaveBeenCalled();
  });

  /**
   * A record a wider checkout wrote is invalid to a narrower reader, so this
   * needs no corruption and no crash: two checkouts of different ages on one
   * machine reach it in ordinary use. The run behind it is alive — its lock
   * says so — and its record is the only thing that would have said which slot
   * it is on, so nothing rules it off this one.
   */
  function damageRecordOf(run: ForeignRun): void {
    const record = path.join(registryDir, run.runId, 'run.json');
    const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
    writeFileSync(
      record,
      JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
    );
  }

  it('refuses when a live run’s record could not be read, naming the run to go and look at', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    damageRecordOf(other);
    try {
      await expect(ensureStack(makeOptions({ wipe: true }), makeDeps())).rejects.toThrow(
        other.runId
      );
    } finally {
      await other.release();
    }
  });

  it('does not wipe while a live run’s record could not be read', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    damageRecordOf(other);
    const deps = makeDeps();
    try {
      await expect(ensureStack(makeOptions({ wipe: true }), deps)).rejects.toThrow();
    } finally {
      await other.release();
    }
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('wipes once the run behind an unreadable record has gone, the lock being the predicate', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    damageRecordOf(other);
    await other.release();
    const deps = makeDeps();

    await ensureStack(makeOptions({ wipe: true }), deps);

    expect(deps.composeDown).toHaveBeenCalledWith(workDir, { volumes: true });
  });

  it('leaves a run without --wipe alone, unreadable record or not', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    damageRecordOf(other);
    const deps = makeDeps();
    try {
      await ensureStack(makeOptions(), deps);
    } finally {
      await other.release();
    }
    expect(deps.ensureContainersHealthy).toHaveBeenCalled();
  });
});

describe('the files the compose services themselves read', () => {
  it('are regenerated before the containers that mount them are brought up', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      generateComposeFiles: vi.fn(() => {
        order.push('generateComposeFiles');
        return [];
      }),
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
    });

    await ensureStack(makeOptions(), deps);

    expect(order).toEqual(['generateComposeFiles', 'ensureContainersHealthy']);
  });

  it('are regenerated for the checkout the stack was ensured for', async () => {
    const deps = makeDeps();

    await ensureStack(makeOptions(), deps);

    expect(deps.generateComposeFiles).toHaveBeenCalledWith(workDir);
  });

  it('hand the services whose file changed to the bring-up, so a new value reaches the container', async () => {
    // A mounted file sits outside the configuration hash compose recreates on,
    // and the service reads it once at boot, so a rewrite the bring-up never
    // hears about is a value that lands on disk and nowhere else.
    const deps = makeDeps({ generateComposeFiles: vi.fn(() => ['a-service']) });

    await ensureStack(makeOptions(), deps);

    expect(deps.ensureContainersHealthy).toHaveBeenCalledWith(workDir, ['a-service']);
  });

  it('hand the bring-up nothing to recreate when no mounted file changed', async () => {
    const deps = makeDeps({ generateComposeFiles: vi.fn(() => []) });

    await ensureStack(makeOptions(), deps);

    expect(deps.ensureContainersHealthy).toHaveBeenCalledWith(workDir, []);
  });
});
