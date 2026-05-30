/**
 * Heartbeat tick sources, gathered behind one bucketed helper. Used by:
 *
 *   - scripts/wrangler-dev.ts: tee stdout into the ticker so each request-log
 *     line from the API middleware counts as activity (request-driven heartbeat,
 *     not presence-driven — wrangler being alive alone never ticks).
 *   - vitest setup file: tick once per suite start, so long test runs keep
 *     the stack from being reaped mid-run.
 *   - playwright global-setup: tick once per E2E run start, same reason.
 *
 * The bucket means even a flood of requests turns into at most one fs.utimes
 * call per HEARTBEAT_TICK_BUCKET_MS — cheap regardless of traffic shape.
 */

export const HEARTBEAT_TICK_BUCKET_MS = 5000;

const API_REQUEST_LOG_PREFIX = /^\[req\]\s/;

export function isApiRequestLogLine(line: string): boolean {
  return API_REQUEST_LOG_PREFIX.test(line);
}

export interface HeartbeatTickerOptions {
  heartbeatPath: string;
  touch: (path: string) => Promise<void>;
  now?: () => number;
}

/**
 * Build a ticker function that the caller invokes on every activity event.
 * Internally bucketed so the underlying `touch` runs at most once per
 * HEARTBEAT_TICK_BUCKET_MS. Errors from `touch` are swallowed — a missing
 * heartbeat tick is not worth crashing the consumer (the next tick recovers).
 */
export function createHeartbeatTicker(options: HeartbeatTickerOptions): () => Promise<void> {
  const now = options.now ?? (() => Date.now());
  let lastTickAt = Number.NEGATIVE_INFINITY;
  return async () => {
    const current = now();
    if (current - lastTickAt < HEARTBEAT_TICK_BUCKET_MS) return;
    lastTickAt = current;
    try {
      await options.touch(options.heartbeatPath);
    } catch {
      // Best-effort — see module docstring.
    }
  };
}
