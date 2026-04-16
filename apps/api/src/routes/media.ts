import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { contentItems, messages, conversationMembers } from '@hushbox/db';
import {
  ERROR_CODE_CONTENT_ITEM_NOT_FOUND,
  ERROR_CODE_CONTENT_ITEM_NOT_MEDIA,
  ERROR_CODE_STORAGE_READ_FAILED,
} from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { requireAuth } from '../middleware/require-auth.js';
import { getUser } from '../lib/get-user.js';
import { createErrorResponse } from '../lib/error-response.js';

const MEDIA_CONTENT_TYPES = new Set(['image', 'audio', 'video']);

/**
 * Authenticated route — GET /:contentItemId/download-url (mounted at /api/media).
 *
 * Returns a short-lived presigned GET URL that the client uses to fetch the
 * encrypted media object directly from R2. Bytes never pass through the Worker
 * on reads.
 *
 * Authorization: the caller must be an active member of the conversation that
 * owns the content item's parent message. Non-members receive 404 (blind
 * response — we don't disclose whether the item exists).
 */
export const mediaRoute = new Hono<AppEnv>().get(
  '/:contentItemId/download-url',
  requireAuth(),
  zValidator('param', z.object({ contentItemId: z.string().min(1) })),
  async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const mediaStorage = c.get('mediaStorage');
    const { contentItemId } = c.req.valid('param');

    const row = await db
      .select({
        id: contentItems.id,
        contentType: contentItems.contentType,
        storageKey: contentItems.storageKey,
        conversationId: messages.conversationId,
      })
      .from(contentItems)
      .innerJoin(messages, eq(messages.id, contentItems.messageId))
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, messages.conversationId),
          eq(conversationMembers.userId, user.id),
          isNull(conversationMembers.leftAt)
        )
      )
      .where(eq(contentItems.id, contentItemId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!row) {
      return c.json(createErrorResponse(ERROR_CODE_CONTENT_ITEM_NOT_FOUND), 404);
    }

    if (!MEDIA_CONTENT_TYPES.has(row.contentType) || !row.storageKey) {
      return c.json(createErrorResponse(ERROR_CODE_CONTENT_ITEM_NOT_MEDIA), 400);
    }

    try {
      const { url, expiresAt } = await mediaStorage.mintDownloadUrl({ key: row.storageKey });
      return c.json({ downloadUrl: url, expiresAt }, 200);
    } catch {
      return c.json(createErrorResponse(ERROR_CODE_STORAGE_READ_FAILED), 500);
    }
  }
);
