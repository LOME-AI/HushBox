/**
 * Idle-killer daemon entry point. Spawned detached by ensure-stack via
 * scripts/lib/stack/idle-killer.ts. Runs forever (within a worktree-slot's lifecycle)
 * until either:
 *
 *   - the slot has held no live claim for a whole grace window of consecutive
 *     polls (idle teardown), or
 *   - a second daemon tries to bind 127.0.0.1:port and fails — meaning a
 *     race in launch detection left us behind; the elder daemon owns the
 *     slot and we exit (singleton-conflict).
 *
 * Decisions are pure functions of injected deps; tests verify the loop
 * without spinning real docker, network, or fs.
 */
import path from 'node:path';
import { createServer, type Server } from 'node:net';
import { execa } from 'execa';
import { z } from 'zod';
import { CHECKOUT_DIRECTORY, composeArguments } from '../../compose.js';
import { shouldTearDown } from './idle-killer.js';
import { claim } from '../claims/claim.js';
import { claimsDir } from '../claims/registry.js';
import { teardownReason } from './idle-teardown-failure.js';
import { otherRunsOnSlot } from './teardown-guard.js';
import type { CommandSpec, FlagValues } from '../cli/command-line.js';
import type { TeardownFailure } from './idle-teardown-failure.js';

export interface DaemonOptions {
  port: number;
  slot: number;
  pollMs: number;
  /** Consecutive claimless polls before the slot's data plane goes. */
  graceWindowPolls: number;
  composeProject: string;
  repoRoot: string;
}

export interface ComposeDownResult {
  exitCode: number | null;
  output: string;
}

export interface DaemonDeps {
  bindSingleton: (port: number) => Promise<{ close: () => void }>;
  /** Runs `body` while the claim that identifies this daemon is held. */
  holdIdentity: (
    port: number,
    identity: DaemonIdentityRecord,
    body: () => Promise<DaemonResult>
  ) => Promise<DaemonResult>;
  /**
   * How many runs bear on the slot: those holding a claim on it, and those
   * whose record could not be read and so cannot be ruled off it.
   */
  liveClaimCount: (slot: number) => Promise<number>;
  composeDown: (project: string, repoRoot: string) => Promise<ComposeDownResult>;
  /**
   * Leaves what a failing teardown would have printed somewhere that outlives
   * this process. The daemon's output is discarded, so this is the whole of
   * what anyone ever learns about a teardown that cannot succeed.
   */
  recordTeardownFailure: (failure: TeardownFailure) => Promise<void>;
  /** Withdraws that evidence, because nothing is failing any more. */
  clearTeardownFailure: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export interface DaemonResult {
  exitReason: 'idle-teardown' | 'singleton-conflict';
}

/**
 * The lock a daemon holds for exactly as long as it holds its sentinel port.
 *
 * A port number is an address, not an identity: anything at all can bind an
 * allocated port, and an auditor reading a port number learns only that
 * something is there. This lock is what the daemon proves itself with, and it
 * is a kernel fact rather than an answer a process chooses to give — the kernel
 * releases it the instant the daemon dies, so it cannot outlive what it
 * identifies.
 *
 * Keyed by port and machine-scoped, because a port is a machine-wide resource
 * and the port is the only thing an auditor starts from. It sits inside the run
 * registry's directory so that the per-user temp path has one derivation rather
 * than two; the `.lock` suffix is what keeps the registry's own enumeration
 * from reading it as a run.
 */
export function daemonIdentityLockPath(port: number, registryDir: string = claimsDir()): string {
  return path.join(registryDir, `idle-daemon-${String(port)}.lock`);
}

/**
 * What a daemon states about itself in the claim that identifies it.
 *
 * A daemon outlives the run that spawned it and captures all three of these at
 * spawn, so it can go on believing any of them long after the stack has moved:
 * a captured compose project it no longer belongs to is what a teardown would
 * name, a captured checkout is where that teardown would run, and the slot is
 * whose claims it reads to decide the stack is idle. An auditor that cannot
 * read them back can only ask whether *a* daemon is there, which is what let
 * one tear down a stack that was not its own.
 *
 * The port is deliberately absent: it keys the lock, so a record naming it
 * again would be the same fact in two places, free to disagree.
 */
export interface DaemonIdentityRecord {
  /** The slot whose claims this daemon polls. */
  readonly slot: number;
  /** The compose project its teardown would name. */
  readonly composeProject: string;
  /** The checkout its teardown would run in. */
  readonly repoRoot: string;
  readonly pid: number;
}

const identityRecordSchema = z.object({
  slot: z.number().int().nonnegative(),
  composeProject: z.string().min(1),
  repoRoot: z.string().min(1),
  pid: z.number().int().positive(),
});

/** How the daemon states itself to whoever reads the lock that identifies it. */
export function formatDaemonIdentity(identity: DaemonIdentityRecord): string {
  return JSON.stringify(identity);
}

/**
 * What the holder of an identity claim says it is, or nothing when it says
 * nothing this can act on. A daemon built before a daemon stated its stack
 * holds the same claim with prose in it, and prose is not a statement of which
 * stack it belongs to — so it reads as no identity rather than as agreement.
 */
export function parseDaemonIdentity(holder: string | null): DaemonIdentityRecord | undefined {
  if (holder === null) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(holder);
  } catch {
    return undefined;
  }
  const parsed = identityRecordSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Runs `body` while holding the claim that identifies the daemon on `port`.
 *
 * `refuse` rather than `wait`: the caller holds the port already, so no second
 * daemon can legitimately hold this claim, and queueing for one that will never
 * be released would leave a process alive with nothing to do.
 */
export function holdIdentity<T>(
  port: number,
  identity: DaemonIdentityRecord,
  body: () => Promise<T>,
  registryDir?: string
): Promise<T> {
  return claim(
    {
      name: `the idle daemon on port ${String(port)}`,
      lockPath: daemonIdentityLockPath(port, registryDir),
    },
    { onHeld: 'refuse', holder: formatDaemonIdentity(identity) },
    body
  );
}

function requirePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`idle-killer-daemon: invalid ${flag}`);
  }
  return parsed;
}

function requireNonNegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`idle-killer-daemon: invalid ${flag}`);
  }
  return parsed;
}

/**
 * An absent directory means the machine-wide registry, which is what every
 * spawned daemon wants. An empty one is a caller that meant to name a directory
 * and named nothing; taking it would resolve the claims against whatever
 * directory the daemon happens to have been started in.
 */
function optionalDirectory(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === '') throw new Error(`idle-killer-daemon: invalid ${flag}`);
  return value;
}

/**
 * The compose project this daemon may tear down.
 *
 * `generate-env` writes COMPOSE_PROJECT_NAME in every mode that spawns the
 * daemon (ensure-stack regenerates env before spawning), so absence means the
 * environment was never generated — a daemon that guessed a project name would
 * be a process authorised to destroy a stack it cannot name.
 */
export function requireComposeProject(env: NodeJS.ProcessEnv): string {
  const composeProject = composeProjectOf(env);
  if (composeProject === undefined) {
    throw new Error(
      'idle-killer-daemon: COMPOSE_PROJECT_NAME is not set — run pnpm generate:env first'
    );
  }
  return composeProject;
}

/**
 * The compose project the environment names, or nothing when it names none.
 * An empty value names no project, exactly as an absent one does, and the
 * auditor and the daemon have to agree on that: one reading it as a project
 * would compare a daemon's stack against a name nothing uses.
 */
export function composeProjectOf(env: NodeJS.ProcessEnv): string | undefined {
  const composeProject = env['COMPOSE_PROJECT_NAME'];
  return composeProject === undefined || composeProject === '' ? undefined : composeProject;
}

/**
 * The grammar every entry point that runs this daemon reads its line through.
 *
 * Shared with the rest of `scripts/` rather than read as a key/value map,
 * because the map accepted any key and dropped the ones nothing read: a
 * misspelt `--registry-dir` left the daemon on the machine-wide registry, and
 * what this process does with a registry is decide which stack to tear down.
 */
