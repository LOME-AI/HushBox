import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ERROR_CODE_BUILD_NOT_FOUND } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';

export const updatesRoute = new Hono<AppEnv>()
  .get('/current', (c) => {
    return c.json({ version: c.env.APP_VERSION }, 200);
  })

  .get(
    '/download/:version',
    zValidator('param', z.object({ version: z.string().min(1) })),
    async (c) => {
      const { version } = c.req.valid('param');
      const bucket = c.env.APP_BUILDS;

      if (!bucket) {
        return c.json(createErrorResponse(ERROR_CODE_BUILD_NOT_FOUND), 404);
      }

      const object = await bucket.get(`builds/${version}.zip`);
      if (!object) {
        return c.json(createErrorResponse(ERROR_CODE_BUILD_NOT_FOUND), 404);
      }

      return new Response(object.body, {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-length': String(object.size),
          'cache-control': 'public, max-age=86400, immutable',
        },
      });
    }
  );
