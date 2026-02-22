import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ERROR_CODE_FORBIDDEN,
  ERROR_CODE_INTERNAL,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_MESSAGE_NOT_FOUND,
  ERROR_CODE_SHARE_NOT_FOUND,
  toBase64,
  fromBase64,
} from '@hushbox/shared';
import { sharedMessages, messages, conversationMembers } from '@hushbox/db';
import { eq, and, isNull } from 'drizzle-orm';
import type { AppEnv } from '../types.js';
import { requireAuth } from '../middleware/require-auth.js';
import { createErrorResponse } from '../lib/error-response.js';

const createShareSchema = z.object({
  messageId: z.string(),
  shareBlob: z.string(),
});

/** Authenticated route — POST /share (mounted at /api/messages). */
export const messageSharesRoute = new Hono<AppEnv>().post(
  '/share',
  requireAuth(),
  zValidator('json', createShareSchema),
  async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { messageId, shareBlob: shareBlobBase64 } = c.req.valid('json');

    // 1. Verify the message exists
    const message = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!message) {
      return c.json(createErrorResponse(ERROR_CODE_MESSAGE_NOT_FOUND), 404);
    }

    // 2. Verify the user is an active member of the conversation
    const membership = await db
      .select({
        id: conversationMembers.id,
      })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, message.conversationId),
          eq(conversationMembers.userId, user.id),
          isNull(conversationMembers.leftAt)
        )
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!membership) {
      return c.json(createErrorResponse(ERROR_CODE_FORBIDDEN), 403);
    }

    // 3. Insert the shared message
    const shareBlobBytes = fromBase64(shareBlobBase64);
    const [inserted] = await db
      .insert(sharedMessages)
      .values({
        messageId,
        shareBlob: shareBlobBytes,
      })
      .returning();

    if (!inserted) {
      return c.json(createErrorResponse(ERROR_CODE_INTERNAL), 500);
    }

    return c.json({ shareId: inserted.id }, 201);
  }
);

/** Public route — GET /:shareId (mounted at /api/shares). No auth required. */
export const publicSharesRoute = new Hono<AppEnv>().get(
  '/:shareId',
  zValidator('param', z.object({ shareId: z.string() })),
  async (c) => {
    const db = c.get('db');
    const { shareId } = c.req.valid('param');

    const share = await db
      .select({
        id: sharedMessages.id,
        messageId: sharedMessages.messageId,
        shareBlob: sharedMessages.shareBlob,
        createdAt: sharedMessages.createdAt,
      })
      .from(sharedMessages)
      .where(eq(sharedMessages.id, shareId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!share) {
      return c.json(createErrorResponse(ERROR_CODE_SHARE_NOT_FOUND), 404);
    }

    return c.json(
      {
        shareId: share.id,
        messageId: share.messageId,
        shareBlob: toBase64(share.shareBlob),
        createdAt: share.createdAt.toISOString(),
      },
      200
    );
  }
);
