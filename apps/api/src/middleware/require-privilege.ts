import type { Context, MiddlewareHandler, Next } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { conversationMembers, conversations } from '@hushbox/db';
import type { Database } from '@hushbox/db';
import {
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_NOT_AUTHENTICATED,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  getPrivilegeLevel,
} from '@hushbox/shared';
import type { MemberPrivilege } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { createErrorResponse } from '../lib/error-response.js';
import { resolveLinkGuest } from './resolve-link-guest.js';
import { LINK_PUBLIC_KEY_HEADER } from './constants.js';

interface PrivilegeOptions {
  /** When true, allows link guests (via x-link-public-key header) when no session user is present. */
  allowLinkGuest?: boolean;
  /** When true, queries conversation owner and sets `c.set('conversationOwnerId', ownerId)`. */
  includeOwnerId?: boolean;
}

/** Looks up the conversation owner userId. Returns null if conversation not found. */
async function lookupConversationOwner(
  db: Database,
  conversationId: string
): Promise<string | null> {
  const row = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
    .then((rows) => rows[0]);
  return row?.userId ?? null;
}

/**
 * Sets conversationOwnerId on context. Returns 404 response if conversation not found.
 */
async function setConversationOwner(
  c: Context<AppEnv>,
  db: Database,
  conversationId: string
): Promise<Response | undefined> {
  const ownerId = await lookupConversationOwner(db, conversationId);
  if (!ownerId) {
    return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
  }
  c.set('conversationOwnerId', ownerId);
  return undefined;
}

/**
 * Attempts to resolve a link guest and set context variables.
 * Returns a Response (error or next()) on success/failure, or null if resolution fails entirely.
 */
async function tryResolveLinkGuest(
  c: Context<AppEnv>,
  minLevel: MemberPrivilege,
  includeOwnerId: boolean,
  next: Next
): Promise<Response | null | undefined> {
  const resolved = await resolveLinkGuest(c);
  if (!resolved) {
    return null;
  }
  if (getPrivilegeLevel(resolved.member.privilege) < getPrivilegeLevel(minLevel)) {
    return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
  }
  c.set('linkGuest', { linkId: resolved.linkId, publicKey: resolved.publicKey });
  c.set('callerId', resolved.member.id);
  c.set('member', {
    id: resolved.member.id,
    privilege: resolved.member.privilege,
    visibleFromEpoch: resolved.member.visibleFromEpoch,
  });

  if (includeOwnerId) {
    const conversationId = c.req.param('conversationId');
    if (!conversationId) {
      return c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400);
    }
    const errorResponse = await setConversationOwner(c, c.get('db'), conversationId);
    if (errorResponse) return errorResponse;
  }

  // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition -- Hono's next() returns void | Response; we must propagate the response
  return (await next()) ?? undefined;
}

/** Looks up the active membership row for a user in a conversation. */
async function lookupMember(
  db: Database,
  conversationId: string,
  userId: string
): Promise<{ id: string; privilege: string; visibleFromEpoch: number } | undefined> {
  const rows = await db
    .select({
      id: conversationMembers.id,
      privilege: conversationMembers.privilege,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
    })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt)
      )
    )
    .limit(1);
  return rows[0];
}

interface LinkGuestFallbackOptions {
  c: Context<AppEnv>;
  minLevel: MemberPrivilege;
  includeOwnerId: boolean;
  allowLinkGuest: boolean;
  next: Next;
}

/** Attempts link guest fallback. Returns a response/next result, or null if it fails. */
async function tryLinkGuestFallback(
  options: LinkGuestFallbackOptions
): Promise<Response | null | undefined> {
  if (!options.allowLinkGuest) return null;
  return tryResolveLinkGuest(options.c, options.minLevel, options.includeOwnerId, options.next);
}

/**
 * Middleware that verifies the authenticated user is a member of the conversation
 * (identified by `conversationId` route param) and holds at least `minLevel` privilege.
 *
 * When `allowLinkGuest` is true, falls back to resolving a link guest via the
 * `x-link-public-key` header — both when no session user exists AND when the session
 * user is not a member of the conversation. Sets `c.set('linkGuest', ...)` on success.
 *
 * On success, sets `c.set('member', { id, privilege, visibleFromEpoch })` for downstream handlers.
 */
