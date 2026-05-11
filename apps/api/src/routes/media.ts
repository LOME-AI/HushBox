import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { contentItems, messages, conversationMembers, epochs, epochMembers } from '@hushbox/db';
import {
  ERROR_CODE_CONTENT_ITEM_NOT_FOUND,
  ERROR_CODE_CONTENT_ITEM_NOT_MEDIA,
  ERROR_CODE_STORAGE_READ_FAILED,
} from '@hushbox/shared';
import { requireAuth } from '../middleware/require-auth.js';
import { rateLimitByCaller } from '../middleware/rate-limit.js';
import { getUser } from '../lib/get-user.js';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';

const MEDIA_CONTENT_TYPES = new Set(['image', 'audio', 'video']);

/**
 * Authenticated route — GET /:contentItemId/download-url (mounted at /api/media).
 *
 * Returns a short-lived presigned GET URL that the client uses to fetch the
 * encrypted media object directly from R2. Bytes never pass through the Worker
 * on reads.
 *
 * Authorization: the caller must be an active member of the conversation AND
 * an `epoch_members` row for the message's specific epoch. Conversation
 * membership alone would let a late-joiner mint download URLs for ciphertext
 * from earlier epochs they were never part of — they cannot decrypt, but
 * they could exfiltrate the encrypted blobs. The epoch-level JOIN closes
 * that gap. Non-epoch-members receive 404 (blind response — we don't
 * disclose whether the item exists).
 */
export const mediaRoute = new Hono<AppEnv>().get(
  '/:contentItemId/download-url',
  requireAuth(),
  rateLimitByCaller('mediaDownloadUserRateLimit'),
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
      // Bridge messages.epoch_number → epochs.id so we can join epoch_members
      // by id. epochs.(conversationId, epochNumber) is a unique constraint,
      // so this row is unambiguous.
      .innerJoin(
        epochs,
        and(
          eq(epochs.conversationId, messages.conversationId),
          eq(epochs.epochNumber, messages.epochNumber)
        )
      )
      // Caller's user public key must appear in epoch_members for the
      // message's specific epoch. memberPublicKey is unique per epoch.
      .innerJoin(
        epochMembers,
        and(eq(epochMembers.epochId, epochs.id), eq(epochMembers.memberPublicKey, user.publicKey))
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
