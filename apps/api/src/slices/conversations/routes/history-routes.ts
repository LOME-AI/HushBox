import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createForkBodySchema, renameForkBodySchema } from '@hushbox/shared';
import { rejectInvalid, routeClass } from '../../../middleware/pipeline-manifest.js';
import {
  broadcastForkCreated,
  broadcastForkDeleted,
  broadcastForkRenamed,
  callerUserId,
  conversationIdParameterSchema,
  createFork,
  createForkOutcomeSchema,
  deleteFork,
  deleteForkOutcomeSchema,
  forkParameterSchema,
  getMessageHistory,
  isRefusal,
  listForks,
  messageHistoryQuerySchema,
  renameFork,
  renameForkOutcomeSchema,
  updateForkTip,
  updateForkTipBodySchema,
  updateForkTipOutcomeSchema,
} from '../domain/index.js';
import { respond200, runByKey } from './handler-tail.js';
import { notifyMembershipEvent, broadcastAfterCommit } from './post-commit.js';
import { authorizeCaller } from './caller-authorization.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function historyRoutes(deps: ConversationsRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Guest-reachable history read — the path a second device, a reload, a
      // newly-added member, or a shared-link guest has to load prior messages.
      // `public` (the HTTP matrix admits no guest principal) with explicit
      // caller resolution, exactly like the keychain/members reads a guest also
      // needs; membership-gated, served from the caller's `visibleFromEpoch`
      // forward so a rotation-seated guest never reads pre-join history.
      .get(
        '/:conversationId/messages',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('query', messageHistoryQuerySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { cursor, limit } = c.req.valid('query');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await getMessageHistory(deps.stores(c.var.db), {
            conversationId,
            caller,
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          });
          return respond200(c, result);
        }
      )
      .get(
        '/:conversationId/forks',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await listForks(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/forks',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', createForkBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: createForkOutcomeSchema,
            execute: (tx) =>
              createFork(deps.stores(tx), { conversationId, callerUserId: caller, ...body }),
          });
          // Emit fork:created only for a genuinely new branch (a converged
          // re-create is a no-op). The event reads the inserted row, never the
          // returned list: that list is floored to what the caller may see, so
          // a branch tipped below the creator's own floor is absent from it
          // while still committing and still owing every other member an event.
          if (result.isOk() && !isRefusal(result.value)) {
            const { created } = result.value;
            if (created !== null) {
              await broadcastAfterCommit(c, conversationId, () =>
                broadcastForkCreated(deps.realtime(c.env), {
                  conversationId,
                  forkId: created.id,
                  name: created.name,
                  tipMessageId: created.tipMessageId,
                })
              );
              notifyMembershipEvent(deps, c, { conversationId, actorUserId: caller });
            }
          }
          return respond200(c, result);
        }
      )
      .patch(
        '/:conversationId/forks/:forkId',
        routeClass('session'),
        zValidator('param', forkParameterSchema, rejectInvalid),
        zValidator('json', renameForkBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, forkId } = c.req.valid('param');
          const { name } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, forkId, name },
            responseSchema: renameForkOutcomeSchema,
            execute: (tx) =>
              renameFork(deps.stores(tx), { conversationId, forkId, callerUserId: caller, name }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            // Bind the renamed name before the closure — control-flow narrowing
            // of `result.value` does not survive into a nested function.
            const renamedName = result.value.fork.name;
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastForkRenamed(deps.realtime(c.env), {
                conversationId,
                forkId,
                name: renamedName,
              })
            );
          }
          return respond200(c, result);
        }
      )
      .put(
        '/:conversationId/forks/:forkId/tip',
        routeClass('session'),
        zValidator('param', forkParameterSchema, rejectInvalid),
        zValidator('json', updateForkTipBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, forkId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, forkId, ...body },
            responseSchema: updateForkTipOutcomeSchema,
            execute: (tx) =>
              updateForkTip(deps.stores(tx), {
                conversationId,
                forkId,
                callerUserId: caller,
                ...body,
              }),
          });
          return respond200(c, result);
        }
      )
      .delete(
        '/:conversationId/forks/:forkId',
        routeClass('session'),
        zValidator('param', forkParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId, forkId } = c.req.valid('param');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, forkId },
            responseSchema: deleteForkOutcomeSchema,
            execute: (tx) =>
              deleteFork(
                deps.stores(tx),
                { conversationId, forkId, callerUserId: caller },
                deps.deleteForkMessages(tx)
              ),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastForkDeleted(deps.realtime(c.env), { conversationId, forkId })
            );
          }
          return respond200(c, result);
        }
      )
  );
}