export const DAEMON_COMMAND_LINE = {
  command: 'tsx scripts/lib/stack/idle-killer-daemon-entry.ts',
  summary: "Tears down a slot's stack once no run has claimed the slot for a grace window.",
  flags: [
    {
      flag: '--port',
      kind: 'value',
      placeholder: '<port>',
      summary: 'The sentinel port this daemon binds, which is also how it is addressed.',
    },
    {
      flag: '--slot',
      kind: 'value',
      placeholder: '<slot>',
      summary: 'The worktree slot whose live claims decide whether its stack stays up.',
    },
    {
      flag: '--registry-dir',
      kind: 'value',
      placeholder: '<dir>',
      summary: 'Where claims are read and kept. The machine-wide registry when absent.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

export interface DaemonArgs {
  readonly port: number;
  readonly slot: number;
  /** Where this daemon keeps its claims; absent means the machine-wide registry. */
  readonly registryDir: string | undefined;
}

/** The values {@link DAEMON_COMMAND_LINE} names, once the grammar has accepted the line. */
export function daemonArgsFrom(flags: FlagValues<typeof DAEMON_COMMAND_LINE>): DaemonArgs {
  return {
    port: requirePositiveInt(flags['--port'], '--port'),
    slot: requireNonNegativeInt(flags['--slot'], '--slot'),
    registryDir: optionalDirectory(flags['--registry-dir'], '--registry-dir'),
  };
}

async function pollUntilIdle(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonResult> {
  // In memory and nowhere else: a persisted count would be a record of when
  // this daemon last looked, which is the timestamp the claim replaced. A
  // daemon that dies mid-window starts again, sparing a stack rather than
  // taking one.
  let consecutiveEmptyPolls = 0;
  // In memory for the same reason, and never read back off disk: the record on
  // disk is evidence for a human, and a daemon that resumed someone else's
  // count would be reporting attempts it never made.
  let consecutiveTeardownFailures = 0;

  // Before anything is attempted, because a record on this port describes the
  // attempts of whichever daemon wrote it and this one can speak only for its
  // own.
  await deps.clearTeardownFailure();

  for (;;) {
    const liveClaims = await deps.liveClaimCount(options.slot);
    consecutiveEmptyPolls = liveClaims > 0 ? 0 : consecutiveEmptyPolls + 1;
    const tearDown = shouldTearDown({
      liveClaims,
      consecutiveEmptyPolls,
      graceWindowPolls: options.graceWindowPolls,
    });
    if (tearDown) {
      deps.log(
        `no run has claimed slot ${String(options.slot)} for ${String(consecutiveEmptyPolls)} ` +
          `consecutive polls → tearing down ${options.composeProject}`
      );
      const result = await deps.composeDown(options.composeProject, options.repoRoot);
      if (result.exitCode === 0) {
        await deps.clearTeardownFailure();
        return { exitReason: 'idle-teardown' };
      }
      consecutiveTeardownFailures += 1;
      deps.log(
        `teardown of ${options.composeProject} failed (exit ${String(result.exitCode)}), retrying on the next poll: ${result.output.trim()}`
      );
      await deps.recordTeardownFailure({
        consecutiveFailures: consecutiveTeardownFailures,
        exitCode: result.exitCode,
        reason: teardownReason(result.output),
      });
    }
    await deps.sleep(options.pollMs);
  }
}

export async function daemonLoop(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonResult> {
  let singleton: { close: () => void };
  try {
    singleton = await deps.bindSingleton(options.port);
  } catch {
    deps.log(`singleton bind failed on port ${String(options.port)}; another daemon owns the slot`);
    // No identity claim here, deliberately: a daemon that lost the bind is not
    // the process on that port, and claiming otherwise would let it vouch for
    // the elder daemon's port after this one has exited.
    return { exitReason: 'singleton-conflict' };
  }

  try {
    // Bound before identified, so a held identity claim means its holder is the
    // process on the port — the bind is exclusive, so nothing else can be.
    // Released before the port closes, so a daemon shutting down never refuses
    // the successor that binds the port it has just let go of.
    return await deps.holdIdentity(
      options.port,
      {
        slot: options.slot,
        composeProject: options.composeProject,
        repoRoot: options.repoRoot,
        pid: process.pid,
      },
      () => pollUntilIdle(options, deps)
    );
  } finally {
    singleton.close();
  }
}

/**
 * How many live runs bear on `slot`, machine-wide. `registryDir` defaults to
 * the machine-wide registry; a test points it elsewhere.
 *
 * {@link otherRunsOnSlot} with no run disregarded, because this daemon holds no
 * run claim of its own: every live run on the slot is another one. The
 * destructive paths and this daemon stand on one reading of who holds a slot —
 * including its rule that a run whose record could not be read counts, which is
 * what keeps a damaged file from reading as an empty slot and licensing the
 * teardown {@link pollUntilIdle} runs against a live run's stack.
 */
export async function liveClaimCount(
  slot: number,
  registryDir: string = claimsDir()
): Promise<number> {
  const live = await otherRunsOnSlot(slot, null, registryDir);
  return live.claimed.length + live.unknown.length;
}

/* v8 ignore start -- real-IO bindings exercised at runtime via the CLI; daemonLoop is tested with injected deps */
export function bindSingleton(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export async function composeDown(project: string, repoRoot: string): Promise<ComposeDownResult> {
  const result = await execa(
    'docker',
    composeArguments(CHECKOUT_DIRECTORY, ['-p', project, 'down']),
    {
      cwd: repoRoot,
      all: true,
      reject: false,
    }
  );
  return { exitCode: result.exitCode ?? null, output: result.all };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
/* v8 ignore stop */
