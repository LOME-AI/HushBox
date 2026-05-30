/**
 * Heartbeat tick sources, gathered behind one bucketed helper. Used by:
 *
 *   - scripts/wrangler-dev.ts: pipes the API process's stdout through
 *     `createLineObserver` and ticks for each `[req]` line emitted by
 *     apps/api/src/middleware/request-log.ts. Wrangler running with no
 *     observed requests does NOT tick — only real API activity does.
 *   - scripts/lib/vitest-setup.ts: ticks once per Vitest worker process,
 *     so long test runs keep the stack from being reaped mid-run.
 *   - e2e/global-setup.ts: ticks once per Playwright run start, same reason.
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
