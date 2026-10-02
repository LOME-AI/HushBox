import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';

import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  bannerHashQuerySchema,
  callerUserId,
  getActiveBanner,
  getBannerDismissal,
  idempotencyExempt,
  idempotent,
  putBannerDismissalBodySchema,
  runMutation,
  saveBannerDismissal,
} from './domain/index.js';

import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { AnnouncementsStoresFactory } from './domain/index.js';

interface AnnouncementsRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: AnnouncementsStoresFactory;
}

/**
 * The announcements slice's HTTP surface. `GET /banner` is public and
 * edge-cacheable (user-agnostic). The per-user dismissal routes are
 * `session`-class; the write is `naturally-idempotent` (a repeat converges on
 * the same one-row-per-user state through `idempotent.byUpsert`).
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createAnnouncementsManifest(deps: AnnouncementsRouteDeps) {
  return defineSliceManifest({
    basePath: '/announcements',
    routes: new Hono<AppEnv>()
      .get('/banner', routeClass('public'), async (c) => {
        const result = await getActiveBanner(deps.stores(c.var.db).config);
        return result.match(
          ({ response, droppedCount }) => {
            if (droppedCount > 0) {
              c.var.logger.warn('banner.config.salvaged', { droppedCount });
            }
            return c.json(response, 200);
          },
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/banner/dismissal',
        routeClass('session'),
        zValidator('query', bannerHashQuerySchema, rejectInvalid),
        async (c) => {
          const { hash } = c.req.valid('query');
          const result = await getBannerDismissal(
            deps.stores(c.var.db).dismissals,
            callerUserId(c.var.principal),
            hash
          );
          return result.match(
            (state) => c.json(state, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .put(
        '/banner/dismissal',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', putBannerDismissalBodySchema, rejectInvalid),
        async (c) => {
          const { hash } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              saveBannerDismissal(
                deps.stores(c.var.db).dismissals,
                callerUserId(c.var.principal),
                hash
              )
            )
          );
          return result.match(
            (state) => c.json(state, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
