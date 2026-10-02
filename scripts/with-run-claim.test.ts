import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedEnvPaths } from './generate-env.js';
import { STACK_SLOT_VARIABLE } from './lib/stack/stack-slot.js';
import { RUN_CLAIM_ENV, readSlotLiveness } from './lib/claims/registry.js';
import { ensureStack } from './lib/stack/ensure-stack.js';
import { withRunClaim } from './with-env.js';
import {
  execStage,
  parseStages,
  readStackSlot,
  runComposite,
  runStages,
  STAGE_SEPARATOR,
} from './with-run-claim.js';
import type { EnsureStackDeps, EnsureStackOptions } from './lib/stack/ensure-stack.js';
import type { StackMode } from './lib/stack/port-plan.js';
import type { Stage, StageRunner } from './with-run-claim.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('parseStages', () => {
  it('reads a lone command as one stage', () => {
    expect(parseStages(['pnpm', 'ensure-stack'])).toEqual([
      { file: 'pnpm', args: ['ensure-stack'] },
    ]);
  });

  it('splits the stages a composite runs in order', () => {
    expect(
      parseStages(['pnpm', 'ensure-stack', STAGE_SEPARATOR, 'tsx', 'scripts/with-env.ts', 'a'])
    ).toEqual([
      { file: 'pnpm', args: ['ensure-stack'] },
      { file: 'tsx', args: ['scripts/with-env.ts', 'a'] },
    ]);
  });

  it('refuses an invocation naming no stage', () => {
    expect(() => parseStages([])).toThrow('with-run-claim');
  });

  it('refuses an empty stage, which would silently drop a half of the chain', () => {
    expect(() => parseStages(['pnpm', 'ensure-stack', STAGE_SEPARATOR])).toThrow('with-run-claim');
  });

  // The separator is a reserved word, and a caller's own argument spelling it
  // splits one stage into two: the tail becomes a stage whose command is a
  // flag. No command is named that way, so it is refused before the first
  // stage runs rather than after the expensive one has already run.
  it('refuses a stage whose command is a flag, which is a separator that split an argument list', () => {
    expect(() => parseStages(['pnpm', 'e2e:prepare', STAGE_SEPARATOR, '--retries=0'])).toThrow(
      STAGE_SEPARATOR
    );
  });
});

describe('runStages', () => {
  const first: Stage = { file: 'first', args: [] };
  const second: Stage = { file: 'second', args: [] };

  it('runs every stage in order when each one succeeds', async () => {
    const ran: string[] = [];

    const code = await runStages([first, second], (stage) => {
      ran.push(stage.file);
      return Promise.resolve(0);
    });

    expect(ran).toEqual(['first', 'second']);
    expect(code).toBe(0);
  });

  it('stops at the first failure, exactly as the conjunction it replaces did', async () => {
    const ran: string[] = [];

    const code = await runStages([first, second], (stage) => {
      ran.push(stage.file);
      return Promise.resolve(stage === first ? 3 : 0);
    });

    expect(ran).toEqual(['first']);
    expect(code).toBe(3);
  });
});

describe('readStackSlot', () => {
  let rootDir = '';

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-with-run-claim-root-'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function writeScriptsEnv(stackMode: StackMode, body: string): Promise<void> {
    await fs.writeFile(path.join(rootDir, generatedEnvPaths(stackMode).scripts), body, 'utf8');
  }

  it('reads the slot the generator wrote for the stack the command names', async () => {
    await writeScriptsEnv('development', 'HB_STACK_SLOT="7"\n');
    await writeScriptsEnv('e2e', 'HB_STACK_SLOT="7"\n');

    expect(readStackSlot(rootDir, 'e2e')).toBe(7);
  });

  // A slot belongs to the checkout, not to a mode: one checkout holds at most
  // one, and every mode's generated file carries that same number. A mode's
  // file is written only once that mode's stack has been generated, so a
  // checkout that has run `pnpm dev` but never `pnpm e2e` has no e2e file —
  // and reading only that one would leave the whole first e2e run unclaimed.
  it("reads the checkout's slot from another stack's file when the mode's own has never been written", async () => {
    await writeScriptsEnv('development', 'HB_STACK_SLOT="7"\n');

    expect(readStackSlot(rootDir, 'e2e')).toBe(7);
  });

  // The first command in a fresh checkout runs before anything has claimed a
  // slot. Nothing of this checkout's exists to be destroyed yet, so the chain
  // runs as it always did and each stage claims for itself.
  it('answers that no slot is known when the generator has not run', () => {
    expect(readStackSlot(rootDir, 'development')).toBeNull();
  });

  it('refuses a slot the generator could not have written', async () => {
    await writeScriptsEnv('development', 'HB_STACK_SLOT="-1"\n');

    expect(() => readStackSlot(rootDir, 'development')).toThrow(STACK_SLOT_VARIABLE);
  });

  it('answers that no slot is known when the file names none', async () => {
    await writeScriptsEnv('development', 'HB_IDLE_DAEMON_PORT="8787"\n');

    expect(readStackSlot(rootDir, 'development')).toBeNull();
  });

  // Absent is the fresh-checkout case and means "claim nothing yet"; anything
  // else is a checkout that cannot be read, which no chain should run over.
  it('reports a file it could not read rather than treating it as absent', async () => {
    await fs.mkdir(path.join(rootDir, generatedEnvPaths('development').scripts));

    expect(() => readStackSlot(rootDir, 'development')).toThrow();
  });
});

