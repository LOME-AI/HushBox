/** The subset of `process` this needs, so a test never touches the real one. */
export interface SignalTarget {
  on(signal: 'SIGTERM', handler: () => void): void;
  off(signal: 'SIGTERM', handler: () => void): void;
}

export interface SignalShutdownOptions {
  /** The teardown to attempt before the process is ended outright. */
  readonly close: () => void | Promise<void>;
  readonly log: (message: string) => void;
  /** How long the teardown gets before the process ends anyway. */
  readonly graceMs?: number;
  /** Injected by tests; defaults to `process.exit`. */
  readonly forceExit?: (code: number) => void;
  /** Injected by tests; defaults to this process. */
  readonly target?: SignalTarget;
}

/**
 * Generous for a teardown measured in tens of milliseconds, short enough that a
 * console nobody can reach is gone before anyone looks for it.
 */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Bounds the console's response to `kill <pid>`. The dev server installs its own
 * signal handler that awaits a teardown with no timeout, and the port is released
 * from inside that teardown: once it is installed, the default termination no
 * longer applies, so a teardown that never returns leaves a live process with
 * nothing listening.
 *
 * Ending the process mid-write cannot truncate a finding: every write lands as a
 * temporary file renamed over the target, so the file on disk is always either
 * the previous bytes or the whole new ones. The residue is the temporary file
 * and the writer's lock, both ignored by git, and the lock is reclaimed by its
 * own staleness window.
 */
export function installSignalShutdown({
  close,
  log,
  graceMs,
  forceExit,
  target,
}: SignalShutdownOptions): () => void {
  const grace = graceMs ?? SHUTDOWN_GRACE_MS;
  const halt = forceExit ?? process.exit.bind(process);
  const signals = target ?? process;
  let shuttingDown = false;

  const handler = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('docket: shutting down');

    const forced = setTimeout(() => {
      halt(0);
    }, grace);
    void (async (): Promise<void> => {
      try {
        await close();
      } catch {
        // Reported rather than raised: an unhandled rejection here would take
        // the process down noisily on the one path whose whole job is to take
        // it down cleanly.
        log('docket: shutdown failed, ending anyway');
      }
      clearTimeout(forced);
      halt(0);
    })();
  };

  signals.on('SIGTERM', handler);
  return () => {
    signals.off('SIGTERM', handler);
  };
}
