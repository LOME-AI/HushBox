import { isRetryableStatus, backoffCeilingMs } from '@hushbox/shared';
import { ApiError } from './api.js';

/**
 * App-wide client retry policy for transient failures, shared by TanStack
 * Query's `defaultOptions` for both queries and mutations. The transient-status
 * classification and backoff schedule live in `@hushbox/shared` (so the E2E
 * harness applies the same rules); this module adapts them to the browser error
 * model (thrown `ApiError`/`TypeError`) and TanStack's predicate signatures.
 *
 * What makes a repeat safe differs by kind, which is why there are two
 * predicates. A read is safe to repeat by nature. A write is safe only where
 * the server can recognize the repeat, so the mutation predicate keys off the
 * `Idempotency-Key` the request actually carried rather than off a standing
 * claim about which routes deduplicate.
 */

/** Upper bound on a server-provided `Retry-After`, so a hostile/huge value can't stall the UI. */
const RETRY_AFTER_CAP_MS = 30_000;
/** Retry attempts after the initial failure (0-based failureCount < MAX_RETRIES). 2 → 3 total tries. */
export const MAX_RETRIES = 2;
const RATE_LIMITED_STATUS = 429;

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
  if (error instanceof ApiError) return isRetryableStatus(error.status);
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
 * TanStack `retry` predicate for MUTATIONS, in two arms decided by whether the
 * failing request carried an `Idempotency-Key`.
 *
 * With a key the server deduplicates the repeat, so a transient server response
 * retries on exactly the schedule {@link shouldRetry} gives a read. Without one
 * a 5xx may mean the write applied before the response was lost, and repeating
 * it could duplicate the write — so only a network failure with no response
 * (a dropped connection / failed CORS preflight) retries, as it always has.
 *
 * A 429 never retries, keyed or not: it is the server's final word for the wait
 * it names, and each repeat would spend the caller's limit again. Reads keep
 * retrying it through {@link shouldRetry}.
 *
 * The key is the whole permission: `carriedIdempotencyKey` is derived at
 * construction from the response the fetch wrapper marked, never declared, so a
 * mutation cannot claim this retry without actually sending a key, and cannot
 * send one without earning it.
 */
export function shouldRetryMutation(failureCount: number, error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof ApiError) {
    if (error.status === RATE_LIMITED_STATUS) return false;
    return error.carriedIdempotencyKey && shouldRetry(failureCount, error);
  }
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
  // eslint-disable-next-line sonarjs/pseudo-random -- retry jitter is timing, not security-sensitive
  return Math.random() * backoffCeilingMs(failureCount);
}
