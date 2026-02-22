import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import {
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_SERVICE_UNAVAILABLE,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
} from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { requireAuth } from '../middleware/require-auth.js';
import { createErrorResponse } from '../lib/error-response.js';

export const websocketRoute = new Hono<AppEnv>()
  .use('*', requireAuth())
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }

      const { conversationId } = c.req.valid('param');
      const db = c.get('db');

      const member = await db
        .select({ id: conversationMembers.id, privilege: conversationMembers.privilege })
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
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      const doBinding = c.env.CONVERSATION_ROOM;
      if (!doBinding) {
        return c.json(createErrorResponse(ERROR_CODE_SERVICE_UNAVAILABLE), 503);
      }

      const id = doBinding.idFromName(conversationId);
      const stub = doBinding.get(id);

      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- internal DO routing, host is ignored
      const upgradeUrl = new URL('http://internal/websocket');
      upgradeUrl.searchParams.set('userId', user.id);

      return stub.fetch(
        new Request(upgradeUrl.toString(), {
          headers: c.req.raw.headers,
        })
      );
    }
  );
