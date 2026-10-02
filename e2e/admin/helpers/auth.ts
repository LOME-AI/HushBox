import { CF_ACCESS_JWT_HEADER, devAdminTokenResponseSchema } from '@hushbox/shared';
import { requireEnv } from '../../helpers/env.js';
import { expectOkResponse } from '../../helpers/ok-response.js';
import { withProjectHeaders } from '../../helpers/project-headers.js';
import { withRequestRetry } from '../../helpers/resilient-request.js';
import type { DevAdminTokenResponse } from '@hushbox/shared';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

type PlaywrightApi = PlaywrightWorkerArgs['playwright'];

/**
 * Raw request contexts for the auth-boundary spec: unlike `adminApi`, these
 * deliberately carry NO assertion (or a hostile one), because the subject
 * under test is the Worker's refusal. Retry-wrapped like every harness
 * context so a transient saturation drop never masquerades as a denial.
 */
export async function anonApiContext(playwright: PlaywrightApi): Promise<APIRequestContext> {
  return withRequestRetry(await playwright.request.newContext({ baseURL: API_BASE }));
}

/** A context presenting the given value under the Access assertion header. */
export async function tokenApiContext(
  playwright: PlaywrightApi,
  token: string,
  header: string = CF_ACCESS_JWT_HEADER
): Promise<APIRequestContext> {
  return withRequestRetry(
    await playwright.request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: withProjectHeaders({ [header]: token }),
    })
  );
}

/**
 * Mint a dev Access JWT for an arbitrary email via `GET /dev/admin-token`.
 * The dev mint signs for ANY syntactically-valid email by design (the
 * allowlist is enforced at verification, not at mint — a non-allowlisted
 * mint is a deliberate denial fixture); throws on a non-200 so a broken
 * mint fails at setup, never mid-assertion.
 */
export async function mintDevToken(
  context: APIRequestContext,
  email: string
): Promise<DevAdminTokenResponse> {
  const response = await context.get('/dev/admin-token', { params: { email } });
  await expectOkResponse(response, `dev admin token mint for ${email}`, 200);
  return devAdminTokenResponseSchema.parse(await response.json());
}

/** Dispose every context a test built, in one shot (finally-block hygiene). */
export async function disposeAll(contexts: readonly APIRequestContext[]): Promise<void> {
  for (const context of contexts) {
    await context.dispose();
  }
}
