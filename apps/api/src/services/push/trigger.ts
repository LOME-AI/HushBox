import { and, eq, isNull, ne, inArray } from 'drizzle-orm';
import { conversationMembers, deviceTokens, type Database } from '@hushbox/db';
import type { PushClient } from './types.js';

interface SendPushParams {
  db: Database;
  pushClient: PushClient;
  conversationId: string;
  senderUserId: string;
  title: string;
  body: string;
}

/**
 * Sends push notifications to all active, unmuted conversation members
 * (excluding the sender) who have registered device tokens.
 *
 * This is a fire-and-forget operation — errors are caught and logged,
 * never propagated to the caller.
 */
export async function sendPushForNewMessage(params: SendPushParams): Promise<void> {
  const { db, pushClient, conversationId, senderUserId, title, body } = params;

  try {
    // 1. Get active members excluding sender, filtering out muted
    const members = await db
      .select({
        userId: conversationMembers.userId,
        muted: conversationMembers.muted,
      })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt),
          ne(conversationMembers.userId, senderUserId)
        )
      );

    // Filter out muted members and extract user IDs
    const unmutedUserIds: string[] = [];
    for (const m of members) {
      if (!m.muted && m.userId !== null) {
        unmutedUserIds.push(m.userId);
      }
    }

    if (unmutedUserIds.length === 0) {
      return;
    }

    // 2. Get device tokens for unmuted members
    const tokens = await db
      .select({
        token: deviceTokens.token,
      })
      .from(deviceTokens)
      .where(inArray(deviceTokens.userId, unmutedUserIds));

    const tokenStrings = tokens.map((t) => t.token);

    if (tokenStrings.length === 0) {
      return;
    }

    // 3. Send push notification
    await pushClient.send({
      tokens: tokenStrings,
      title,
      body,
      data: { conversationId },
    });
  } catch (error: unknown) {
    console.error('Failed to send push notifications:', error);
  }
}
