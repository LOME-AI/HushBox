import { hc } from 'hono/client';
import { z } from 'zod';
import { LINK_CREDENTIAL_HEADER } from '@hushbox/shared';
import { getPlatform } from '@/capacitor/platform.js';
import { getApiUrl } from './api/api.js';
import { apiErrorFromResponse } from './api/api-error-from-response.js';
import { IDEMPOTENCY_KEY_HEADER, markRequestKeyed } from './api/idempotent-mutation.js';
import { getLinkGuestAuth } from './auth/link-guest-auth.js';
import type { AppType } from '@hushbox/api';
import type { ClientResponse } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';

// Registry-backed: `envConfig` supplies VITE_APP_VERSION for every mode (validated
// there as `z.string().min(1)`), so a missing/empty value is a broken bootstrap
// that must fail fast (zod throws), never silently resolve to 'dev-local'.
/** The version this tab is running, sent on every request as `X-App-Version`. */
export const appVersion = z
  .string()
  .min(1)
  .parse(import.meta.env['VITE_APP_VERSION']);

const customFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('X-HushBox-Platform', getPlatform());
  headers.set('X-App-Version', appVersion);
  // Read where the request's headers are finalized: this is the only place
  // that sees whether a key actually rode the wire, and `fetchJson` — which
  // builds the failure — is handed the response alone.
  const keyed = headers.has(IDEMPOTENCY_KEY_HEADER);

  const linkAuthToken = getLinkGuestAuth();
  if (linkAuthToken) {
    headers.set(LINK_CREDENTIAL_HEADER, linkAuthToken);
    return markRequestKeyed(await fetch(input, { ...init, headers, credentials: 'omit' }), keyed);
  }
  return markRequestKeyed(await fetch(input, { ...init, headers }), keyed);
};

// Explicit annotation keeps this export portable: the inferred `hc<AppType>`
// type transitively names branded symbols (`Idempotent`, `LedgerEntryKind`)
// that TypeScript cannot re-emit by reference (TS2883). `ReturnType<typeof
// hc<AppType>>` pins the same client type through a nameable alias.
export const client: ReturnType<typeof hc<AppType>> = hc<AppType>(getApiUrl(), {
  init: { credentials: 'include' },
  fetch: customFetch,
});

/**
 * The 200-family JSON body a typed Hono client response carries. Filters the
 * `ClientResponse` union down to its success (2xx) arms and extracts their
 * bodies, discarding the empty-object arms every route's uniform
 * `respondDomainError` / bare-`Response` tail contributes: a bare `Response`
 * infers as `TypedResponse` (output `unknown` → `{}`) spread across every status
 * code, so `{}` reappears at 200. `keyof O extends never` drops exactly those
 * pollution arms. Resolves to `never` when the route's 200 body never flowed
 * into `AppType` (an untyped `new Response(...)` tail or a 204) — the signal to
 * keep an explicit `<T>` at that call site.
 */
type SuccessJson<R> =
  R extends ClientResponse<infer O, infer S>
    ? S extends SuccessStatusCode
      ? keyof O extends never
        ? never
        : O
      : never
    : never;

/**
 * Unwrap a Hono RPC client Response.
 * On success (res.ok), returns parsed JSON, or `undefined as T` for 204 No Content.
 * On failure, throws ApiError with the error message from the response body.
 *
 * Called with a typed client response (`client.x.$get()`) and no explicit type
 * argument, the success body is inferred from `AppType` — no hand-written cast.
 * The explicit-`<T>` overload remains for responses the typed client cannot
 * describe (untyped/204 tails) or where a broader web-side contract applies.
 */
export function fetchJson<R extends ClientResponse<unknown>>(
  responsePromise: Promise<R>
): Promise<SuccessJson<R>>;
export function fetchJson<T>(responsePromise: Promise<Response>): Promise<T>;
export async function fetchJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const res = await responsePromise;
  if (!res.ok) {
    throw await apiErrorFromResponse(res);
  }
  // 204 No Content has no body; treat as undefined. Callers that expect a
  // payload should use a 200/201 endpoint instead.
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}
