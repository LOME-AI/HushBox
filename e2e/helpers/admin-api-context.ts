import { devAdminTokenResponseSchema } from '@hushbox/shared';
import { requireEnv } from './env.js';
import { expectOkResponse } from './ok-response.js';
import { withProjectHeaders } from './project-headers.js';
import { withRequestRetry } from './resilient-request.js';
import type { APIRequest, APIRequestContext } from '@playwright/test';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * A Worker-direct admin API context authenticated as `actor`: mints a dev
 * Access JWT from the dev-only `GET /dev/admin-token` route and attaches it
 * under the header that route names, rather than spelling the header here.
 *
 * The one implementation of that mint under `e2e/helpers/` — a helper needing
 * an admin-authenticated context calls this instead of repeating the
 * two-context dance, because the mint context must be disposed while the
 * returned one must not. It is not the suite's only one: the `adminApi`
 * fixture in `e2e/admin/fixtures.ts` mints the same way inline, interleaved
 * with the disposal bookkeeping that fixture owns, and the duplication gate
 * does not report the two as a clone — so its silence is not evidence that
 * this is the only copy.
 *
 * The caller owns disposal of what comes back.
 */
export async function mintAdminApiContext(
  request: APIRequest,
  actor: string
): Promise<APIRequestContext> {
  const mintContext = withRequestRetry(await request.newContext({ baseURL: apiUrl }));
  try {
    const response = await mintContext.get('/dev/admin-token', { params: { email: actor } });
    await expectOkResponse(response, `dev admin token mint for ${actor}`);
    const { token, header } = devAdminTokenResponseSchema.parse(await response.json());
    return withRequestRetry(
      await request.newContext({
        baseURL: apiUrl,
        extraHTTPHeaders: withProjectHeaders({ [header]: token }),
      })
    );
  } finally {
    await mintContext.dispose();
  }
}
