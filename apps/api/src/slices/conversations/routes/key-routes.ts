import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  callerUserId,
  conversationIdParameterSchema,
  getKeyChain,
  getKeyChainBatch,
  getMemberKeys,
  getMyName,
  idempotencyExempt,
  idempotent,
  memberKeysBatchQuerySchema,
  runMutation,
  setMyNameBodySchema,
  setMyNameTransition,
} from '../domain/index.js';
import { respond200 } from './handler-tail.js';
import { authorizeCaller } from './caller-authorization.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function keyRoutes(deps: ConversationsRouteDeps) {
  return (
    new Hono<AppEnv>()
      .get(
        '/:conversationId/keychain',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await getKeyChain(deps.stores(c.var.db), { conversationId, caller });
          return respond200(c, result);
        }
      )
      // The authoritative active-member public-key set — every epoch rotation's
      // wrap-set input, so no rotation works without it. Read-privilege (any
      // active member, including a link guest), not admin: a departing non-owner
      // re-wraps for everyone.
      .get(
        '/:conversationId/member-keys',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await getMemberKeys(deps.stores(c.var.db), { conversationId, caller });
          return respond200(c, result);
        }
      )
      // The caller's own membership identity — display label + privilege — the
      // guest-reachable read a shared-link visitor uses to render itself. Same
      // shape for a user (username) and a link guest (link display name).
      .get(
        '/:conversationId/my-name',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await getMyName(deps.stores(c.var.db), { conversationId, caller });
          return respond200(c, result);
        }
      )
      // A link guest renames its own display label. Guest-self, so it takes the
      // `public` class (the HTTP matrix admits no guest principal) and resolves
      // the caller from its link credential exactly like the read above; a
      // full-session user is refused (no link display name to set). Naturally
      // idempotent — the conditional write is the dedup.
      .patch(
        '/:conversationId/my-name',
        routeClass('public'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', setMyNameBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { displayName } = c.req.valid('json');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await runMutation(() =>
            idempotent.byTransition(
              setMyNameTransition(deps.stores(c.var.db), { conversationId, caller, displayName })
            )
          );
          return respond200(c, result);
        }
      )
      // Batch keychain refresh for the conversation list. A read, so it is a GET
      // with a comma-separated `conversationIds` query — the static
      // `member-keys/batch` segment never collides with `:conversationId`
      // (a uuid). Always 200: inaccessible ids ride `missing`, never a 404.
      .get(
        '/member-keys/batch',
        routeClass('session'),
        zValidator('query', memberKeysBatchQuerySchema, rejectInvalid),
        async (c) => {
          const { conversationIds } = c.req.valid('query');
          const result = await getKeyChainBatch(deps.stores(c.var.db), {
            conversationIds,
            callerUserId: callerUserId(c.var.principal),
          });
          return result.match(
            (view) => c.json(view, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
  );
}
