/**
 * Runtime-agnostic retry policy: the single source of truth for which HTTP
 * responses are transient, the backoff schedule between attempts, and the
 * status-driven retry loop itself.
 *
 * Consumers adapt it to their own error model and retry primitive: the web
 * client wraps `isRetryableStatus` for TanStack Query (thrown
 * `ApiError`/`TypeError`); the E2E harness drives `retryOnTransientStatus` over
 * Playwright `APIResponse` status codes. Keep this module free of any browser-,
 * worker-, or Node-specific dependency so both can import it.
 */

/** First-retry backoff ceiling; doubles each subsequent attempt up to {@link MAX_DELAY_MS}. */
const BASE_DELAY_MS = 500;
/** Upper bound on a single backoff interval. */
const MAX_DELAY_MS = 10_000;

/**
 * Classify an HTTP status as a transient failure worth retrying: request
 * timeout (408), rate limit (429), or any server error (5xx). A 4xx other than
 * those is a terminal client error that won't succeed on repeat; a 2xx/3xx is a
 * success. Notably this matches the bare 5xx a workerd/wrangler worker returns
 * when it restarts mid-request under load — the runtime envelope, not an app
 * response.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Substrings of the thrown-error messages a transient connection drop produces.
 * The connection-level twin of {@link isRetryableStatus}'s 5xx: when a
 * workerd/wrangler worker recycles mid-request under load it may sever the
 * socket instead of answering, surfacing as a thrown `socket hang up` /
 * `ECONNRESET` / `fetch failed` rather than a status. Distinct from a real app
 * error, which rejects with a message carrying none of these.
 */
const TRANSIENT_ERROR_PATTERNS = [
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'fetch failed',
] as const;

/**
 * Classify a thrown error as a transient connection drop worth retrying. Only
 * `Error` instances are considered — Playwright and Node both throw `Error`s;
 * a non-`Error` rejection is treated as terminal. Retrying on a thrown drop is
 * only safe for idempotent calls, so the retry loop applies this solely when a
 * caller opts in via {@link RetryOptions.isRetryableError}.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => error.message.includes(pattern));
}

/**
 * Exponential backoff ceiling for a given 0-based attempt, capped at
 * {@link MAX_DELAY_MS}. Jitter (if any) is applied by the caller — this is the
 * deterministic upper bound.
 */
export function backoffCeilingMs(failureCount: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** failureCount, MAX_DELAY_MS);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultNow = (): number => Date.now();

interface RetryOptions {
  /** Total wall-clock budget; once elapsed, the last response is returned as-is. */
  timeoutMs: number;
  /** Backoff sleep between attempts. Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock for the deadline check. Injectable for deterministic tests. */
  now?: () => number;
  /**
   * Opt-in classifier for a *thrown* error worth retrying (a transient
   * connection drop — see {@link isRetryableError}). Omitted by default because
   * re-issuing after a thrown drop is only safe for idempotent calls; a caller
   * passing it asserts the call is idempotent. A thrown error not matched (or
   * with no classifier) propagates immediately.
   */
  isRetryableError?: (error: unknown) => boolean;
}

/**
 * Re-invoke `send` while its response carries a transient status, spacing
 * attempts by the {@link backoffCeilingMs} schedule, until the response is
 * terminal or the `timeoutMs` budget elapses. Returns the last response either
 * way — the caller asserts on it. A terminal status (success or a real 4xx) is
 * returned immediately, on the first attempt, with no sleep.
 *
 * `getStatus` extracts the status from the response shape (e.g. Playwright's
 * `APIResponse.status()`), keeping this loop independent of any HTTP client.
 *
 * When `options.isRetryableError` is supplied, a *thrown* transient error (a
 * severed connection that never produced a status) is retried on the same
 * schedule/budget instead of propagating — the connection-level counterpart of
 * a transient 5xx. Errors it does not match still propagate at once.
 */
export async function retryOnTransientStatus<T>(
  send: () => Promise<T>,
  getStatus: (result: T) => number,
  options: RetryOptions
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? defaultNow;
  const deadline = now() + options.timeoutMs;

  let attempt = 0;
  for (;;) {
    try {
      const result = await send();
      if (!isRetryableStatus(getStatus(result)) || now() >= deadline) {
        return result;
      }
    } catch (error) {
      if (now() >= deadline || options.isRetryableError?.(error) !== true) {
        throw error;
      }
    }
    await sleep(backoffCeilingMs(attempt));
    attempt += 1;
  }
}
