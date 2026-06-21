/**
 * Runtime-agnostic retry policy: the single source of truth for which HTTP
 * responses are transient and the backoff schedule between attempts.
 *
 * Consumers adapt it to their own error model and retry primitive: the web
 * client wraps it for TanStack Query (thrown `ApiError`/`TypeError`), the E2E
 * harness applies it to Playwright `APIResponse` status codes inside
 * `expect.poll`. Keep this module free of any browser-, worker-, or
 * Node-specific dependency so both can import it.
 */

/** First-retry backoff ceiling; doubles each subsequent attempt up to {@link MAX_DELAY_MS}. */
export const BASE_DELAY_MS = 500;
/** Upper bound on a single backoff interval. */
export const MAX_DELAY_MS = 10_000;

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
 * Exponential backoff ceiling for a given 0-based attempt, capped at
 * {@link MAX_DELAY_MS}. Jitter (if any) is applied by the caller — this is the
 * deterministic upper bound.
 */
export function backoffCeilingMs(failureCount: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** failureCount, MAX_DELAY_MS);
}
