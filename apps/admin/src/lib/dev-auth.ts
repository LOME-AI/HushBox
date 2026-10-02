import { CF_ACCESS_JWT_HEADER, devAdminTokenResponseSchema } from '@hushbox/shared';

/** Relative mint path — rides the same `/api` proxy as every other call. */
const DEV_TOKEN_MINT_PATH = '/api/dev/admin-token';

interface DevAuthFetchDeps {
  readonly baseFetch: typeof fetch;
  /** Computed once from env (`isDevAuthEnabled()`): local dev or E2E, never production. */
  readonly enabled: boolean;
  readonly getActor: () => string;
}

interface CachedToken {
  readonly actor: string;
  readonly token: string;
}

/**
 * Fetch wrapper supplying admin authentication in local dev and E2E runs.
 *
 * When enabled it lazily mints a dev Access JWT for the CURRENT actor from
 * the dev-only mint route, caches it in memory only (never localStorage or
 * sessionStorage — a persisted admin credential outlives the tab), attaches
 * it as `Cf-Access-Jwt-Assertion`, and on a 401 re-mints once and retries
 * (dev tokens are short-lived). Switching actor changes the cache key, so the
 * next request mints for the new identity.
 *
 * A response it discards — a failed mint, the 401 it retries past — is read
 * first, never cancelled: in Chromium an unread no-store body keeps its load
 * pending until the page unloads, and a cancel reports as an aborted request.
 *
 * When disabled (production) it attaches nothing: Cloudflare Access injects
 * the header at the edge before the request reaches the Worker.
 */
export function createDevAuthFetch(deps: DevAuthFetchDeps): typeof fetch {
  let cached: CachedToken | null = null;

  async function mint(actor: string): Promise<string> {
    const res = await deps.baseFetch(`${DEV_TOKEN_MINT_PATH}?email=${encodeURIComponent(actor)}`);
    if (!res.ok) {
      await res.text();
      throw new Error(`dev admin token mint failed: ${String(res.status)}`);
    }
    return devAdminTokenResponseSchema.parse(await res.json()).token;
  }

  return async (input, init) => {
    if (!deps.enabled) {
      return deps.baseFetch(input, init);
    }

    const actor = deps.getActor();
    if (cached?.actor !== actor) {
      cached = { actor, token: await mint(actor) };
    }

    const send = (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set(CF_ACCESS_JWT_HEADER, token);
      return deps.baseFetch(input, { ...init, headers });
    };

    let res = await send(cached.token);
    if (res.status === 401) {
      await res.text();
      cached = { actor, token: await mint(actor) };
      res = await send(cached.token);
    }
    return res;
  };
}
