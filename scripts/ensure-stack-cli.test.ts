import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execa } from 'execa';
import { spawn } from 'node:child_process';
import { chmodSync, statSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envConfig } from '@hushbox/shared/env.config';
import { HELD_CLAIMS_ENV } from './lib/claims/claim.js';
import {
  RUN_CLAIM_ENV,
  addResource,
  addSpawnedProcess,
  readSlotLiveness,
  registerRun,
} from './lib/claims/registry.js';
import { currentRunId } from './lib/claims/ownership.js';
import { SIGNAL_REACTION_BUDGET_MS, untilObserved } from './lib/bounded-wait.setup.js';
import {
  groupIsAlive,
  probeLifelineSocket,
  reclaimLifelineSockets,
  socketRemovalWasRefused,
} from './lib/spawn/long-lived.js';
import {
  COMMAND_LINE,
  assertE2eBandFree,
  assertLocalSqlProvisionTarget,
  buildOptions,
  dataPlaneTargetsFor,
  parseCliArgs,
  prepareE2eRamRoot,
  reclaimOrphanedProcessGroups,
  reclaimStrandedLifelineSockets,
  selectedEnvMode,
  withEnsureStackClaim,
} from './ensure-stack-cli.js';
import { ENV_MODE_VARIABLE, envModeForStack } from './lib/stack/stack-mode.js';
import { resolveLocalWorkerCount } from './lib/playwright/worker-count.js';
import { canonicalPath } from './lib/canonical-path.js';
import {
  RAM_ROOT_OWNER_FILE,
  TMPFS_MAGIC,
  e2eRamPaths,
  ramRootRequiredBytes,
  type RamRootHost,
  type ReadStatfs,
} from './lib/stack/ram-root.js';
import { generatedValue } from './generate-env.js';
import { mediaBucketName } from './lib/stack/stack-bucket.js';
import { stackDatabaseName } from './lib/stack/stack-database.js';
import { portsFor } from './lib/stack/port-plan.js';
import { tokenFor } from './lib/stack/srh-tokens.js';
import { wranglerPersistPath } from './wrangler-dev.js';
import type { VariableConfig } from '@hushbox/shared/env.config';
import type { DataPlaneTargets } from './lib/stack/data-plane-reset.js';
import type { StackMode } from './lib/stack/port-plan.js';
import type { Server } from 'node:net';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CLI = path.join(SCRIPTS_DIR, 'ensure-stack-cli.ts');
const DEV_VARS = path.join(REPO_ROOT, 'apps', 'api', '.dev.vars');

function mtimeMsOrNull(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  return statSync(filePath).mtimeMs;
}

describe('the arguments the bring-up takes', () => {
  it('reads the stack the caller named', () => {
    expect(parseCliArgs(['--env-mode', 'e2e']).envMode).toBe('e2e');
  });

  it('reads the stack the caller named through an equals sign', () => {
    expect(parseCliArgs(['--env-mode=e2e']).envMode).toBe('e2e');
  });

  it('names no stack when the line names none, leaving the environment to answer', () => {
    expect(parseCliArgs([]).envMode).toBeUndefined();
  });

  it('reads each switch the bring-up defines', () => {
    const args = parseCliArgs(['--wipe', '--quiet']);
    expect([args.wipe, args.quiet]).toEqual([true, true]);
  });

  it('refuses --pristine, a switch it does not define', () => {
    expect(() => parseCliArgs(['--pristine'])).toThrow(/--pristine/);
  });

  it('refuses a misspelling of a switch it defines rather than bringing the stack up', () => {
    expect(() => parseCliArgs(['--wip'])).toThrow(/--wip/);
  });

  it('refuses a stack selection left without a value', () => {
    expect(() => parseCliArgs(['--env-mode'])).toThrow(/--env-mode/);
  });

  it('answers a usage request without selecting anything to do', () => {
    const args = parseCliArgs(['--help']);
    expect([args.help, args.wipe]).toEqual([true, false]);
  });

  it('names the bring-up in its usage', () => {
    expect(COMMAND_LINE.command).toBe('pnpm ensure-stack');
  });
});

/**
 * The bring-up prepares whichever stack it resolves, so resolving the default
 * one while the chain around it names another prepares a stack nobody then
 * runs against — and, for `--wipe`, empties one nobody asked about.
 */
