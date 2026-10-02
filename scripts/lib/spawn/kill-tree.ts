/**
 * Ending a process tree, and the signals a tree can be asked to take.
 */

import { spawnSync } from 'node:child_process';

/** What a terminal, a supervisor or an operator can ask a tree to do. */
export const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export type TreeSignal = (typeof FORWARDED_SIGNALS)[number];

/** Everything the whole tree is asked to take, forwarding included. */
export type KillSignal = TreeSignal | 'SIGKILL';

export interface KillTreeDeps {
  /** Injected so the branch a platform takes is testable off that platform. */
  readonly platform?: NodeJS.Platform;
  readonly signal?: (target: number, signal: KillSignal) => void;
  readonly run?: (file: string, args: readonly string[]) => void;
}

export function sendSignal(target: number, signal: KillSignal): void {
  process.kill(target, signal);
}

/**
 * Sends a signal, treating a target that has already gone as the outcome that
 * was wanted. Shared by every signalling path here, because "already dead is
 * success" is one rule and two spellings of it would be free to disagree.
 */
export function signalTolerantly(
  target: number,
  signal: KillSignal,
  send: (target: number, signal: KillSignal) => void
): void {
  try {
    send(target, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/* v8 ignore next 3 -- only Windows reaches it, and see the note at its caller. */
function runCommand(file: string, args: readonly string[]): void {
  spawnSync(file, [...args], { stdio: 'ignore' });
}

/**
 * Ends `pid` and everything under it. Idempotent by construction: a tree that
 * has already gone is the ordinary case for a caller that stops a child it may
 * have already stopped, so `ESRCH` is success and every other failure is not.
 */
export function killTree(pid: number, signal: KillSignal, deps: KillTreeDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(
      `Refusing to kill the tree of pid ${String(pid)}: negated it addresses every process ` +
        `this user may signal, not one tree.`
    );
  }

  if (platform === 'win32') {
    /* v8 ignore next 3 -- {@link runCommand} executes only on Windows, which
       nothing in this repository runs; running the real `taskkill` here would
       end whatever process holds that pid on the machine measuring coverage. */
    const run = deps.run ?? runCommand;
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }

  signalTolerantly(-pid, signal, deps.signal ?? sendSignal);
}
