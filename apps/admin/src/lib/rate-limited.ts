import { retryAfterSecondsOf as retryAfterSecondsOfDetails } from '@hushbox/shared';
import { ApiError } from './api-client.js';

/** Server default window when a 429 body carries no usable hint. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * Seconds to wait before retrying a rate-limited admin read, or null when
 * the error is not a 429. The admin read routes answer 429 with
 * `{ code: 'RATE_LIMITED', details: { retryAfterSeconds } }` (no Retry-After
 * header), so the hint rides the JSON body `ApiError` captured.
 */
function serverHint(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || !('details' in body)) {
    return undefined;
  }
  return retryAfterSecondsOfDetails(body.details);
}

export function retryAfterSecondsOf(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 429) {
    return null;
  }
  return serverHint(error.body) ?? DEFAULT_RETRY_AFTER_SECONDS;
}
