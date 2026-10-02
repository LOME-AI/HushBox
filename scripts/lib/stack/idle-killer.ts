/**
 * Per-worktree-slot inactivity daemon. One process per slot, exclusivity
 * enforced kernel-side by binding 127.0.0.1:HB_IDLE_DAEMON_PORT (any second
 * binder gets EADDRINUSE). Launch races between two `ensureStack` callers are
 * serialized by a claim on the slot's launch lock: the winner holds an advisory
 * lock for as long as it is spawning, and a launcher that dies mid-spawn is
 * released by the kernel rather than waited out.
 *
 * Cross-platform: no flock syscalls written here, no abstract sockets, no /proc
 * walks. Only fs ops, node:net, child_process.spawn and the claim primitive —
 * all behave identically on linux, darwin, and win32 (modulo `windowsHide` for
 * detached spawn).
 */
import path from 'node:path';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { ClaimHeldError, claim } from '../claims/claim.js';
import { withoutInheritedIdentity } from '../spawn/long-lived.js';
import { describeTeardownFailure, readTeardownFailure } from './idle-teardown-failure.js';
import type { spawn as nodeSpawn } from 'node:child_process';

/**
 * How many consecutive polls a slot must hold no live claim before its data
 * plane is torn down.
 *
 * A count of polls rather than an elapsed span, and held only in the polling
 * daemon's memory, because a persisted deadline would be a timestamp deciding
 * when a resource may be destroyed — the inference this whole mechanism exists
 * to replace. The window is grace, not liveness: the claim already answered
 * whether anything is using the slot, and this only spares a slot whose owner
 * has just finished and whose successor is about to start. A daemon restarted
 * mid-window begins again from zero, which errs toward keeping a stack alive: a
 * false keep costs seconds, a false teardown destroys another run's work.
 */
export const EMPTY_POLLS_BEFORE_TEARDOWN = 30;

export type SpawnFunction = typeof nodeSpawn;

interface ShouldTearDownInput {
  /**
   * Runs the slot may be in use by — the whole in-use predicate. A run holding
   * a claim on it, and a run whose record could not be read and so cannot be
   * ruled off it, count alike.
   */
  readonly liveClaims: number;
  /** Polls in a row, this one included, that found no live claim. */
  readonly consecutiveEmptyPolls: number;
  readonly graceWindowPolls: number;
}

/**
 * Whether the slot's data plane may go now.
 *
 * A listener on the slot's ports is deliberately not consulted. It used to veto
 * teardown, which inverted the mechanism: a leaked child holding a port made
 * the slot look busy and so permanently blocked the reclaimer whose job was to
 * clean up after exactly that child. A claim is held by a run and released by
 * the kernel when the run ends, so a leaked process holds nothing.
 */
export function shouldTearDown(input: ShouldTearDownInput): boolean {
  if (input.liveClaims > 0) return false;
  return input.consecutiveEmptyPolls >= input.graceWindowPolls;
}

interface IsDaemonAliveOptions {
  /** Connect timeout. Default 500 ms — local TCP refuses or accepts in <50 ms. */
  timeoutMs?: number;
}

/**
 * Cross-platform daemon-liveness probe. Tries to open a TCP connection to
 * 127.0.0.1:port; the kernel responds synchronously with either a SYN-ACK
 * (alive) or a RST (ECONNREFUSED, dead). The socket is closed immediately —
 * no protocol exchange, no payload.
 */
/* v8 ignore start -- isDaemonAlive uses node:net sockets whose inline event handlers v8 reports as separate uncovered functions even when the outer behavior is fully tested (alive, dead, timeout). The behavior is covered by the three corresponding tests. */
export async function isDaemonAlive(
  port: number,
  options: IsDaemonAliveOptions = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 500;
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const settle = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => {
      settle(false);
    });
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}
/* v8 ignore stop */

export interface EnsureDaemonOptions {
  port: number;
  cacheDir: string;
  daemonScriptPath: string;
  slot: number;
  /** Test injection. Defaults to the real `child_process.spawn`. */
  spawn?: SpawnFunction;
  /** Test injection. Defaults to {@link isDaemonAlive}. */
  isAlive?: (port: number) => Promise<boolean>;
  /** Test injection for the launch lock path. */
  lockPath?: string;
  /** Test injection for the registry the daemon's evidence is kept in. */
  registryDir?: string;
  /**
   * Where {@link reportFailingTeardown} is heard. Defaults to standard error,
   * so the one call every stack bring-up already makes is what carries it.
   */
  log?: (message: string) => void;
}

/**
 * Says out loud what the daemon on this port last recorded about a teardown it
 * could not complete.
 *
 * This call is the whole reason the daemon writes that record down. It is
 * spawned detached, with its output discarded and its handle released, and
 * nothing reads its exit code — so a teardown failing for a reason that will
 * not change is retried once per poll forever, silently, and the stack it was
 * supposed to reclaim stays up. Making the daemon exit instead of loop would
 * report exactly as much, which is nothing; the discarded output is the defect.
 * `ensureStack` calls into here on every bring-up, so this is where the
 * evidence meets somebody without their having to know it exists.
 *
 * It reports and does nothing else. Ending a daemon on the strength of a record
 * would be an observation granting itself authority, and this one has none.
 */