/**
 * Stubbed rather than assigned: the claim variable has to read empty so a
 * registration is taken rather than adopted, the slot variable is what
 * {@link runComposite} writes its answer into, and stubbing is what restores
 * both to whatever the run that hosts these tests was carrying.
 */
function isolateClaimEnvironment(): void {
  vi.stubEnv(RUN_CLAIM_ENV, '');
  vi.stubEnv(STACK_SLOT_VARIABLE, '');
}

describe('runComposite', () => {
  const SLOT = 44;
  const first: Stage = { file: 'first', args: [] };
  const second: Stage = { file: 'second', args: [] };
  let registryDir = '';

  beforeEach(async () => {
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-with-run-claim-registry-'));
    isolateClaimEnvironment();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(registryDir, { recursive: true, force: true });
  });

  function composite(stages: readonly Stage[], run: StageRunner): Promise<number> {
    return runComposite(
      { slot: SLOT, mode: 'development', rootDir: REPO_ROOT, registryDir },
      stages,
      run
    );
  }

  it('keeps one claim live on the slot across every stage', async () => {
    const seen: string[][] = [];

    await composite([first, second], async () => {
      const { claimed: live } = await readSlotLiveness(SLOT, registryDir);
      seen.push(live.map((found) => found.runId));
      return 0;
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(1);
    // The same run id in both halves is what says the claim was never released
    // and retaken: a chain of two claiming processes shows two different ones.
    expect(seen[1]).toEqual(seen[0]);
  });

  it('leaves nothing on the slot once the chain has finished', async () => {
    await composite([first], () => Promise.resolve(0));

    await expect(readSlotLiveness(SLOT, registryDir)).resolves.toEqual({
      claimed: [],
      unknown: [],
    });
  });

  it('answers the failing stage exit code from inside the claim', async () => {
    const code = await composite([first, second], (stage) =>
      Promise.resolve(stage === first ? 9 : 0)
    );

    expect(code).toBe(9);
  });

  // `pnpm e2e` runs `pnpm e2e:prepare`, which is a chain of its own. One
  // invocation is one run however many chains it nests, or the inner one takes
  // a second claim on the same slot and meets its own lock.
  it('adopts the chain it was launched inside rather than claiming again', async () => {
    const seen: string[][] = [];

    await composite([first], () =>
      composite([second], async () => {
        const { claimed: live } = await readSlotLiveness(SLOT, registryDir);
        seen.push(live.map((found) => found.runId));
        return 0;
      })
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
  });

  it('runs the chain unclaimed when no slot is known, as the conjunction did', async () => {
    const seen: string[][] = [];

    const code = await runComposite(
      { slot: null, mode: 'development', rootDir: REPO_ROOT, registryDir },
      [first],
      async () => {
        const { claimed: live } = await readSlotLiveness(SLOT, registryDir);
        seen.push(live.map((found) => found.runId));
        return 0;
      }
    );

    expect(code).toBe(0);
    expect(seen).toEqual([[]]);
  });
});

/**
 * The e2e chain of a checkout that has run `pnpm dev` or `pnpm test` and never
 * `pnpm e2e`: no e2e scripts file has been generated, and the slot is knowable
 * only from the file the development stack wrote. Read only the e2e file and
 * the whole first e2e run — the catalog refresh, the seed and the weights seed
 * — takes the unclaimed path, which is the window this wrapper exists to close.
 */
describe('a chain whose stack mode has never been generated', () => {
  const SLOT = 47;
  const first: Stage = { file: 'first', args: [] };
  const second: Stage = { file: 'second', args: [] };
  let checkoutRoot = '';
  let registryDir = '';

  beforeEach(async () => {
    checkoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-one-stack-root-'));
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-one-stack-registry-'));
    await fs.writeFile(
      path.join(checkoutRoot, generatedEnvPaths('development').scripts),
      `${STACK_SLOT_VARIABLE}="${String(SLOT)}"\n`,
      'utf8'
    );
    isolateClaimEnvironment();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(checkoutRoot, { recursive: true, force: true });
    await fs.rm(registryDir, { recursive: true, force: true });
  });

  // The slot is read from the generated file laid out above, as the entry point
  // reads it; the claim is registered against this repository, because a run
  // claim is keyed to a git checkout and a temporary directory is not one.
  it('holds the checkout claim across every stage', async () => {
    const seen: number[] = [];

    const code = await runComposite(
      { slot: readStackSlot(checkoutRoot, 'e2e'), mode: 'e2e', rootDir: REPO_ROOT, registryDir },
      [first, second],
      async () => {
        const { claimed: live } = await readSlotLiveness(SLOT, registryDir);
        seen.push(live.length);
        return 0;
      }
    );

    expect(code).toBe(0);
    expect(seen).toEqual([1, 1]);
  });
});

/**
 * The hole this file exists to close, driven rather than described: a wipe
 * arriving in the window between a chain's two halves. Before, the window
 * carried no live claim and the wipe tore down the volumes the first half had
 * just prepared; after, the chain's own claim is what refuses it.
 */
describe('a wipe arriving at the handover between two halves of a chain', () => {
  const SLOT = 45;
  const first: Stage = { file: 'first', args: [] };
  const second: Stage = { file: 'second', args: [] };
  let registryDir = '';
  let repoRoot = '';

  beforeEach(async () => {
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-handover-registry-'));
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-handover-root-'));
    isolateClaimEnvironment();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  /** What a wipe found when it took the section: did it reach the volumes? */
  interface WipeAttempt {
    readonly wiped: boolean;
    readonly refusal: string;
  }

  /**
   * `pnpm db:reset` as it really runs: its own run registered, the section
   * taken, and `composeDown -v` next unless a live claim on the slot refuses
   * it. The teardown throws once it has been reached, so what the orchestrator
   * would have done afterwards never runs and the answer is the wipe alone.
   */
  async function attemptWipe(): Promise<WipeAttempt> {
    let wiped = false;
    const unreached = (): never => {
      throw new Error('the wipe carried on past the teardown');
    };
    const deps = {
      composeDown: () => {
        wiped = true;
        return Promise.reject(new Error('teardown reached'));
      },
      reportProgress: () => {},
      generateEnvFiles: unreached,
      generateComposeFiles: unreached,
      installDeps: unreached,
      cleanupOrphans: unreached,
      ensureContainersHealthy: unreached,
      ensurePostgresAcceptsPassword: unreached,
      ensureDatabase: unreached,
      runMigrations: unreached,
      installDevTracking: unreached,
      provisionAdminSqlPanelRole: unreached,
      readMeta: unreached,
      markClean: unreached,
      ensureDaemonRunning: unreached,
      readDepsHash: unreached,
      writeDepsHash: unreached,
      computeDepsFingerprint: unreached,
      computeMigrationFingerprint: unreached,
      ensureTestTemplate: unreached,
      assertNoSchemaDrift: unreached,
      auditStackWorld: unreached,
      sqlExecutor: { exec: unreached, query: unreached },
    } satisfies EnsureStackDeps;
    const options: EnsureStackOptions = {
      repoRoot,
      slot: SLOT,
      daemonScriptPath: path.join(repoRoot, 'daemon.ts'),
      idleDaemonPort: 1,
      wipe: true,
      registryDir,
    };

    // The wipe is a run of its own, so the chain's claim is another run's to it.
    // Its directory has to be there: the bring-up records this slot's compose
    // project against the run before it goes near a teardown, and a record
    // naming a directory that does not exist is an error rather than a claim.
    const held = process.env[RUN_CLAIM_ENV];
    const ownRunDir = path.join(registryDir, 'the-wipes-own-run');
    await fs.mkdir(ownRunDir, { recursive: true });
    process.env[RUN_CLAIM_ENV] = ownRunDir;
    let refusal = '';
    try {
      await ensureStack(options, deps);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    } finally {
      process.env[RUN_CLAIM_ENV] = held ?? '';
    }
    return { wiped, refusal };
  }

  it('was admitted when each half claimed and released one of its own', async () => {
    const claimHalf = (): Promise<void> =>
      withRunClaim(
        { command: 'a half of the chain', mode: 'development', rootDir: REPO_ROOT, registryDir },
        () => Promise.resolve()
      );
    vi.stubEnv(STACK_SLOT_VARIABLE, String(SLOT));

    await claimHalf();
    const attempt = await attemptWipe();
    await claimHalf();

    expect(attempt.wiped).toBe(true);
    expect(attempt.refusal).toBe('teardown reached');
  });

  it('is refused now that one claim spans both halves', async () => {
    let attempt: WipeAttempt = { wiped: true, refusal: 'the handover was never reached' };

    await runComposite(
      { slot: SLOT, mode: 'development', rootDir: REPO_ROOT, registryDir },
      [first, second],
      async (stage) => {
        if (stage === second) attempt = await attemptWipe();
        return 0;
      }
    );

    expect(attempt.wiped).toBe(false);
    expect(attempt.refusal).toContain(`refusing to wipe slot ${String(SLOT)}`);
  });
});

describe('the chain as it really runs, in processes of its own', () => {
  const SLOT = 46;
  let registryDir = '';
  let outDir = '';

  beforeEach(async () => {
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-chain-registry-'));
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-chain-out-'));
    isolateClaimEnvironment();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  /** A stage that records which run the process it runs in belongs to. */
  function reportingStage(name: string): Stage {
    return {
      file: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], process.env['HB_RUN_CLAIM'] ?? '')",
        path.join(outDir, name),
      ],
    };
  }

  it('hands both halves the same run, so neither ever runs on an unclaimed slot', async () => {
    const code = await runComposite(
      { slot: SLOT, mode: 'development', rootDir: REPO_ROOT, registryDir },
      [reportingStage('first'), reportingStage('second')],
      execStage
    );

    const [first, second] = await Promise.all([
      fs.readFile(path.join(outDir, 'first'), 'utf8'),
      fs.readFile(path.join(outDir, 'second'), 'utf8'),
    ]);
    expect(code).toBe(0);
    expect(path.dirname(first)).toBe(registryDir);
    expect(second).toBe(first);
  });

  it('answers the exit code of a failing stage and leaves the rest unrun', async () => {
    const code = await runComposite(
      { slot: SLOT, mode: 'development', rootDir: REPO_ROOT, registryDir },
      [{ file: process.execPath, args: ['-e', 'process.exit(4)'] }, reportingStage('second')],
      execStage
    );

    expect(code).toBe(4);
    await expect(fs.access(path.join(outDir, 'second'))).rejects.toThrow();
  });
});

describe('a stage killed by a signal', () => {
  // A signalled stage fails the chain, and it fails it with a plain 1 rather
  // than with the shell's 128 plus the signal number: the spawner that gives
  // the stage its lifeline reports how a child exited and not the signal
  // behind it. `with-env` has always answered the same way for the stage it
  // starts, so this is what a caller already sees from the layer below.
  it('fails the chain', async () => {
    const code = await execStage({
      file: process.execPath,
      args: ['-e', "process.kill(process.pid, 'SIGKILL')"],
    });

    expect(code).toBe(1);
  });
});

/**
 * A stage that never started at all: the spawn itself failed, so nothing names
 * an exit code or a signal. A shell prints why and answers 127, and a wrapped
 * script must do the same rather than swallow the reason and report a bare 1.
 */
describe('a stage that could not be spawned', () => {
  const missing: Stage = { file: 'hb-with-run-claim-names-no-command', args: [] };

  it('answers what a shell answers for a command it could not find', async () => {
    await expect(execStage(missing)).resolves.toBe(127);
  });

  it('says which command it could not run', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

    await execStage(missing);

    expect(reported).toHaveBeenCalledWith(expect.stringContaining(missing.file));
    reported.mockRestore();
  });
});
