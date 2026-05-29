import { ApiError } from './api.js';

/**
 * App-wide client retry policy for transient failures, shared by TanStack
 * Query's `defaultOptions` for both queries and mutations.
 *
 * Retries are only safe because the API is idempotent: conversation creation
 * upserts on a client-generated id, forks dedupe by id, billing by
 * idempotency key, and balance/link mutations use atomic conditional updates.
 * A repeated request therefore returns the existing resource rather than
 * duplicating it. Keep that guarantee in mind before widening what retries.
 */

/** First-retry backoff ceiling; doubles each subsequent attempt up to {@link MAX_DELAY_MS}. */
const BASE_DELAY_MS = 500;
/** Upper bound on a single backoff interval. */
const MAX_DELAY_MS = 10_000;
/** Upper bound on a server-provided `Retry-After`, so a hostile/huge value can't stall the UI. */
const RETRY_AFTER_CAP_MS = 30_000;
/** Retry attempts after the initial failure (0-based failureCount < MAX_RETRIES). 2 → 3 total tries. */
export const MAX_RETRIES = 2;

/**
 * Classify an error as a transient failure worth retrying.
 *
 * Retry: network/transport failures (no HTTP response — surfaced by `fetch` as
 * a `TypeError`, e.g. a dropped connection or failed CORS preflight) and
 * transient server responses (408, 429, 5xx). Never retry 4xx (the request is
 * wrong and won't succeed on repeat) or an aborted request (intentional
 * cancellation by TanStack Query on unmount/refetch).
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

/**
 * TanStack `retry` predicate for QUERIES: retry any transient error up to
 * {@link MAX_RETRIES} (0-based count). Reads are safe to repeat.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return isRetryableError(error) && failureCount < MAX_RETRIES;
}

/**
 * TanStack `retry` predicate for MUTATIONS: retry network/no-response failures
 * only — never a server response (4xx or 5xx).
 *
 * A 5xx may mean the server already applied a non-idempotent write before
 * failing; not every client mutation carries an idempotency key (e.g. payment
 * creation does not), so retrying a 5xx could duplicate it. A network failure
 * with no response is the safe, common case (a dropped connection / failed
 * CORS preflight — the exact flake this addresses). A mutation that is provably
 * idempotent can opt into broader retries per-hook.
 */
export function shouldRetryMutation(failureCount: number, error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError && failureCount < MAX_RETRIES;
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into a
 * millisecond delay, or `null` when absent/unparseable. A past date clamps to 0.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (headerValue == null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

/**
 * TanStack `retryDelay`: honor a server `Retry-After` when present (capped),
 * otherwise exponential backoff with full jitter. Full jitter (`random * ceiling`)
 * de-correlates retries across concurrently-failing clients so a shared blip
 * doesn't produce a synchronized retry storm.
 */
export function computeRetryDelay(failureCount: number, error: unknown): number {
  if (error instanceof ApiError && error.retryAfterMs != null) {
    return Math.min(error.retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** failureCount, MAX_DELAY_MS);
  // eslint-disable-next-line sonarjs/pseudo-random -- retry jitter is timing, not security-sensitive
  return Math.random() * ceiling;
}
