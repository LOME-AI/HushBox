import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ERROR_CODE_FORBIDDEN,
  ERROR_CODE_INTERNAL,
  ERROR_CODE_MESSAGE_NOT_FOUND,
  ERROR_CODE_SHARE_NOT_FOUND,
  toBase64,
  fromBase64,
} from '@hushbox/shared';
import {
  sharedMessages,
  messages,
  contentItems,
  conversationMembers,
  type ContentItem,
} from '@hushbox/db';
import { eq, and, asc, isNull } from 'drizzle-orm';
import type { AppEnv } from '../types.js';
import { requireAuth } from '../middleware/require-auth.js';
import { getUser } from '../lib/get-user.js';
import { createErrorResponse } from '../lib/error-response.js';

const createShareSchema = z.object({
  messageId: z.string(),
  /**
   * Base64-encoded wrap of the message's content key under a fresh `shareSecret`
   * derived key. The `shareSecret` lives only in the URL fragment client-side.
   */
  wrappedShareKey: z.string(),
});

/** Authenticated route — POST /share (mounted at /api/messages). */
export const messageSharesRoute = new Hono<AppEnv>().post(
  '/share',
  requireAuth(),
  zValidator('json', createShareSchema),
  async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const { messageId, wrappedShareKey: wrappedShareKeyBase64 } = c.req.valid('json');

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

    // 3. Insert the shared message — stores the message's content key re-wrapped
    //    under a shareSecret. The server never sees the shareSecret or the
    //    unwrapped content key.
    const wrappedShareKeyBytes = fromBase64(wrappedShareKeyBase64);
    const [inserted] = await db
      .insert(sharedMessages)
      .values({
        messageId,
        wrappedContentKey: wrappedShareKeyBytes,
      })
      .returning();

    if (!inserted) {
      return c.json(createErrorResponse(ERROR_CODE_INTERNAL), 500);
    }

    return c.json({ shareId: inserted.id }, 201);
  }
);

/**
 * Serializes a stored content item for the public share response.
 * Strips `model_name`, `cost`, and `is_smart_model` — share recipients see
 * content, not generation metadata.
 */
function serializePublicShareContentItem(item: ContentItem): {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  position: number;
  encryptedBlob: string | null;
  storageKey: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
} {
  return {
    id: item.id,
    contentType: item.contentType as 'text' | 'image' | 'audio' | 'video',
    position: item.position,
    encryptedBlob: item.encryptedBlob ? toBase64(item.encryptedBlob) : null,
    storageKey: item.storageKey,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
  };
}

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
        wrappedShareKey: sharedMessages.wrappedContentKey,
        createdAt: sharedMessages.createdAt,
      })
      .from(sharedMessages)
      .where(eq(sharedMessages.id, shareId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!share) {
      return c.json(createErrorResponse(ERROR_CODE_SHARE_NOT_FOUND), 404);
    }

    const items = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, share.messageId))
      .orderBy(asc(contentItems.position));

    return c.json(
      {
        shareId: share.id,
        messageId: share.messageId,
        /** Wrapped content key — recipients unwrap with the shareSecret from the URL fragment. */
        wrappedShareKey: toBase64(share.wrappedShareKey),
        contentItems: items.map((item) => serializePublicShareContentItem(item)),
        createdAt: share.createdAt.toISOString(),
      },
      200
    );
  }
);
