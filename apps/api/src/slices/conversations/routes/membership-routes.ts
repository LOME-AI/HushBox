import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { rotateEpochBodySchema } from '@hushbox/shared';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  FINGERPRINT_CODES,
  addMember,
  addMemberBodySchema,
  addMemberOutcomeSchema,
  broadcastMemberAdded,
  broadcastMemberRemoved,
  broadcastRotationComplete,
  callerUserId,
  conversationIdParameterSchema,
  deleteConversation,
  deleteConversationOutcomeSchema,
  isRefusal,
  leaveBodySchema,
  leaveConversation,
  leaveOutcomeSchema,
  listMembers,
  memberParameterSchema,
  removeMember,
  removeMemberBodySchema,
  removeMemberOutcomeSchema,
  rotateEpoch,
  rotateEpochDomainOutcomeSchema,
} from '../domain/index.js';
import { respond200, respondOutcome, runByKey } from './handler-tail.js';
import { notifyMembershipEvent, broadcastAfterCommit, evictAfterCommit } from './post-commit.js';
import { authorizeCaller } from './caller-authorization.js';
import type { DeleteConversationResponse, RotateEpochOutcome } from '@hushbox/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function membershipRoutes(deps: ConversationsRouteDeps) {
  return new Hono<AppEnv>()
    .delete(
      '/:conversationId',
      routeClass('session'),
      zValidator('param', conversationIdParameterSchema, rejectInvalid),
      async (c) => {
        const { conversationId } = c.req.valid('param');
        const caller = callerUserId(c.var.principal);
        const result = await runByKey({
          c,
          body: { conversationId },
          responseSchema: deleteConversationOutcomeSchema,
          execute: (tx) =>
            deleteConversation(deps.stores(tx), { conversationId, callerUserId: caller }),
        });
        if (result.isOk() && !isRefusal(result.value)) {
          await evictAfterCommit(deps, c, conversationId, result.value.evicteePrincipalIds);
        }
        return result.match(
          (outcome) =>
            respondOutcome(c, outcome, () =>
              c.json({ deleted: true as const } satisfies DeleteConversationResponse, 200)
            ),
          (error) => respondDomainError(c, error)
        );
      }
    )
    .get(
      '/:conversationId/members',
      routeClass('public'),
      zValidator('param', conversationIdParameterSchema, rejectInvalid),
      async (c) => {
        const { conversationId } = c.req.valid('param');
        const caller = await authorizeCaller(deps, c, conversationId);
        if (caller instanceof Response) return caller;
        const result = await listMembers(deps.stores(c.var.db), { conversationId, caller });
        return respond200(c, result);
      }
    )
    .post(
      '/:conversationId/members',
      routeClass('session'),
      zValidator('param', conversationIdParameterSchema, rejectInvalid),
      zValidator('json', addMemberBodySchema, rejectInvalid),
      async (c) => {
        const { conversationId } = c.req.valid('param');
        const body = c.req.valid('json');
        const caller = callerUserId(c.var.principal);
        const result = await runByKey({
          c,
          body: { conversationId, ...body },
          responseSchema: addMemberOutcomeSchema,
          execute: (tx) =>
            addMember(deps.stores(tx), { conversationId, callerUserId: caller, body }),
        });
        if (result.isOk() && !isRefusal(result.value)) {
          const { member, newEpochNumber } = result.value;
          await broadcastAfterCommit(c, conversationId, () =>
            broadcastMemberAdded(deps.realtime(c.env), {
              conversationId,
              memberId: member.id,
              /* v8 ignore next -- {@link addMember} refuses when the user lookup
                 answers null, so every member it returns carries a user id; the
                 nullable field belongs to the shared member view, whose link
                 guests this route cannot create */
              userId: member.userId ?? undefined,
              privilege: member.privilege,
            })
          );
          // Only the added member is nudged — the rest of the conversation
          // learns through the broadcast above.
          /* v8 ignore else -- an added member always carries a user id, for the
             reason the broadcast's `userId` read states */
          if (member.userId !== null) {
            notifyMembershipEvent(deps, c, {
              conversationId,
              actorUserId: caller,
              recipientUserIds: [member.userId],
            });
          }
          // A full-history add leaves the epoch unchanged (null); only an
          // add-with-rotation advances it, so only then does a connected
          // device need to refetch the keychain.
          if (newEpochNumber !== null) {
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastRotationComplete(deps.realtime(c.env), { conversationId, newEpochNumber })
            );
          }
        }
        return respond200(c, result);
      }
    )
    .post(
      '/:conversationId/members/:memberId/remove',
      routeClass('session'),
      zValidator('param', memberParameterSchema, rejectInvalid),
      zValidator('json', removeMemberBodySchema, rejectInvalid),
      async (c) => {
        const { conversationId, memberId } = c.req.valid('param');
        const { rotation } = c.req.valid('json');
        const caller = callerUserId(c.var.principal);
        const result = await runByKey({
          c,
          body: { conversationId, memberId, rotation },
          responseSchema: removeMemberOutcomeSchema,
          execute: (tx) =>
            removeMember(deps.stores(tx), (id) => deps.billing.deleteMemberBudgetWithinTx(tx, id), {
              conversationId,
              memberId,
              callerUserId: caller,
              rotation,
            }),
        });
        if (result.isOk() && !isRefusal(result.value)) {
          const { newEpochNumber } = result.value;
          await evictAfterCommit(deps, c, conversationId, result.value.evicteePrincipalIds);
          await broadcastAfterCommit(c, conversationId, () =>
            broadcastMemberRemoved(deps.realtime(c.env), { conversationId, memberId })
          );
          await broadcastAfterCommit(c, conversationId, () =>
            broadcastRotationComplete(deps.realtime(c.env), { conversationId, newEpochNumber })
          );
        }
        return result.match(
          (outcome) =>
            respondOutcome(c, outcome, (success) =>
              c.json({ removed: true as const, newEpochNumber: success.newEpochNumber }, 200)
            ),
          (error) => respondDomainError(c, error)
        );
      }
    )
    .post(
      '/:conversationId/leave',
      routeClass('session'),
      zValidator('param', conversationIdParameterSchema, rejectInvalid),
      zValidator('json', leaveBodySchema, rejectInvalid),
      async (c) => {
        const { conversationId } = c.req.valid('param');
        const caller = callerUserId(c.var.principal);
        const result = await runByKey({
          c,
          body: { conversationId },
          responseSchema: leaveOutcomeSchema,
          execute: (tx) =>
            leaveConversation(
              deps.stores(tx),
              (id) => deps.billing.deleteMemberBudgetWithinTx(tx, id),
              { conversationId, callerUserId: caller }
            ),
        });
        if (result.isOk() && !isRefusal(result.value)) {
          const success = result.value;
          await evictAfterCommit(deps, c, conversationId, success.evicteePrincipalIds);
          // The owner's leave deletes the conversation (no surviving room to
          // notify); a non-owner's leave rotates nothing, so peers get the
          // departure alone and learn of the pending rotation from the keychain.
          if ('left' in success) {
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberRemoved(deps.realtime(c.env), {
                conversationId,
                memberId: success.memberId,
                userId: caller,
              })
            );
          }
        }
        return result.match(
          (outcome) =>
            respondOutcome(c, outcome, (success) =>
              'left' in success
                ? c.json({ left: true as const }, 200)
                : c.json({ deleted: true as const }, 200)
            ),
          (error) => respondDomainError(c, error)
        );
      }
    )
    .post(
      '/:conversationId/epochs',
      routeClass('session'),
      zValidator('param', conversationIdParameterSchema, rejectInvalid),
      zValidator('json', rotateEpochBodySchema, rejectInvalid),
      async (c) => {
        const { conversationId } = c.req.valid('param');
        const body = c.req.valid('json');
        const caller = callerUserId(c.var.principal);
        const result = await runByKey({
          c,
          body: { conversationId, ...body },
          responseSchema: rotateEpochDomainOutcomeSchema,
          execute: (tx) =>
            rotateEpoch(deps.stores(tx), { conversationId, callerUserId: caller, body }),
        });
        if (result.isOk() && !isRefusal(result.value) && result.value.rotated) {
          const { newEpochNumber } = result.value;
          await broadcastAfterCommit(c, conversationId, () =>
            broadcastRotationComplete(deps.realtime(c.env), { conversationId, newEpochNumber })
          );
          if (body.predecessorEpoch !== undefined && body.predecessorEpoch < body.expectedEpoch) {
            reportSupersededEpoch(c, {
              conversationId,
              supersededEpoch: body.expectedEpoch,
              predecessorEpoch: body.predecessorEpoch,
            });
          }
        }
        return result.match(
          (outcome) =>
            respondOutcome(c, outcome, (success) =>
              c.json(success satisfies RotateEpochOutcome, 200)
            ),
          (error) => respondDomainError(c, error)
        );
      }
    );
}

/**
 * An accepted recovery is the report that an epoch's keys did not verify: the
 * server holds no key, so this capture is the one channel an operator learns
 * of a bad rotation on. Identifiers only.
 */
function reportSupersededEpoch(
  c: Context<AppEnv>,
  superseded: {
    readonly conversationId: string;
    readonly supersededEpoch: number;
    readonly predecessorEpoch: number;
  }
): void {
  const error = new Error('conversations: a recovery rotation superseded an unverifiable epoch');
  error.name = 'EpochRotationSuperseded';
  Object.assign(error, superseded);
  c.var.logger.captureError(error, FINGERPRINT_CODES.epochRotationSuperseded);
}