describe('the stack the bring-up prepares', () => {
  it('is the one the caller named, over any the environment names', () => {
    expect(
      selectedEnvMode(parseCliArgs(['--env-mode', 'e2e']).envMode, {
        [ENV_MODE_VARIABLE]: 'test',
      })
    ).toBe('e2e');
  });

  it('is the one the environment names when the line names none', () => {
    expect(selectedEnvMode(parseCliArgs([]).envMode, { [ENV_MODE_VARIABLE]: 'test' })).toBe('test');
  });

  it('is the default stack when neither names one', () => {
    expect(selectedEnvMode(parseCliArgs([]).envMode, {})).toBe('development');
  });

  it('refuses an environment naming no stack rather than preparing the default one', () => {
    expect(() => selectedEnvMode(undefined, { [ENV_MODE_VARIABLE]: 'staging' })).toThrow(
      ENV_MODE_VARIABLE
    );
  });
});

/**
 * What the e2e bring-up empties, read off the environment that bring-up loads.
 * Each stack's values come from the single sources its generated files are
 * written from, so a resolver reading the wrong variable, or a stack's
 * derivation drifting onto another's, shows here without a store being touched.
 */
describe('the data plane the e2e bring-up recreates', () => {
  const TARGETS = [
    'databaseName',
    'redisToken',
    'bucket',
    'persistRoot',
  ] as const satisfies readonly (keyof DataPlaneTargets)[];
  const others: readonly StackMode[] = ['development', 'test'];

  /** The stores a stack owns, from the derivations its env files and its launcher use. */
  function ownedBy(stackMode: StackMode): DataPlaneTargets {
    return {
      databaseName: stackDatabaseName(stackMode),
      redisToken: tokenFor(envModeForStack(stackMode)),
      bucket: mediaBucketName(stackMode),
      persistRoot: wranglerPersistPath(stackMode),
    };
  }

  /**
   * What the env generator writes for a stack's data-plane variables. No port
   * appears in a data-plane name, so any slot's ports resolve the same names.
   */
  function loadedEnvironmentOf(stackMode: StackMode): NodeJS.ProcessEnv {
    const mode = envModeForStack(stackMode);
    const ports = portsFor({ slot: 0, mode: stackMode });
    const generated = (config: VariableConfig): string | undefined =>
      generatedValue(config, mode, ports, (name) => {
        throw new Error(`${name} is a secret, which no local stack's data plane is named by`);
      }) ?? undefined;
    return {
      DATABASE_URL: generated(envConfig.DATABASE_URL),
      UPSTASH_REDIS_REST_TOKEN: generated(envConfig.UPSTASH_REDIS_REST_TOKEN),
      R2_BUCKET_MEDIA: generated(envConfig.R2_BUCKET_MEDIA),
    };
  }

  /** Fails when any one resolved target is the other stack's, whatever the rest resolve to. */
  function expectNamesNoStoreOf(resolved: DataPlaneTargets, other: StackMode): void {
    const owned = ownedBy(other);
    for (const target of TARGETS) {
      expect(resolved[target], target).not.toBe(owned[target]);
    }
  }

  const resolved = dataPlaneTargetsFor('e2e', loadedEnvironmentOf('e2e'));

  // The shared config's `mockReset` alone leaves a getter spy on
  // `process.platform` answering undefined for every later case in this file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(TARGETS)('resolves %s to the one the e2e stack owns', (target) => {
    expect(resolved[target]).toBe(ownedBy('e2e')[target]);
  });

  it.each(others)('names no store the %s stack owns', (other) => {
    expectNamesNoStoreOf(resolved, other);
  });

  it.each(others.flatMap((other) => TARGETS.map((target) => [other, target] as const)))(
    "is caught naming the %s stack's %s",
    (other, target) => {
      const leaked: DataPlaneTargets = { ...resolved, [target]: ownedBy(other)[target] };

      expect(() => {
        expectNamesNoStoreOf(leaked, other);
      }).toThrow();
    }
  );

  it('refuses an environment that names no Redis token', () => {
    const withoutToken = { ...loadedEnvironmentOf('e2e'), UPSTASH_REDIS_REST_TOKEN: undefined };

    expect(() => dataPlaneTargetsFor('e2e', withoutToken)).toThrow('UPSTASH_REDIS_REST_TOKEN');
  });

  it("hands the RAM root's browser temporary directory to the e2e stack's reset alone", () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const stacks: readonly StackMode[] = ['development', 'test', 'e2e'];
    const e2eBrowserDirectory = e2eRamPaths()?.browserTmp;

    const handed = stacks.map(
      (stackMode) => dataPlaneTargetsFor(stackMode, loadedEnvironmentOf(stackMode)).browserTmp
    );

    expect(e2eBrowserDirectory).toEqual(expect.any(String));
    expect(handed).toEqual([undefined, undefined, e2eBrowserDirectory]);
  });
});

