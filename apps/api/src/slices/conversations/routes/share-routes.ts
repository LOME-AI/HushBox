import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { rejectInvalid, routeClass } from '../../../middleware/pipeline-manifest.js';
import {
  callerUserId,
  conversationIdParameterSchema,
  createSharedMessage,
  createSharedMessageBodySchema,
  createSharedMessageOutcomeSchema,
  readSharedMessage,
  shareIdParameterSchema,
} from '../domain/index.js';
import { respond200, runByKey } from './handler-tail.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function shareRoutes(deps: ConversationsRouteDeps) {
  return (
    new Hono<AppEnv>()
      .post(
        '/:conversationId/shares',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', createSharedMessageBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: createSharedMessageOutcomeSchema,
            execute: (tx) =>
              createSharedMessage(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                messageId: body.messageId,
                wrappedContentKey: body.wrappedContentKey,
              }),
          });
          return respond200(c, result);
        }
      )
      // Unauthenticated public read of one standalone shared message by its
      // share id. Per-IP throttling is `publicShareReadRateLimit`, declared
      // against this route key in the slice's posture fragment rather than
      // here — the fragment's keys are derived from this manifest, so a route
      // renamed here stops the fragment compiling. This handler
      // derives nothing from a session; the route class is `public`. The
      // static `shared/message` prefix never collides with `:conversationId`
      // (a uuid).
      .get(
        '/shared/message/:shareId',
        routeClass('public'),
        zValidator('param', shareIdParameterSchema, rejectInvalid),
        async (c) => {
          const { shareId } = c.req.valid('param');
          const result = await readSharedMessage(deps.stores(c.var.db), { shareId });
          return respond200(c, result);
        }
      )
  );
}
