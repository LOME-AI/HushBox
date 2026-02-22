import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_LINK_NOT_FOUND,
  toBase64,
  fromBase64,
} from '@hushbox/shared';
import {
  sharedLinks,
  conversationMembers,
  epochMembers,
  epochs,
  conversations,
  messages,
  users,
} from '@hushbox/db';
import { eq, and, isNull, isNotNull, asc, gte } from 'drizzle-orm';
import type { AppEnv } from '../types.js';
import { createErrorResponse } from '../lib/error-response.js';
import { findActiveSharedLink } from '../lib/db-helpers.js';

const accessRequestSchema = z.object({
  conversationId: z.string(),
  linkPublicKey: z.string(),
});

const nameRequestSchema = z.object({
  conversationId: z.string(),
  linkPublicKey: z.string(),
  displayName: z.string().min(1).max(100),
});

export const linkGuestRoute = new Hono<AppEnv>()
  .post('/access', zValidator('json', accessRequestSchema), async (c) => {
    const { conversationId, linkPublicKey: linkPublicKeyBase64 } = c.req.valid('json');
    const db = c.get('db');
    const linkPublicKeyBytes = fromBase64(linkPublicKeyBase64);

    // 1. Look up shared link
    const sharedLink = await findActiveSharedLink(db, conversationId, linkPublicKeyBytes);

    if (!sharedLink) {
      return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
    }

    // 2. Look up conversation member for this link (includes privilege — single source of truth)
    const member = await db
      .select({
        id: conversationMembers.id,
        privilege: conversationMembers.privilege,
        visibleFromEpoch: conversationMembers.visibleFromEpoch,
      })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.linkId, sharedLink.id), isNull(conversationMembers.leftAt)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!member) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
    }

    const visibleFromEpoch = member.visibleFromEpoch;

    // 3. Get epoch wraps for this link's public key
    const wrapRows = await db
      .select({
        epochNumber: epochs.epochNumber,
        wrap: epochMembers.wrap,
        confirmationHash: epochs.confirmationHash,
        visibleFromEpoch: epochMembers.visibleFromEpoch,
      })
      .from(epochMembers)
      .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
      .where(
        and(
          eq(epochs.conversationId, conversationId),
          eq(epochMembers.memberPublicKey, linkPublicKeyBytes)
        )
      )
      .orderBy(asc(epochs.epochNumber));

    // Filter wraps to only include epochs >= the member's visibleFromEpoch
    const filteredWraps = wrapRows.filter((w) => w.epochNumber >= visibleFromEpoch);

    // 4. Get chain links
    const chainLinkRows = await db
      .select({
        epochNumber: epochs.epochNumber,
        chainLink: epochs.chainLink,
        confirmationHash: epochs.confirmationHash,
      })
      .from(epochs)
      .where(
        and(
          eq(epochs.conversationId, conversationId),
          isNotNull(epochs.chainLink),
          gte(epochs.epochNumber, visibleFromEpoch)
        )
      )
      .orderBy(asc(epochs.epochNumber));

    // 5. Get conversation metadata
    const conversation = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        currentEpoch: conversations.currentEpoch,
        titleEpochNumber: conversations.titleEpochNumber,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .then((rows) => rows[0]);

    // 6. Get messages
    const messageRows = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        encryptedBlob: messages.encryptedBlob,
        senderType: messages.senderType,
        senderId: messages.senderId,
        senderDisplayName: messages.senderDisplayName,
        payerId: messages.payerId,
        cost: messages.cost,
        epochNumber: messages.epochNumber,
        sequenceNumber: messages.sequenceNumber,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gte(messages.epochNumber, visibleFromEpoch)
        )
      )
      .orderBy(asc(messages.sequenceNumber));

    // 7. Get conversation members
    const memberRows = await db
      .select({
        id: conversationMembers.id,
        userId: conversationMembers.userId,
        privilege: conversationMembers.privilege,
        username: users.username,
      })
      .from(conversationMembers)
      .leftJoin(users, eq(conversationMembers.userId, users.id))
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt)
        )
      );

    // 8. Get active shared links (privilege from conversationMembers, not sharedLinks)
    const linkRows = await db
      .select({
        id: sharedLinks.id,
        displayName: sharedLinks.displayName,
        privilege: conversationMembers.privilege,
        createdAt: sharedLinks.createdAt,
      })
      .from(sharedLinks)
      .innerJoin(
        conversationMembers,
        and(eq(conversationMembers.linkId, sharedLinks.id), isNull(conversationMembers.leftAt))
      )
      .where(and(eq(sharedLinks.conversationId, conversationId), isNull(sharedLinks.revokedAt)));

    if (!conversation) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
    }

    return c.json(
      {
        conversation: {
          id: conversation.id,
          title: toBase64(conversation.title),
          currentEpoch: conversation.currentEpoch,
          titleEpochNumber: conversation.titleEpochNumber,
        },
        privilege: member.privilege,
        wraps: filteredWraps.map((row) => ({
          epochNumber: row.epochNumber,
          wrap: toBase64(row.wrap),
          confirmationHash: toBase64(row.confirmationHash),
          visibleFromEpoch: row.visibleFromEpoch,
        })),
        chainLinks: chainLinkRows
          .filter(
            (row): row is typeof row & { chainLink: NonNullable<typeof row.chainLink> } =>
              row.chainLink !== null
          )
          .map((row) => ({
            epochNumber: row.epochNumber,
            chainLink: toBase64(row.chainLink),
            confirmationHash: toBase64(row.confirmationHash),
          })),
        messages: messageRows.map((msg) => ({
          id: msg.id,
          conversationId: msg.conversationId,
          encryptedBlob: toBase64(msg.encryptedBlob),
          senderType: msg.senderType,
          senderId: msg.senderId ?? null,
          senderDisplayName: msg.senderDisplayName ?? null,
          payerId: msg.payerId ?? null,
          cost: msg.cost ?? null,
          epochNumber: msg.epochNumber,
          sequenceNumber: msg.sequenceNumber,
          createdAt: msg.createdAt.toISOString(),
        })),
        members: memberRows.map((row) => ({
          id: row.id,
          userId: row.userId ?? null,
          username: row.username ?? null,
          privilege: row.privilege,
        })),
        links: linkRows.map((row) => ({
          id: row.id,
          displayName: row.displayName ?? null,
          privilege: row.privilege,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      200
    );
  })
  .patch('/name', zValidator('json', nameRequestSchema), async (c) => {
    const { conversationId, linkPublicKey: linkPublicKeyBase64, displayName } = c.req.valid('json');
    const db = c.get('db');
    const linkPublicKeyBytes = fromBase64(linkPublicKeyBase64);

    // Look up shared link
    const sharedLink = await findActiveSharedLink(db, conversationId, linkPublicKeyBytes);

    if (!sharedLink) {
      return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
    }

    // Update display name
    await db.update(sharedLinks).set({ displayName }).where(eq(sharedLinks.id, sharedLink.id));

    return c.json({ success: true }, 200);
  });