describe('ensure-stack-cli CI behavior', () => {
  // The CLI must not touch env files when CI is set. The workflow's
  // generate:env step has already written CI-mode env files; a regen here
  // would overwrite them with Mode.Development values and drop the
  // GitHub-secret bindings the tests rely on.
  it('exits cleanly without rewriting apps/api/.dev.vars when CI=1', async () => {
    if (!existsSync(DEV_VARS)) {
      writeFileSync(DEV_VARS, '# placeholder for ensure-stack-cli.test\n');
    }
    const before = mtimeMsOrNull(DEV_VARS);

    const result = await execa('tsx', [CLI], {
      env: { ...process.env, CI: '1' },
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('CI no-op');
    const after = mtimeMsOrNull(DEV_VARS);
    expect(after).toBe(before);
  }, 30_000);
});

describe('buildOptions HB_STACK_SLOT validation', () => {
  const originalSlot = process.env['HB_STACK_SLOT'];
  const originalPort = process.env['HB_IDLE_DAEMON_PORT'];

  beforeEach(() => {
    // Satisfy the validation that follows the slot guard so the tests fail
    // (or pass) on the slot behavior alone.
    process.env['HB_IDLE_DAEMON_PORT'] = '8787';
  });

  afterEach(() => {
    if (originalSlot === undefined) delete process.env['HB_STACK_SLOT'];
    else process.env['HB_STACK_SLOT'] = originalSlot;
    if (originalPort === undefined) delete process.env['HB_IDLE_DAEMON_PORT'];
    else process.env['HB_IDLE_DAEMON_PORT'] = originalPort;
  });

  // Absence used to resolve to slot 0 on the reasoning that slot 0 was the
  // main checkout's. Slots are claimed now, so slot 0 is whoever claimed it —
  // and this is the value the wipe refusal queries live claims on.
  it('refuses an absent HB_STACK_SLOT rather than acting on whichever checkout holds slot 0', () => {
    delete process.env['HB_STACK_SLOT'];

    expect(() => buildOptions({ wipe: false }, 'development')).toThrow('HB_STACK_SLOT');
  });

  it('reads the slot the generator wrote', () => {
    process.env['HB_STACK_SLOT'] = '12';

    expect(buildOptions({ wipe: false }, 'development').slot).toBe(12);
  });

  it('carries the stack it is preparing, which decides whether its data plane is recreated', () => {
    process.env['HB_STACK_SLOT'] = '12';

    expect(buildOptions({ wipe: false }, 'e2e').stackMode).toBe('e2e');
  });

  it.each(['', '   ', '1.5', '-1'])('throws when HB_STACK_SLOT is %j', (value) => {
    process.env['HB_STACK_SLOT'] = value;

    expect(() => buildOptions({ wipe: false }, 'development')).toThrow('HB_STACK_SLOT');
  });
});

describe('assertLocalSqlProvisionTarget', () => {
  it('admits loopback database hosts', () => {
    expect(() => {
      assertLocalSqlProvisionTarget('postgres://user:pw@localhost:4444/hushbox');
    }).not.toThrow();
    expect(() => {
      assertLocalSqlProvisionTarget('postgres://user:pw@127.0.0.1:5432/hushbox');
    }).not.toThrow();
  });

  it('refuses a non-local database host (cannot run against production)', () => {
    expect(() => {
      assertLocalSqlProvisionTarget('postgres://user:pw@ep-prod.neon.tech/hushbox');
    }).toThrow(/local/);
  });

  it('refuses an unparseable database url', () => {
    expect(() => {
      assertLocalSqlProvisionTarget('not-a-url');
    }).toThrow();
  });
});

describe('the run claim ensure-stack registers for itself', () => {
  // `pnpm ensure-stack` and `pnpm db:reset` are the two root scripts that
  // never pass through `with-env.ts`, so without this registration the stack
  // they prepare and wipe is one nothing on the machine can see a run against.
  const SLOT = 41;
  let registryDir = '';

  beforeEach(() => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-cli-claims-'));
    vi.stubEnv('HB_STACK_SLOT', String(SLOT));
    // Cleared so the fallback name is what the claim carries, rather than the
    // pnpm script this test suite happens to be running under.
    vi.stubEnv('npm_lifecycle_event', '');
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('is live on the stack slot for as long as the work runs', async () => {
    vi.stubEnv(RUN_CLAIM_ENV, '');

    const live = await withEnsureStackClaim(
      'development',
      async () => {
        const { claimed } = await readSlotLiveness(SLOT, registryDir);
        return claimed;
      },
      registryDir
    );

    expect(live.map((claim) => claim.command)).toEqual(['ensure-stack']);
  });

  it('adopts the run it was launched inside rather than registering a second', async () => {
    vi.stubEnv(RUN_CLAIM_ENV, path.join(registryDir, 'a-run-of-someone-else'));

    const live = await withEnsureStackClaim(
      'development',
      async () => {
        const { claimed } = await readSlotLiveness(SLOT, registryDir);
        return claimed;
      },
      registryDir
    );

    expect(live).toEqual([]);
  });
});

describe('the slot the run registers on and the slot the wipe refusal queries', () => {
  // The destructive guard is a pair: the claim registers the run at the
  // wrapper's answer, and the refusal looks for live claims at `buildOptions`'s.
  // Two readers is how those drift, and a drift is a wipe that finds nothing
  // live on the slot it asked about and stops refusing.
  const SLOT = 37;
  let registryDir = '';

  beforeEach(() => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-cli-slot-'));
    vi.stubEnv('HB_IDLE_DAEMON_PORT', '8787');
    vi.stubEnv('npm_lifecycle_event', '');
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('resolves one slot for one environment, so the wipe sees the run that is live', async () => {
    vi.stubEnv('HB_STACK_SLOT', String(SLOT));

    const queried = buildOptions({ wipe: true }, 'development').slot;
    const live = await withEnsureStackClaim(
      'development',
      async () => {
        const { claimed } = await readSlotLiveness(queried, registryDir);
        return claimed;
      },
      registryDir
    );

    expect(live.map((claim) => claim.command)).toEqual(['ensure-stack']);
  });

  it('leaves slot 0 alone when the claim gave this checkout another', async () => {
    vi.stubEnv('HB_STACK_SLOT', String(SLOT));

    expect(buildOptions({ wipe: true }, 'development').slot).toBe(SLOT);
    const onZero = await withEnsureStackClaim(
      'development',
      async () => {
        const { claimed } = await readSlotLiveness(0, registryDir);
        return claimed;
      },
      registryDir
    );

    expect(onZero).toEqual([]);
  });

  it('refuses on both halves when nothing names the slot', async () => {
    // Removed rather than blanked: an empty value is the separate
    // misconfiguration case, and what this asserts is the absent one.
    delete process.env['HB_STACK_SLOT'];

    expect(() => buildOptions({ wipe: true }, 'development')).toThrow('HB_STACK_SLOT');
    await expect(
      withEnsureStackClaim('development', () => Promise.resolve(), registryDir)
    ).rejects.toThrow('HB_STACK_SLOT');
  });
});

/**
 * What used to happen here was a blind reclaim of every host-bound port of the
 * checkout — a live `pnpm dev` and the idle daemon's own sentinel included.
 * The bands are disjoint now, so the only run that can be in the way is
 * another e2e one, and the answer to that is its name rather than a signal.
 */
describe('preparing the e2e stack while another run holds its band', () => {
  const SLOT = 44;
  const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');
  let registryDir = '';

  beforeEach(() => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-cli-e2e-'));
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(registryDir, { recursive: true, force: true });
  });

  function run<T>(
    init: { command: string; mode: 'development' | 'e2e' },
    body: () => Promise<T>
  ): Promise<T> {
    return registerRun(
      { command: init.command, mode: init.mode, slot: SLOT, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  /**
   * Makes the enclosing run's record unreadable to this checkout, in the form
   * that needs no corruption: a record a wider checkout wrote names a mode this
   * one has never heard of, so the reader rejects it while the run behind it
   * goes on holding its lock.
   */
  async function damageOwnRecord(): Promise<string> {
    const runDir = process.env[RUN_CLAIM_ENV] ?? '';
    const record = path.join(runDir, 'run.json');
    const written: unknown = JSON.parse(await readFile(record, 'utf8'));
    await writeFile(
      record,
      JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
    );
    return path.basename(runDir);
  }

  it('refuses, naming the run that holds the band', async () => {
    await run({ command: 'pnpm e2e', mode: 'e2e' }, async () => {
      const liveness = await readSlotLiveness(SLOT, registryDir);

      expect(() => {
        assertE2eBandFree(SLOT, liveness, null);
      }).toThrow(/pnpm e2e/);
    });
  });

  it('refuses on a live run whose record could not be read, which may be the band’s holder', async () => {
    await run({ command: 'pnpm e2e', mode: 'e2e' }, async () => {
      const runId = await damageOwnRecord();
      const liveness = await readSlotLiveness(SLOT, registryDir);

      expect(() => {
        assertE2eBandFree(SLOT, liveness, null);
      }).toThrow(runId);
    });
  });

  it('is not refused by its own claim, unreadable record or not', async () => {
    await run({ command: 'pnpm e2e', mode: 'e2e' }, async () => {
      const own = currentRunId();
      await damageOwnRecord();
      const liveness = await readSlotLiveness(SLOT, registryDir);

      expect(() => {
        assertE2eBandFree(SLOT, liveness, own);
      }).not.toThrow();
    });
  });

  it('names every holder when more than one is live on the band', async () => {
    await run({ command: 'pnpm e2e', mode: 'e2e' }, async () => {
      // A second registration needs an empty claim variable: a process that
      // inherited one adopts that run instead of taking a second.
      vi.stubEnv(RUN_CLAIM_ENV, '');
      await run({ command: 'pnpm e2e:quick', mode: 'e2e' }, async () => {
        const liveness = await readSlotLiveness(SLOT, registryDir);
        const refuse = (): void => {
          assertE2eBandFree(SLOT, liveness, null);
        };

        // Each holder asserted on its own rather than as one ordered pattern.
        // A claim's place in the list is the order `readdir` gave the registry
        // directory, whose entries are named by a random id, so which holder
        // the message names first is the filesystem's answer and not a promise
        // this makes. Nothing reads that order: the destructive question goes
        // through `readOwnership`, which indexes expired claims before live
        // ones instead of trusting the enumeration.
        expect(refuse).toThrow('`pnpm e2e`');
        expect(refuse).toThrow('`pnpm e2e:quick`');
        expect(refuse).toThrow('are still running');
      });
    });
  });

  it('is not refused by its own claim', async () => {
    await run({ command: 'pnpm e2e', mode: 'e2e' }, async () => {
      const liveness = await readSlotLiveness(SLOT, registryDir);

      expect(() => {
        assertE2eBandFree(SLOT, liveness, currentRunId());
      }).not.toThrow();
    });
  });

  it('is not refused by a development run on the same slot, whose band is disjoint', async () => {
    await run({ command: 'pnpm dev', mode: 'development' }, async () => {
      const liveness = await readSlotLiveness(SLOT, registryDir);

      expect(() => {
        assertE2eBandFree(SLOT, liveness, null);
      }).not.toThrow();
    });
  });

  it('proceeds when nothing is live on the slot', () => {
    expect(() => {
      assertE2eBandFree(SLOT, { claimed: [], unknown: [] }, null);
    }).not.toThrow();
  });

  it('is no obstacle once the run behind an unreadable record has gone', async () => {
    let runId = '';
    await run({ command: 'pnpm e2e', mode: 'e2e' }, async () => {
      runId = await damageOwnRecord();
    });

    const liveness = await readSlotLiveness(SLOT, registryDir);

    expect(liveness.unknown).toEqual([]);
    expect(() => {
      assertE2eBandFree(SLOT, liveness, null);
    }).not.toThrow();
    expect(runId).not.toBe('');
  });
});

describe('the RAM root the e2e bring-up prepares', () => {
  const BLOCK_SIZE = 4096;
  const MIB = 1024 * 1024;
  const required = ramRootRequiredBytes(resolveLocalWorkerCount());
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'ensure-stack-ram-'));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function linuxOn(directory: string): RamRootHost {
    return { platform: 'linux', parent: directory };
  }

  function tmpfsWithFree(freeBytes: number): ReadStatfs {
    return () =>
      Promise.resolve({ type: TMPFS_MAGIC, bsize: BLOCK_SIZE, bavail: freeBytes / BLOCK_SIZE });
  }

  it('is refused when it has less room than a run of this machine’s workers needs', async () => {
    await expect(
      prepareE2eRamRoot({ host: linuxOn(parent), statfs: tmpfsWithFree(required - BLOCK_SIZE) })
    ).rejects.toThrow(`needs ${String(required / MIB)} MiB`);
  });

  it('is made when it has the room a run of this machine’s workers needs', async () => {
    const paths = await prepareE2eRamRoot({
      host: linuxOn(parent),
      statfs: tmpfsWithFree(required),
    });
    const made = await stat(paths?.root ?? '');

    expect(made.isDirectory()).toBe(true);
  });

  it('belongs to this checkout', async () => {
    const paths = await prepareE2eRamRoot({
      host: linuxOn(parent),
      statfs: tmpfsWithFree(required),
    });

    const owner: unknown = JSON.parse(
      await readFile(path.join(paths?.root ?? '', RAM_ROOT_OWNER_FILE), 'utf8')
    );
    expect(owner).toEqual({ checkout: canonicalPath(REPO_ROOT) });
  });
});

/**
 * The socket files a run killed too hard to close its own leaves in the
 * temporary directory, and what a bring-up does about them on its way in.
 *
 * Every socket here is one the kernel made and, where a case needs something
 * behind it, one a real process is answering on: the whole reason an unclaimed
 * file may be removed is that a live one answers, so a stub standing in for the
 * listener would assert over the fixture instead of over that.
 *
 * The temporary directory is this case's own for as long as it runs, so the
 * scan the bring-up makes reads nothing else on the machine.
 */
describe('the lifeline sockets a bring-up reclaims', () => {
  const SLOT = 46;
  let registryDir = '';
  let socketDir = '';
  let printed: string[] = [];

  const log = (message: string): void => {
    printed.push(message);
  };

  /** A real listener answering at `address`, for a case that needs something behind the file. */
  async function listenOn(address: string): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  }

  /** Stops a listener this case started, and waits for it to have stopped. */
  function stopListening(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /** A socket file the kernel made and nothing answers on, at `address`. */
  async function staleSocket(address: string): Promise<string> {
    const listened = `${address}.listening`;
    const server = await listenOn(listened);
    // Renamed out from under its listener, so closing the server unlinks a name
    // nothing holds and the file it made stays where a killed process left one.
    await rename(listened, address);
    await stopListening(server);
    return address;
  }

  function runOf(overrides: { command: string }): Parameters<typeof registerRun>[0] {
    return {
      command: overrides.command,
      mode: 'development',
      slot: SLOT,
      gitCommonDir: path.join(registryDir, 'checkout', '.git'),
      registryDir,
    };
  }

  beforeEach(() => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-cli-socket-registry-'));
    socketDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-cli-socket-scratch-'));
    // What the bring-up's own scan reads: the address is built under the
    // temporary directory of whatever process asks, so a case owns the world it
    // classifies by owning that.
    vi.stubEnv('TMPDIR', socketDir);
    // The invocation running this suite is itself a registered run and
    // advertises it in the environment every child inherits, so a case calling
    // `registerRun` would adopt that run instead of registering its own.
    vi.stubEnv(RUN_CLAIM_ENV, '');
    vi.stubEnv(HELD_CLAIMS_ENV, '');
    printed = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(registryDir, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  });

  it('removes one no claim names once a connect to it is refused', async () => {
    const address = await staleSocket(path.join(socketDir, 'hb-0123456789'));

    const report = await reclaimStrandedLifelineSockets({ log, registryDir });

    expect(report).toEqual({ reclaimed: [address], live: [], unowned: [], refused: [] });
    expect(existsSync(address)).toBe(false);
  });

  it('leaves a live run’s file standing, with the process behind it still answering', async () => {
    const address = path.join(socketDir, 'hb-0123456789');
    const server = await listenOn(address);

    const report = await registerRun(runOf({ command: 'pnpm dev' }), async () => {
      await addResource({ kind: 'socket', id: address });
      return reclaimStrandedLifelineSockets({ log, registryDir });
    });

    expect(report).toEqual({ reclaimed: [], live: [address], unowned: [], refused: [] });
    await expect(probeLifelineSocket(address)).resolves.toEqual({ kind: 'answered' });
    await stopListening(server);
  });

  it('leaves one no claim names standing while a real listener answers on it', async () => {
    const address = path.join(socketDir, 'hb-abcdef0123');
    const server = await listenOn(address);

    const report = await reclaimStrandedLifelineSockets({ log, registryDir });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [address], refused: [] });
    await expect(probeLifelineSocket(address)).resolves.toEqual({ kind: 'answered' });
    await stopListening(server);
  });

  it('names what it left standing through the log the bring-up gave it', async () => {
    const address = path.join(socketDir, 'hb-abcdef0123');
    const server = await listenOn(address);

    await reclaimStrandedLifelineSockets({ log, registryDir });

    expect(printed.join('\n')).toContain(address);
    await stopListening(server);
  });

  it('says nothing at all where there is no socket file to say anything about', async () => {
    const report = await reclaimStrandedLifelineSockets({ log, registryDir });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [], refused: [] });
    expect(printed).toEqual([]);
  });

  /**
   * A socket file the operating system will not let this user unlink, made by
   * taking the write permission off the directory holding it — the refusal the
   * kernel gives is its own, not a stubbed one. The other shape of the same
   * refusal, a file another user owns under a sticky directory, needs a second
   * user to set up and is out of reach of a test that has to run anywhere.
   *
   * The directory's mode is put back before the case ends, because the teardown
   * that removes it needs the permission this took away.
   */
  async function unremovableSocket(): Promise<string> {
    const address = await staleSocket(path.join(socketDir, 'hb-0123456789'));
    chmodSync(socketDir, 0o555);
    return address;
  }

  it('carries on where the operating system refuses to let this user remove one', async () => {
    const address = await unremovableSocket();

    try {
      const report = await reclaimStrandedLifelineSockets({ log, registryDir });

      expect(report).toEqual({ reclaimed: [], live: [], unowned: [], refused: [address] });
      expect(existsSync(address)).toBe(true);
    } finally {
      chmodSync(socketDir, 0o755);
    }
  });

  it('names the one it was not permitted to remove, through the log the bring-up gave it', async () => {
    const address = await unremovableSocket();

    try {
      await reclaimStrandedLifelineSockets({ log, registryDir });

      expect(printed.join('\n')).toContain(address);
    } finally {
      chmodSync(socketDir, 0o755);
    }
  });

  it('raises where the failure is not a removal at all', async () => {
    // The scan is what fails here, and nothing in it is a removal this user was
    // refused — the tolerance is around one file's removal and reaches no
    // further, so a pass that cannot even read its directory still raises.
    const notADirectory = path.join(socketDir, 'not-a-directory');
    writeFileSync(notADirectory, '');
    vi.stubEnv('TMPDIR', notADirectory);

    await expect(reclaimStrandedLifelineSockets({ log, registryDir })).rejects.toThrow(/ENOTDIR/);
  });

  /**
   * A pass over two directories: one this user may not write, holding a file it
   * therefore may not remove, and one it may. The scan is given directly so the
   * refused file is reached first, which is the whole question — a refusal that
   * raised out of the pass would leave the file behind it unexamined, and the
   * next run would stop in the same place.
   *
   * Two directories because the refusal a test can produce is a directory's
   * permissions, which refuses every file in it alike. The per-file shape — a
   * sticky directory holding another user's file — needs a second user on the
   * machine to set up.
   */
  it('leaves the file behind a refused one reclaimed rather than unexamined', async () => {
    const refusedDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-cli-socket-refused-'));
    const refused = await staleSocket(path.join(refusedDir, 'hb-0123456789'));
    const reclaimable = await staleSocket(path.join(socketDir, 'hb-abcdef0123'));
    chmodSync(refusedDir, 0o555);

    try {
      const report = await reclaimLifelineSockets({
        scan: () => Promise.resolve([refused, reclaimable]),
        removalRefused: socketRemovalWasRefused,
        registryDir,
        log,
      });

      expect(report).toEqual({
        reclaimed: [reclaimable],
        live: [],
        unowned: [],
        refused: [refused],
      });
      expect(existsSync(refused)).toBe(true);
      expect(existsSync(reclaimable)).toBe(false);
    } finally {
      chmodSync(refusedDir, 0o755);
      rmSync(refusedDir, { recursive: true, force: true });
    }
  });
});

