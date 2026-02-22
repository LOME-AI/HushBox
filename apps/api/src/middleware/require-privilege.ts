import type { MiddlewareHandler } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import {
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  getPrivilegeLevel,
} from '@hushbox/shared';
import type { MemberPrivilege } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { createErrorResponse } from '../lib/error-response.js';

/**
 * Middleware that verifies the authenticated user is a member of the conversation
 * (identified by `conversationId` route param) and holds at least `minLevel` privilege.
 *
 * On success, sets `c.set('member', { id, privilege, visibleFromEpoch })` for downstream handlers.
 */
export function requirePrivilege(minLevel: MemberPrivilege): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const conversationId = c.req.param('conversationId');
    if (!conversationId) {
      return c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400);
    }

    const member = await db
      .select({
        id: conversationMembers.id,
        privilege: conversationMembers.privilege,
        visibleFromEpoch: conversationMembers.visibleFromEpoch,
      })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, user.id),
          isNull(conversationMembers.leftAt)
        )
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!member) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
    }

    if (getPrivilegeLevel(member.privilege) < getPrivilegeLevel(minLevel)) {
      return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
    }

    c.set('member', {
      id: member.id,
      privilege: member.privilege,
      visibleFromEpoch: member.visibleFromEpoch,
    });

    return next();
  };
}
