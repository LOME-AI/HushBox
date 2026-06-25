import { isRetryableError, retryOnTransientStatus } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

type PostOptions = Parameters<APIRequestContext['post']>[1];
type DeleteOptions = Parameters<APIRequestContext['delete']>[1];

/**
 * POST a dev/setup endpoint, retrying transient failures until terminal.
 *
 * Under host saturation a workerd/wrangler restart answers an in-flight request
 * with a bare 5xx (the runtime envelope — "worker restarted mid-request" — not
 * an app response), or severs the socket outright (a thrown `socket hang up`).
 * The runtime auto-retries only idempotent GET/HEAD, so a setup POST surfaces
 * both; this re-issues it via the shared `retryOnTransientStatus` loop, which
 * returns immediately on a terminal status (so a genuine app 4xx is not
 * retried), retries the transient 5xx, and — via `isRetryableError` — retries a
 * thrown connection drop too, backing off until the POST settles or the
 * {@link TIMEOUTS.API_SETUP} budget elapses. Safe because dev/setup POSTs are
 * idempotent. The caller asserts `.ok()` on the returned response.
 */
export function postWithRetry(
  request: APIRequestContext,
  url: string,
  options?: PostOptions
): Promise<APIResponse> {
  return retryOnTransientStatus(
    // eslint-disable-next-line no-restricted-syntax -- this IS the sanctioned retrying wrapper; every other call site routes through it
    () => request.post(url, options),
    (response) => response.status(),
    { timeoutMs: TIMEOUTS.API_SETUP, isRetryableError }
  );
}

/**
 * DELETE a dev/setup endpoint with the same transient-failure resilience as
 * {@link postWithRetry}. The dev reset endpoints (rate-limit clears, TOTP-replay
 * clear) are idempotent, so retrying a thrown `socket hang up` — the exact
 * saturation drop that flaked the pre-test rate-limit auto-hook — is safe.
 */
export function deleteWithRetry(
  request: APIRequestContext,
  url: string,
  options?: DeleteOptions
): Promise<APIResponse> {
  return retryOnTransientStatus(
    // eslint-disable-next-line no-restricted-syntax -- this IS the sanctioned retrying wrapper; every other call site routes through it
    () => request.delete(url, options),
    (response) => response.status(),
    { timeoutMs: TIMEOUTS.API_SETUP, isRetryableError }
  );
}
