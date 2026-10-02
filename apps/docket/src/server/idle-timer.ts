export interface IdleTimer {
  /** Restarts the window. Called for every API request the console makes. */
  touch(): void;
  stop(): void;
}

export interface IdleTimerOptions {
  readonly minutes: number;
  /** May be async: shutting down closes the dev server before the process exits. */
  readonly onExpire: () => void | Promise<void>;
  /** How long the shutdown gets to finish before the process is ended outright. */
  readonly graceMs?: number;
  /** Injected by tests; defaults to `process.exit`. */
  readonly forceExit?: (code: number) => void;
}

/** Long enough for any honest dev-server teardown, short enough to bound a stuck one. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * In-process idle window for the console's dev server. Deliberately not the
 * worktree idle-killer: that one is a per-worktree singleton that tears down the
 * Docker stack, and a tool that touches no infrastructure must not be able to
 * kill Postgres.
 */
export function startIdleTimer({
  minutes,
  onExpire,
  graceMs,
  forceExit,
}: IdleTimerOptions): IdleTimer {
  const window = minutes * 60_000;
  const grace = graceMs ?? SHUTDOWN_GRACE_MS;
  const halt = forceExit ?? process.exit.bind(process);
  let done = false;
  let handle: ReturnType<typeof setTimeout>;

  const arm = (): void => {
    handle = setTimeout(() => {
      done = true;
      // Reclamation must not wait on the shutdown: the teardown releases the
      // port before it finishes, so one that never returns leaves a live
      // process with nothing listening. `stop()` deliberately does not disarm
      // this, because the dev server's close event calls it mid-shutdown.
      const forced = setTimeout(() => {
        halt(0);
      }, grace);
      void (async (): Promise<void> => {
        await onExpire();
        clearTimeout(forced);
      })();
    }, window);
  };
  arm();

  return {
    touch(): void {
      if (done) return;
      clearTimeout(handle);
      arm();
    },
    stop(): void {
      done = true;
      clearTimeout(handle);
    },
  };
}