export function requirePrivilege(
  minLevel: MemberPrivilege,
  options?: PrivilegeOptions
): MiddlewareHandler<AppEnv> {
  const { allowLinkGuest = false, includeOwnerId = false } = options ?? {};

  return async (c, next) => {
    const user = c.get('user');

    if (!user) {
      return handleUnauthenticated(c, { minLevel, includeOwnerId, allowLinkGuest, next });
    }

    const db = c.get('db');
    const conversationId = c.req.param('conversationId');
    if (!conversationId) {
      return c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400);
    }

    // Link guest and membership are separate systems. When a link public key
    // header is present, always resolve as link guest — never fall through
    // to user membership lookup.
    const hasLinkKey = Boolean(
      c.req.header(LINK_PUBLIC_KEY_HEADER) ?? c.req.query('linkPublicKey')
    );
    if (hasLinkKey && allowLinkGuest) {
      return handleLinkGuestOnly(c, { minLevel, includeOwnerId, allowLinkGuest, next });
    }

    return handleAuthenticatedUser(c, {
      db,
      conversationId,
      user,
      minLevel,
      includeOwnerId,
      allowLinkGuest,
      next,
    });
  };
}

/** Handles the case where no session user exists. */
async function handleUnauthenticated(
  c: Context<AppEnv>,
  options: Omit<LinkGuestFallbackOptions, 'c'>
): Promise<Response | undefined> {
  const fallback = await tryLinkGuestFallback({ c, ...options });
  if (fallback !== null) return fallback;
  return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
}

/** Handles the link-key-first path (link key present, allowLinkGuest true). */
async function handleLinkGuestOnly(
  c: Context<AppEnv>,
  options: Omit<LinkGuestFallbackOptions, 'c'>
): Promise<Response | undefined> {
  const fallback = await tryLinkGuestFallback({ c, ...options });
  if (fallback !== null) return fallback;
  return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
}

interface AuthenticatedUserOptions {
  db: Database;
  conversationId: string;
  user: { id: string };
  minLevel: MemberPrivilege;
  includeOwnerId: boolean;
  allowLinkGuest: boolean;
  next: Next;
}

/** Handles the authenticated-user membership path. */
async function handleAuthenticatedUser(
  c: Context<AppEnv>,
  options: AuthenticatedUserOptions
): Promise<Response | undefined> {
  const member = await lookupMember(options.db, options.conversationId, options.user.id);

  if (!member) {
    const fallback = await tryLinkGuestFallback({
      c,
      minLevel: options.minLevel,
      includeOwnerId: options.includeOwnerId,
      allowLinkGuest: options.allowLinkGuest,
      next: options.next,
    });
    if (fallback !== null) return fallback;
    return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
  }

  if (getPrivilegeLevel(member.privilege) < getPrivilegeLevel(options.minLevel)) {
    return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
  }

  c.set('callerId', options.user.id);
  c.set('member', {
    id: member.id,
    privilege: member.privilege,
    visibleFromEpoch: member.visibleFromEpoch,
  });

  return finalizeMemberContext({
    c,
    db: options.db,
    conversationId: options.conversationId,
    includeOwnerId: options.includeOwnerId,
    next: options.next,
  });
}

interface FinalizeMemberContextOptions {
  c: Context<AppEnv>;
  db: Database;
  conversationId: string;
  includeOwnerId: boolean;
  next: Next;
}

/** Sets conversation owner if needed, then calls next(). */
async function finalizeMemberContext(
  options: FinalizeMemberContextOptions
): Promise<Response | undefined> {
  if (options.includeOwnerId) {
    const errorResponse = await setConversationOwner(options.c, options.db, options.conversationId);
    if (errorResponse) return errorResponse;
  }
  // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition -- Hono's next() returns void | Response; we must propagate the response
  return (await options.next()) ?? undefined;
}
