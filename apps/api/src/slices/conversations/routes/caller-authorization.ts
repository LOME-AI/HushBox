import { ERROR_CODES, UPGRADE_TICKET_PARAM } from '@hushbox/shared';
import { respondDomainError } from '../../../middleware/pipeline-manifest.js';
import {
  consumeUpgradeTicket,
  createErrorResponse,
  LINK_CREDENTIAL_HEADER,
  resolveConversationCaller,
} from '../domain/index.js';
import type { Context } from 'hono';
import type { AppEnv, RefusalResponse } from '../../../middleware/pipeline-manifest.js';
import type { ConversationCaller, UpgradePrincipal } from '../domain/index.js';
import type { ConversationsRouteDeps } from './deps.js';

/**
 * Resolves and authorizes a guest-reachable read's caller, returning either the
 * `ConversationCaller` to proceed with or a terminal deny `Response`. A full
 * session wins; a link guest is admitted only for the conversation its
 * credential resolved to (the typed match — a guest of another conversation is
 * answered the blind not-found here, never this conversation's data). The
 * remaining active-member gate (a revoked guest whose row is left) is enforced
 * downstream by the domain read. `null` (no session, no live credential) is 401.
 */
export async function authorizeCaller(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string
): Promise<ConversationCaller | RefusalResponse> {
  const resolved = await resolveConversationCaller({
    principal: c.var.principal,
    linkCredential: c.req.header(LINK_CREDENTIAL_HEADER),
    linkResolution: deps.linkResolution(c.var.db),
  });
  if (resolved.isErr()) return respondDomainError(c, resolved.error);
  const caller = resolved.value;
  if (caller === null) {
    return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
  }
  if (caller.kind === 'linkGuest' && caller.conversationId !== conversationId) {
    return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
  }
  return caller;
}

/**
 * Resolves the WS upgrade's caller, or a terminal deny `Response`. A full
 * session wins through its cookie, as on every other route. A link guest
 * presents no credential here — a browser cannot set a header on
 * `new WebSocket`, and the credential is a secret that must never ride a URL —
 * so it presents a single-use ticket minted with its credential moments
 * before. The ticket is spent before anything else is checked, so a refused
 * upgrade cannot be retried with it. A ticket minted for another conversation
 * is answered the blind not-found; the active-member check is
 * {@link resolveUpgradePrincipal}'s, as for every caller.
 */
export async function authorizeUpgradeCaller(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string
): Promise<ConversationCaller | RefusalResponse> {
  const session = await resolveConversationCaller({
    principal: c.var.principal,
    linkCredential: undefined,
    linkResolution: deps.linkResolution(c.var.db),
  });
  if (session.isErr()) return respondDomainError(c, session.error);
  if (session.value !== null) return session.value;
  const ticket = c.req.query(UPGRADE_TICKET_PARAM);
  if (ticket === undefined) {
    return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
  }
  const grant = await consumeUpgradeTicket(c.var.redis, ticket);
  if (grant.isErr()) return respondDomainError(c, grant.error);
  if (grant.value === null) {
    return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
  }
  if (grant.value.conversationId !== conversationId) {
    return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
  }
  return { kind: 'linkGuest', linkId: grant.value.linkId, conversationId };
}

/**
 * Builds the WS upgrade principal for an authorized caller, or a deny
 * `Response`. A user forwards its session snapshot so the DO's broadcast-time
 * liveness check can cut the socket on later revocation. A link guest is
 * re-checked against its active member row HERE (the WS path runs no domain
 * read that would otherwise gate it): a revoked guest whose row is left is
 * answered the existence-hiding not-found (404), never upgraded. It upgrades
 * with `isGuest: true`, principalId = its linkId, and the link's display name.
 */
export async function resolveUpgradePrincipal(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  caller: ConversationCaller
): Promise<UpgradePrincipal | RefusalResponse> {
  return caller.kind === 'user'
    ? userUpgradePrincipal(deps, c, conversationId, caller.userId)
    : guestUpgradePrincipal(deps, c, conversationId, caller.linkId);
}

async function userUpgradePrincipal(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  userId: string
): Promise<UpgradePrincipal | RefusalResponse> {
  const member = await deps.stores(c.var.db).members.activeByUser(conversationId, userId);
  if (member.isErr()) return respondDomainError(c, member.error);
  // Existence-hiding not-found, mirroring the sibling GET /:conversationId
  // (its `{ refusal: 'not-found' }` → NOT_FOUND/404 in outcomes.ts): a
  // non-member's upgrade must be indistinguishable from an absent conversation.
  if (member.value === null) return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
  const principal = c.var.principal;
  // Forward the session snapshot so the DO's broadcast-time liveness check can
  // cut this socket on later revocation; a guest holds no revocable session.
  const session =
    principal.kind === 'full'
      ? { id: principal.claims.sessionId, createdAt: principal.claims.createdAt }
      : undefined;
  return { principalId: userId, isGuest: false, ...(session === undefined ? {} : { session }) };
}

async function guestUpgradePrincipal(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  linkId: string
): Promise<UpgradePrincipal | RefusalResponse> {
  const guest = await deps.stores(c.var.db).members.activeLinkGuest(conversationId, linkId);
  if (guest.isErr()) return respondDomainError(c, guest.error);
  // A revoked guest (member row left) is a non-member; answer the same
  // existence-hiding not-found the user path and the sibling GET use.
  if (guest.value === null) return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
  const displayName = guest.value.displayName;
  return {
    principalId: linkId,
    isGuest: true,
    ...(displayName === null ? {} : { displayName }),
  };
}
