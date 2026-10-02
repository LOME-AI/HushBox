import { Hono } from 'hono';
import {
  defineSliceManifest,
  respondDomainError,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import { listModels } from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';

/**
 * The models slice's HTTP surface: the public catalog list. `public`-class by
 * design — the marketing site fetches it unauthenticated at build time, and
 * the picker loads it before login. Read-only, so no idempotency machinery.
 *
 * Per-IP window-capped: unauthenticated and one catalog read per request.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createModelsManifest() {
  return defineSliceManifest({
    basePath: '/models',
    routes: new Hono<AppEnv>().get('/', routeClass('public'), async (c) => {
      const result = await listModels({ db: c.var.db, telemetry: c.var.logger }, Date.now());
      return result.match(
        (response) => c.json(response, 200),
        (error) => respondDomainError(c, error)
      );
    }),
  });
}
