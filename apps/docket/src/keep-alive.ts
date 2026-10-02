/** Well inside the shortest idle window a developer is likely to ask for. */
export const KEEP_ALIVE_INTERVAL_MS = 60_000;

interface KeepAliveOptions {
  readonly ping?: () => Promise<unknown>;
  readonly isVisible?: () => boolean;
  readonly intervalMs?: number;
}

/**
 * Holds the dev server open only while someone is actually looking at the
 * console. A ping is deliberately gated on tab visibility: a forgotten
 * background tab must still let the idle window close, which is the whole
 * reason the server has one.
 */
export function startKeepAlive(options: KeepAliveOptions = {}): () => void {
  const ping = options.ping ?? ((): Promise<unknown> => fetch('/api/ping'));
  const isVisible = options.isVisible ?? ((): boolean => document.visibilityState === 'visible');
  const intervalMs = options.intervalMs ?? KEEP_ALIVE_INTERVAL_MS;

  const beat = (): void => {
    if (!isVisible()) return;
    void (async (): Promise<void> => {
      try {
        await ping();
      } catch {
        // The server exits on its own idle window; a refused connection
        // afterwards is the expected end of the session, not an error.
      }
    })();
  };

  const timer = setInterval(beat, intervalMs);
  const onVisibility = (): void => {
    beat();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
