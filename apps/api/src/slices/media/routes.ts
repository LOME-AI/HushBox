import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES } from '@hushbox/shared';
import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  LINK_CREDENTIAL_HEADER,
  consumeLinkMint,
  contentItemParameterSchema,
  createErrorResponse,
  mintDownloadUrl,
  reserveShareRemint,
  resolveMediaCaller,
  sharedPresignParameterSchema,
} from './domain/index.js';
import type { Context } from 'hono';
import type { AppEnv, RefusalResponse } from '../../middleware/pipeline-manifest.js';
import type {
  LinkResolutionPort,
  MintDownloadUrlDeps,
  PresignReaders,
  Storage,
} from './domain/index.js';

/** The pipeline's per-request database handle, named without importing the infra module. */
type RequestDb = AppEnv['Variables']['db'];

export interface MediaRouteDeps {
  /** Presign readers over the owning slices' rows, bound to the request db. */
  readonly readers: (db: RequestDb) => PresignReaders;
  /**
   * The Storage port; the composition root binds R2 config from env. The
   * per-request db is threaded through because the R2 factory records CI
   * service-evidence through it — a bound-at-request concern, not a static one.
   */
  readonly storage: (env: AppEnv['Bindings'], db: RequestDb) => Storage;
  /** Shared-link credential resolution (the identity slice's port). */
  readonly linkResolution: (db: RequestDb) => LinkResolutionPort;
}

function respondRateLimited(c: Context<AppEnv>, retryAfterSeconds: number): RefusalResponse {
  return c.json(createErrorResponse(ERROR_CODES.RATE_LIMITED, { retryAfterSeconds }), 429);
}

function mintDeps(deps: MediaRouteDeps, c: Context<AppEnv>): MintDownloadUrlDeps {
  return {
    readers: deps.readers(c.var.db),
    storage: deps.storage(c.env, c.var.db),
    now: () => new Date(),
  };
}

// No return annotation on purpose: the chained route schema must flow through
// `defineSliceManifest`'s generic so `AppType` (and the typed client) carry
// this slice's routes — an explicit `Hono<AppEnv>` would erase it to
// `BlankSchema`.
export function createMediaManifest(deps: MediaRouteDeps) {
  return defineSliceManifest({
    basePath: '/media',
    routes: new Hono<AppEnv>()
      // Member path. `public` route class by necessity, not laxity: the HTTP
      // matrix admits no link-guest principal, so the handler resolves the
      // caller itself (full session OR link credential) and everyone else is
      // answered 401 here. Three edge layers below, three jobs: per-caller mint
      // throttling is the `mediaDownloadUserRateLimit` registry entry, and the
      // pre-resolution per-IP throttle in front of it bounds the credential
      // lookups a sessionless caller can buy. Both of those are per network, so
      // a third layer and a fourth window bound one LINK across all networks at
      // once — the member counterpart of the share path's re-mint cap: the
      // lookup layer here, and the mint window in the handler once the link has
      // a resolved id.
      .get(
        '/:contentItemId/download-url',
        routeClass('public'),
        zValidator('param', contentItemParameterSchema, rejectInvalid),
        async (c) => {
          const { contentItemId } = c.req.valid('param');
          const caller = await resolveMediaCaller({
            principal: c.var.principal,
            linkCredential: c.req.header(LINK_CREDENTIAL_HEADER),
            linkResolution: deps.linkResolution(c.var.db),
          });
          if (caller.isErr()) return respondDomainError(c, caller.error);
          if (caller.value === null) {
            return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
          }
          if (caller.value.kind === 'linkGuest') {
            const linkGate = await consumeLinkMint(c.var.redis, caller.value.linkId);
            /* v8 ignore next -- the same-redis pipeline posture stage fails closed (503) before this handler runs, so the window is only consumed when Redis is healthy; a mid-handler Redis fault is not deterministically reproducible (the counting primitive's own fail-closed path is covered in lib/rate-limit/consume.integration.test.ts) */
            if (linkGate.isErr()) return respondDomainError(c, linkGate.error);
            if (!linkGate.value.allowed) {
              return respondRateLimited(c, linkGate.value.retryAfterSeconds);
            }
          }
          const minted = await mintDownloadUrl(mintDeps(deps, c), caller.value, contentItemId);
          return minted.match(
            (grant) => c.json(grant, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Share carve-out: unauthenticated by design (a valid shareId is the
      // capability), scoped to exactly that shared message's content items by
      // the authorization. Per-IP throttling is a registry entry for the edge
      // enforcer (`sharePresignIpRateLimit`); the per-shareId re-mint cap is
      // enforced HERE, before any lookup, so a leaked shareId cannot probe or
      // re-arm URLs without bound.
      .get(
        '/shared/:shareId/:contentItemId/download-url',
        routeClass('public'),
        zValidator('param', sharedPresignParameterSchema, rejectInvalid),
        // Per-IP cap (`sharePresignIpRateLimit`, declared in this slice's
        // posture fragment and spent by the pipeline stage) alongside the
        // in-handler per-shareId re-mint cap below — the IP cap bounds one
        // caller across shares, the shareId cap bounds one leaked share
        // across callers.
        async (c) => {
          const { shareId, contentItemId } = c.req.valid('param');
          const gate = await reserveShareRemint(c.var.redis, shareId);
          /* v8 ignore next -- the same-redis pipeline posture stage fails closed (503) on any Redis outage before this handler runs, so reserveShareRemint only executes when Redis is healthy; a mid-handler Redis fault is not deterministically reproducible */
          if (gate.isErr()) return respondDomainError(c, gate.error);
          if (!gate.value.allowed) return respondRateLimited(c, gate.value.retryAfterSeconds);
          const minted = await mintDownloadUrl(
            mintDeps(deps, c),
            { kind: 'share', shareId },
            contentItemId
          );
          return minted.match(
            (grant) => c.json(grant, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