/**
 * The trees a bring-up reclaims, which is what makes the next ordinary command
 * the recovery for a run somebody killed. Every tree here is a real one: a case
 * that recorded a number and asserted about it would be asserting over its own
 * fixture rather than over what this pass ends.
 */
describe('the process trees a bring-up reclaims', () => {
  const SLOT = 47;
  let registryDir = '';
  let printed: string[] = [];
  let started: number[] = [];

  const log = (message: string): void => {
    printed.push(message);
  };

  /** A real detached child, leading a group of its own exactly as a spawn does. */
  function detachedGroup(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const { pid } = child;
    if (pid === undefined) throw new Error('the fixture child did not start');
    started.push(pid);
    return pid;
  }

  function runOf(command: string): Parameters<typeof registerRun>[0] {
    return {
      command,
      mode: 'development',
      slot: SLOT,
      gitCommonDir: path.join(registryDir, 'checkout', '.git'),
      registryDir,
    };
  }

  beforeEach(() => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-cli-group-registry-'));
    vi.stubEnv(RUN_CLAIM_ENV, '');
    vi.stubEnv(HELD_CLAIMS_ENV, '');
    printed = [];
    started = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const pgid of started) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // Already gone is the outcome this wanted.
      }
    }
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('ends the tree a killed run left running, and says which one it ended', async () => {
    let pgid = 0;
    await expect(
      registerRun(runOf('pnpm dev'), async () => {
        // Started inside the run, so the tree carries that run's record in its
        // environment exactly as a spawned child does — which is what the pass
        // reads before it signals anything.
        pgid = detachedGroup();
        await addSpawnedProcess({ pid: pgid, pgid });
        throw new Error('the run was killed');
      })
    ).rejects.toThrow('the run was killed');

    const report = await reclaimOrphanedProcessGroups({ log, registryDir });

    expect(report).toEqual({ reclaimed: [pgid], live: [], refused: [] });
    expect(printed.join('\n')).toContain(String(pgid));
    expect(await untilObserved(() => !groupIsAlive(pgid), SIGNAL_REACTION_BUDGET_MS)).toBe(true);
  });

  it('leaves the tree of a run that still holds its claim, and says nothing at all', async () => {
    const pgid = detachedGroup();

    const report = await registerRun(runOf('pnpm dev'), async () => {
      await addSpawnedProcess({ pid: pgid, pgid });
      return reclaimOrphanedProcessGroups({ log, registryDir });
    });

    expect(report).toEqual({ reclaimed: [], live: [pgid], refused: [] });
    expect(printed).toEqual([]);
    expect(groupIsAlive(pgid)).toBe(true);
  });

  it('carries on where the operating system refuses to let this user end one', async () => {
    let pgid = 0;
    await expect(
      registerRun(runOf('pnpm dev'), async () => {
        pgid = detachedGroup();
        await addSpawnedProcess({ pid: pgid, pgid });
        throw new Error('the run was killed');
      })
    ).rejects.toThrow('the run was killed');

    const report = await reclaimOrphanedProcessGroups({
      log,
      registryDir,
      killer: {
        platform: 'linux',
        signal: () => {
          throw Object.assign(new Error('kill: EPERM'), { code: 'EPERM' });
        },
      },
    });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [pgid] });
    expect(groupIsAlive(pgid)).toBe(true);
  });

  it('says nothing at all where no run recorded a tree', async () => {
    const report = await reclaimOrphanedProcessGroups({ log, registryDir });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [] });
    expect(printed).toEqual([]);
  });
});
