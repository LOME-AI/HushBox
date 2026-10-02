import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  broadcastMemberAdded,
  broadcastMemberPrivilegeChanged,
  broadcastMemberRemoved,
  broadcastRotationComplete,
  callerUserId,
  changeLinkName,
  changeLinkNameBodySchema,
  changeLinkNameOutcomeSchema,
  changeLinkPrivilege,
  changeLinkPrivilegeBodySchema,
  changeLinkPrivilegeOutcomeSchema,
  conversationIdParameterSchema,
  createLinkBodySchema,
  createLinkOutcomeSchema,
  createSharedLink,
  isRefusal,
  linkParameterSchema,
  listSharedLinks,
  revokeLinkBodySchema,
  revokeLinkOutcomeSchema,
  revokeSharedLink,
} from '../domain/index.js';
import { respond200, respondOutcome, runByKey } from './handler-tail.js';
import { notifyMembershipEvent, broadcastAfterCommit, evictAfterCommit } from './post-commit.js';
import { authorizeCaller } from './caller-authorization.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function linkRoutes(deps: ConversationsRouteDeps) {
  return (
    new Hono<AppEnv>()
      .post(
        '/:conversationId/links',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', createLinkBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: createLinkOutcomeSchema,
            execute: (tx) =>
              createSharedLink(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                linkPublicKey: body.linkPublicKey,
                linkAuthHash: body.linkAuthHash,
                displayName: body.displayName ?? null,
                expiresAt: body.expiresAt ?? null,
                privilege: body.privilege,
                giveFullHistory: body.giveFullHistory,
                memberWrap: body.memberWrap,
                expectedEpoch: body.expectedEpoch,
                rotation: body.rotation,
              }),
          });
          // A created mint seats a real guest member; announce it, and refresh
          // the keychain when the mint rotated the epoch.
          if (result.isOk() && !isRefusal(result.value) && result.value.created) {
            const { memberId, newEpochNumber } = result.value;
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberAdded(deps.realtime(c.env), {
                conversationId,
                memberId,
                privilege: body.privilege,
              })
            );
            // The share grants conversation access to someone outside it, so
            // every member is nudged (the link guest itself has no account).
            notifyMembershipEvent(deps, c, { conversationId, actorUserId: caller });
            if (newEpochNumber !== null) {
              await broadcastAfterCommit(c, conversationId, () =>
                broadcastRotationComplete(deps.realtime(c.env), { conversationId, newEpochNumber })
              );
            }
          }
          return respond200(c, result);
        }
      )
      .get(
        '/:conversationId/links',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await listSharedLinks(deps.stores(c.var.db), { conversationId, caller });
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/links/:linkId/revoke',
        routeClass('session'),
        zValidator('param', linkParameterSchema, rejectInvalid),
        zValidator('json', revokeLinkBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, linkId } = c.req.valid('param');
          const { rotation } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, linkId, rotation },
            responseSchema: revokeLinkOutcomeSchema,
            execute: (tx) =>
              revokeSharedLink(deps.stores(tx), {
                conversationId,
                linkId,
                callerUserId: caller,
                rotation,
              }),
          });
          // A fresh revoke removed the guest and rotated: evict the link guest,
          // announce the removal (when a member existed), and refresh the chain.
          if (result.isOk() && !isRefusal(result.value) && 'newEpochNumber' in result.value) {
            const success = result.value;
            await evictAfterCommit(deps, c, conversationId, success.evicteePrincipalIds);
            const memberId = success.memberId;
            if (memberId !== null) {
              await broadcastAfterCommit(c, conversationId, () =>
                broadcastMemberRemoved(deps.realtime(c.env), { conversationId, memberId })
              );
            }
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastRotationComplete(deps.realtime(c.env), {
                conversationId,
                newEpochNumber: success.newEpochNumber,
              })
            );
          }
          return respond200(c, result);
        }
      )
      // Admin-driven link privilege change. The privilege lives on the link's
      // guest member row, so this updates that row (no rotation) and broadcasts
      // `member:privilege-changed` exactly like the member route. Responds
      // `{ changed: true }`; a missing/revoked link is not-found.
      .patch(
        '/:conversationId/links/:linkId/privilege',
        routeClass('session'),
        zValidator('param', linkParameterSchema, rejectInvalid),
        zValidator('json', changeLinkPrivilegeBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, linkId } = c.req.valid('param');
          const { privilege } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, linkId, privilege },
            responseSchema: changeLinkPrivilegeOutcomeSchema,
            execute: (tx) =>
              changeLinkPrivilege(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                linkId,
                privilege,
              }),
          });
          if (result.isOk() && !isRefusal(result.value) && result.value.memberId !== null) {
            const memberId = result.value.memberId;
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberPrivilegeChanged(deps.realtime(c.env), {
                conversationId,
                memberId,
                privilege,
              })
            );
          }
          return result.match(
            (outcome) => respondOutcome(c, outcome, () => c.json({ changed: true as const }, 200)),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Admin-driven link display-name change. Responds `{ success: true }`; a
      // missing/revoked link is not-found.
      .patch(
        '/:conversationId/links/:linkId/name',
        routeClass('session'),
        zValidator('param', linkParameterSchema, rejectInvalid),
        zValidator('json', changeLinkNameBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, linkId } = c.req.valid('param');
          const { displayName } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, linkId, displayName },
            responseSchema: changeLinkNameOutcomeSchema,
            execute: (tx) =>
              changeLinkName(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                linkId,
                displayName,
              }),
          });
          return respond200(c, result);
        }
      )
  );
}
