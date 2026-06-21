import { retryOnTransientStatus } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

type PostOptions = Parameters<APIRequestContext['post']>[1];

/**
 * POST a dev/setup endpoint, retrying transient responses until terminal.
 *
 * Under host saturation a workerd/wrangler restart answers an in-flight request
 * with a bare 5xx (the runtime envelope — "worker restarted mid-request" — not
 * an app response). The runtime auto-retries only idempotent GET/HEAD, so a
 * setup POST surfaces the 5xx; this re-issues it via the shared
 * `retryOnTransientStatus` loop, which returns immediately on a terminal status
 * (so a genuine app 4xx is not retried) and otherwise backs off until the POST
 * settles or the {@link TIMEOUTS.API_SETUP} budget elapses. The caller asserts
 * `.ok()` on the returned response.
 */
export function postWithRetry(
  request: APIRequestContext,
  url: string,
  options?: PostOptions
): Promise<APIResponse> {
  return retryOnTransientStatus(
    () => request.post(url, options),
    (response) => response.status(),
    { timeoutMs: TIMEOUTS.API_SETUP }
  );
}
