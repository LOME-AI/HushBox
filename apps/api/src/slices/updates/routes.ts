import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES } from '@hushbox/shared';
import {
  defineSliceManifest,
  rejectInvalid,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import { getChecksumOverride } from '../../middleware/checksum-override.js';
import { getVersionOverride } from '../../middleware/version-override.js';
import {
  bundleObjectKey,
  createErrorResponse,
  downloadParamsSchema,
  resolvePlatformChecksum,
  resolveServedVersion,
} from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { UpdatesBindings } from './domain/index.js';

/**
 * OTA update surface (both routes public; the version-check middleware
 * exempts the `/updates` prefix so a stale client can always reach them):
 *
 * - `GET /updates/current` — the served app version plus the requesting
 *   platform's current bundle sha256 `checksum` (selected by the
 *   `X-HushBox-Platform` header; omitted for a platform that never
 *   OTA-updates, and a defect in production for one that does). The
 *   dev-only overrides win over both: POST /dev/set-version so E2E can drive a
 *   mismatch, POST /dev/set-checksum so the locally built harness bundle is one
 *   the native client will accept.
 * - `GET /updates/download/:platform/:version` — streams the mobile bundle
 *   from the APP_BUILDS R2 bucket with immutable cache headers; a missing
 *   binding or object answers 404 `BUILD_NOT_FOUND`. Per-IP window-capped and
 *   unauthenticated; this slice's `rate-limit-posture.ts` states what that window
 *   prices.
 */
export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>()
      .get('/current', routeClass('public'), (c) => {
        const env: UpdatesBindings = c.env;
        const version = resolveServedVersion(getVersionOverride(), env.APP_VERSION);
        const platform = c.req.header('X-HushBox-Platform');
        const checksum = resolvePlatformChecksum(
          env,
          platform,
          getChecksumOverride(platform),
          c.var.envUtils.isProduction
        );
        return c.json({ version, checksum }, 200);
      })
      .get(
        '/download/:platform/:version',
        routeClass('public'),
        zValidator('param', downloadParamsSchema, rejectInvalid),
        async (c) => {
          const { platform, version } = c.req.valid('param');
          const env: UpdatesBindings = c.env;
          const bucket = env.APP_BUILDS;
          if (bucket === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.BUILD_NOT_FOUND), 404);
          }
          const object = await bucket.get(bundleObjectKey(platform, version));
          if (object === null) {
            return c.json(createErrorResponse(ERROR_CODES.BUILD_NOT_FOUND), 404);
          }
          return new Response(object.body, {
            status: 200,
            headers: {
              'content-type': 'application/zip',
              'content-length': String(object.size),
            },
          });
        }
      ),
  });
}
