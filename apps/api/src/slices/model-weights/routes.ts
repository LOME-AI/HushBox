import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES } from '@hushbox/shared';
import {
  defineSliceManifest,
  rejectInvalid,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  artifactContentType,
  artifactObjectKey,
  artifactParamsSchema,
  createErrorResponse,
} from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { ModelWeightsBindings } from './domain/index.js';

/**
 * The on-device model surface: `GET /models/:model/:version/:file` streams one
 * published artifact — weights, tokenizer, config, a voice blob — out of the
 * MODEL_WEIGHTS R2 bucket so the browser never fetches a model from a
 * third-party host. A missing binding or object answers 404 `NOT_FOUND`.
 *
 * It shares the `/models` mount with the catalog slice, which serves the
 * remote-model metadata read at `GET /models` and owns nothing here; the two
 * paths differ in depth, so neither shadows the other.
 *
 * The version is a PATH segment rather than a query or a header, which is what
 * makes the immutable cache declaration honest: a published artifact is never
 * rewritten under its own URL, and a client that pins a version can never mix
 * files across two of them.
 *
 * The handler is a pure path-to-object lookup — no session, no personalization,
 * no caller variation of any kind — which is the claim the storable declaration
 * in `apps/api/src/composition/route-cache-policy.ts` rests on, discharged by
 * the caller-invariance proof colocated with this slice.
 *
 * Per-IP window-capped and unauthenticated; this slice's `rate-limit-posture.ts`
 * states what that window prices.
 */
export function createModelWeightsManifest() {
  return defineSliceManifest({
    basePath: '/models',
    routes: new Hono<AppEnv>().get(
      '/:model/:version/:file',
      routeClass('public'),
      zValidator('param', artifactParamsSchema, rejectInvalid),
      async (c) => {
        const { model, version, file } = c.req.valid('param');
        const env: ModelWeightsBindings = c.env;
        const bucket = env.MODEL_WEIGHTS;
        if (bucket === undefined) {
          return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
        }
        const object = await bucket.get(artifactObjectKey(model, version, file));
        if (object === null) {
          return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
        }
        return new Response(object.body, {
          status: 200,
          headers: {
            'content-type': artifactContentType(file),
            'content-length': String(object.size),
          },
        });
      }
    ),
  });
}