async function reportFailingTeardown(options: EnsureDaemonOptions): Promise<void> {
  const failure = await readTeardownFailure(options.port, options.registryDir);
  if (failure === undefined) return;
  const log = options.log ?? console.warn;
  log(describeTeardownFailure(options.port, options.slot, failure));
}

/**
 * The daemon entry point is a `.ts` file (the orchestrator and the daemon both
 * run via tsx). `process.execPath` is plain node, which can't load TypeScript
 * directly. Resolve tsx's `bin` from its package.json and run
 * `node <tsx-cli> <daemon-entry>` so the daemon inherits the same TS loader
 * as its parent. tsx's package `exports` map omits `./dist/cli.mjs`, so we
 * pull it from the published `bin` field on the package.json. Cross-platform:
 * the bin is a portable ESM entry shipped with the package.
 */
export function resolveTsxCliPath(): string {
  /* v8 ignore start -- requires real node_modules layout; covered by integration test */
  const require_ = createRequire(import.meta.url);
  const packageJsonPath = require_.resolve('tsx/package.json');
  const package_ = require_(packageJsonPath) as { bin?: string | Record<string, string> };
  const binEntry = typeof package_.bin === 'string' ? package_.bin : package_.bin?.['tsx'];
  if (binEntry === undefined) {
    throw new Error('idle-killer: tsx package.json has no resolvable bin entry');
  }
  return path.resolve(path.dirname(packageJsonPath), binEntry);
  /* v8 ignore stop */
}

/* v8 ignore start -- defaults fork a real subprocess at runtime; tests inject. */
async function resolveEnsureDaemonDefaults(options: EnsureDaemonOptions): Promise<{
  isAlive: (port: number) => Promise<boolean>;
  spawn: SpawnFunction;
  lockPath: string;
}> {
  const childProcess = await import('node:child_process');
  return {
    isAlive: options.isAlive ?? isDaemonAlive,
    spawn: options.spawn ?? childProcess.spawn,
    lockPath: options.lockPath ?? path.join(options.cacheDir, 'daemon.lock'),
  };
}
/* v8 ignore stop */

/** How a launcher names itself to whoever reads the lock it is holding. */
function launchHolder(slot: number): string {
  return `idle-daemon launch for slot ${String(slot)} (pid ${String(process.pid)})`;
}

type Ran = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/**
 * Runs `body` while holding the slot's launch claim, and returns without
 * running it at all when another launcher holds one.
 *
 * The body's own failure comes back as a value so that the only thing thrown
 * out of the claim is the claim's refusal: `body` spawns a process and may
 * raise anything, and a refusal is the one outcome that means "someone else is
 * already doing this", never "the launch failed".
 */
async function underLaunchClaim(
  lockPath: string,
  slot: number,
  body: () => Promise<void>
): Promise<void> {
  let ran: Ran;
  try {
    ran = await claim(
      { name: `the idle daemon for slot ${String(slot)}`, lockPath },
      { onHeld: 'refuse', holder: launchHolder(slot) },
      async (): Promise<Ran> => {
        try {
          await body();
          return { ok: true };
        } catch (error) {
          return { ok: false, error };
        }
      }
    );
  } catch (error) {
    if (!(error instanceof ClaimHeldError)) throw error;
    // A live launcher is mid-spawn. It will finish; a second spawn would only
    // lose the singleton bind and exit.
    return;
  }
  if (!ran.ok) throw ran.error;
}

/**
 * Ensure a daemon is running for this slot. Idempotent and safe to call
 * concurrently from multiple `ensureStack` invocations.
 *
 * Race sequence:
 *   0. Report what the daemon on this port recorded about a failing teardown.
 *   1. Probe TCP — alive? return.
 *   2. Take the launch claim — refused? the holder is spawning, return.
 *   3. Probe TCP again — alive now? winner finished, drop the claim, return.
 *   4. Spawn detached daemon, drop the claim.
 */
export async function ensureDaemonRunning(options: EnsureDaemonOptions): Promise<void> {
  const { isAlive, spawn, lockPath } = await resolveEnsureDaemonDefaults(options);
  // Ahead of every early return, because the daemon a bring-up finds already
  // running is exactly the one whose teardown may have been failing since long
  // before this command was typed.
  await reportFailingTeardown(options);
  if (await isAlive(options.port)) return;

  await underLaunchClaim(lockPath, options.slot, async () => {
    // Sibling launcher may have spawned in the window between our first probe
    // and our claim; re-check before spending the spawn.
    if (await isAlive(options.port)) return;

    // Spawn shape: `node <tsx-cli> <daemon-entry.ts> --flags…`. Without the
    // tsx-cli interposed, node would reject the `.ts` extension and the
    // daemon would crash silently under `stdio: 'ignore'`.
    const tsxCliPath = resolveTsxCliPath();
    const child = spawn(
      process.execPath,
      [
        tsxCliPath,
        options.daemonScriptPath,
        '--port',
        String(options.port),
        '--slot',
        String(options.slot),
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // A daemon outlives every process above it, so it must be handed
        // nothing that names one: not the socket address this launcher is
        // watching, and not the run record this launcher removes when it ends.
        env: withoutInheritedIdentity(process.env),
      }
    );
    child.unref();
  });
}
