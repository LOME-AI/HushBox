import { isRetryableStatus, backoffCeilingMs } from '@hushbox/shared';
import { expect } from './expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

type PostOptions = Parameters<APIRequestContext['post']>[1];

/**
 * POST a dev/setup endpoint, retrying transient responses until terminal.
 *
 * Under host saturation a workerd/wrangler restart answers an in-flight request
 * with a bare 5xx (the runtime envelope — "worker restarted mid-request" — not
 * an app response). Browser reads already recover via the app-wide query-retry
 * policy; this gives direct setup POSTs the same recovery, reusing the shared
 * `isRetryableStatus` classification so a genuine app 4xx returns immediately
 * (it is terminal) while a transient 5xx is re-issued.
 *
 * The retry is budget-bounded by {@link TIMEOUTS.API_SETUP} rather than a fixed
 * attempt count: `expect.poll` is the only sanctioned wait primitive (no
 * wall-clock sleeps in E2E), and its intervals follow the shared backoff
 * schedule. Returns the terminal response; the caller asserts `.ok()`.
 */
export async function postWithRetry(
  request: APIRequestContext,
  url: string,
  options?: PostOptions
): Promise<APIResponse> {
  let response: APIResponse | undefined;
  await expect
    .poll(
      async () => {
        response = await request.post(url, options);
        return isRetryableStatus(response.status());
      },
      {
        timeout: TIMEOUTS.API_SETUP,
        intervals: [backoffCeilingMs(0), backoffCeilingMs(1), backoffCeilingMs(2)],
      }
    )
    .toBe(false);
  // `expect.poll` only resolves once the callback ran and returned false, so
  // `response` is always assigned; fail fast rather than assert it away.
  if (response === undefined) {
    throw new Error('postWithRetry: expect.poll resolved before issuing a request');
  }
  return response;
}
