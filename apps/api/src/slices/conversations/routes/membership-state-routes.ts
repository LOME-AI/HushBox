import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { updateTitleBodySchema } from '@hushbox/shared';
import { rejectInvalid, routeClass } from '../../../middleware/pipeline-manifest.js';
import {
  acceptInviteTransition,
  advanceLastReadSeqTransition,
  broadcastMemberPrivilegeChanged,
  broadcastMemberRemoved,
  callerUserId,
  changeMemberPrivilege,
  changePrivilegeBodySchema,
  changePrivilegeOutcomeSchema,
  conversationIdParameterSchema,
  declineInviteTransition,
  idempotencyExempt,
  idempotent,
  isRefusal,
  memberParameterSchema,
  muteBodySchema,
  pinBodySchema,
  readCursorBodySchema,
  runMutation,
  setMutedTransition,
  setPinnedTransition,
  updateConversationTitle,
  updateTitleOutcomeSchema,
} from '../domain/index.js';
import { respond200, runByKey } from './handler-tail.js';
import { broadcastAfterCommit, evictAfterCommit } from './post-commit.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function membershipStateRoutes(deps: ConversationsRouteDeps) {
  return (
    new Hono<AppEnv>()
      .patch(
        '/:conversationId/membership/mute',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', muteBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { muted } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byTransition(
              setMutedTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: callerUserId(c.var.principal),
                muted,
              })
            )
          );
          return respond200(c, result);
        }
      )
      .patch(
        '/:conversationId/membership/pin',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', pinBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { pinned } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byTransition(
              setPinnedTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: callerUserId(c.var.principal),
                pinned,
              })
            )
          );
          return respond200(c, result);
        }
      )
      // Read acknowledgement: the write is `GREATEST(lastReadSeq, $new)`, so a
      // replayed or reordered acknowledgement converges instead of regressing —
      // naturally idempotent, no Idempotency-Key.
      .patch(
        '/:conversationId/read',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', readCursorBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { lastReadSeq } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byTransition(
              advanceLastReadSeqTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: callerUserId(c.var.principal),
                lastReadSeq,
              })
            )
          );
          return respond200(c, result);
        }
      )
      // Accept a pending invite: naturally idempotent (an already-accepted
      // membership replays 200), so it carries no Idempotency-Key.
      .patch(
        '/:conversationId/membership/accept',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await runMutation(() =>
            idempotent.byTransition(
              acceptInviteTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: callerUserId(c.var.principal),
              })
            )
          );
          return respond200(c, result);
        }
      )
      // Decline a pending invite (accepted members must `/leave` with a
      // rotation). Naturally idempotent — a repeat answers not-found. Broadcasts
      // the departure so peers refresh their member list.
      .post(
        '/:conversationId/membership/decline',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = callerUserId(c.var.principal);
          const result = await runMutation(() =>
            idempotent.byTransition(
              declineInviteTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: caller,
              })
            )
          );
          if (result.isOk() && !isRefusal(result.value)) {
            const { memberId, evicteePrincipalIds } = result.value;
            await evictAfterCommit(deps, c, conversationId, evicteePrincipalIds);
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberRemoved(deps.realtime(c.env), {
                conversationId,
                memberId,
                userId: caller,
              })
            );
          }
          return respond200(c, result);
        }
      )
      // Admin-driven member privilege change (the legacy ladder ported exactly
      // in `changeMemberPrivilege`). A mutation, so it takes an Idempotency-Key.
      .patch(
        '/:conversationId/member/:memberId/privilege',
        routeClass('session'),
        zValidator('param', memberParameterSchema, rejectInvalid),
        zValidator('json', changePrivilegeBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, memberId } = c.req.valid('param');
          const { privilege } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, memberId, privilege },
            responseSchema: changePrivilegeOutcomeSchema,
            execute: (tx) =>
              changeMemberPrivilege(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                memberId,
                privilege,
              }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberPrivilegeChanged(deps.realtime(c.env), {
                conversationId,
                memberId,
                privilege,
              })
            );
          }
          return respond200(c, result);
        }
      )
      // Owner-only title update. The title is opaque ciphertext; the body hash
      // and the byKey replay treat it as bytes.
      .patch(
        '/:conversationId',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', updateTitleBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: updateTitleOutcomeSchema,
            execute: (tx) =>
              updateConversationTitle(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                title: body.title,
                titleEpochNumber: body.titleEpochNumber,
              }),
          });
          return respond200(c, result);
        }
      )
  );
}
