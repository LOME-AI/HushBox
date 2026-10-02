// Every chat route that has the server encrypt to the current epoch refuses while
// a departed seat still holds that epoch's key, before anything is written or a
// run is handed to the room. Each refusal has an admitted twin whose only
// difference is that the seat is still live.
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import { conversationMembers, epochMembers, epochs, messages, sharedLinks } from '@hushbox/db';
import { sharedLinkFactory } from '@hushbox/db/factories';
import { ERROR_CODES } from '@hushbox/shared';
import {
  BYTES,
  MODEL,
  cookie,
  createdConversationIds,
  db,
  post,
  postPath,
  postRegenerate,
  recordingRealtime,
  seedMessage,
  seedModel,
  seedPurchasedWallet,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';
import {
  seatCurrentEpochHolder,
  seedConversationWithEpoch,
} from '../../test-support/conversation-seed.js';

/** A funded sender alone in a conversation whose epoch key is real, so a send can wrap to it. */
async function seedSender(): Promise<{ readonly userId: string; readonly conversationId: string }> {
  const userId = await seedUser();
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: generateEpochKeyPair().publicKey,
  });
  createdConversationIds.push(conversationId);
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  await seedPurchasedWallet(userId);
  return { userId, conversationId };
}

async function wrapCurrentEpoch(
  conversationId: string,
  memberPublicKey: Uint8Array
): Promise<void> {
  const epochRows = await db
    .select({ id: epochs.id })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 1)));
  const epochId = epochRows[0]?.id;
  if (epochId === undefined) throw new Error('epoch seed failed');
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey, wrap: BYTES, visibleFromEpoch: 1 });
}

/**
 * A shared link whose key holds the current epoch, seated as a member. `lapsed`
 * puts its expiry behind the database clock: the seat row stays, the link no
 * longer admits anyone, and its wrap outlives it.
 */
async function seatLink(conversationId: string, lapsed: boolean): Promise<void> {
  const link = sharedLinkFactory.build({ conversationId });
  const linkRows = await db
    .insert(sharedLinks)
    .values({ ...link, ...(lapsed ? { expiresAt: sql`now() - interval '1 hour'` } : {}) })
    .returning({ id: sharedLinks.id });
  const linkId = linkRows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  await db.insert(conversationMembers).values({ conversationId, linkId, visibleFromEpoch: 1 });
  await wrapCurrentEpoch(conversationId, link.linkPublicKey);
}

async function messageCount(conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return rows.length;
}

function sendBody(conversationId: string): unknown {
  return {
    conversationId,
    turnSources: [{ kind: 'model', id: MODEL }],
    userMessage: { content: 'hello' },
  };
}

async function sendChat(departed: boolean): Promise<{
  readonly res: Response;
  readonly starts: readonly number[];
  readonly conversationId: string;
}> {
  await seedModel();
  const { userId, conversationId } = await seedSender();
  await seatCurrentEpochHolder(db, { conversationId, userId: await seedUser(), departed });
  const { starts, realtime } = recordingRealtime();
  const res = await post(
    realtime,
    { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
    sendBody(conversationId)
  );
  return { res, starts, conversationId };
}

async function sendGuestRoute(lapsed: boolean): Promise<{
  readonly res: Response;
  readonly starts: readonly number[];
  readonly conversationId: string;
}> {
  await seedModel();
  const { userId, conversationId } = await seedSender();
  await seatLink(conversationId, lapsed);
  const { starts, realtime } = recordingRealtime();
  // A session holder on the guest route resolves as a user and meets the same
  // turn freeze a link guest does.
  const res = await postPath(
    '/chat/guest',
    realtime,
    { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
    sendBody(conversationId)
  );
  return { res, starts, conversationId };
}

async function regenerate(departed: boolean): Promise<{
  readonly res: Response;
  readonly starts: readonly number[];
  readonly conversationId: string;
}> {
  await seedModel();
  const { userId, conversationId } = await seedSender();
  const anchor = await seedMessage(conversationId, {
    senderType: 'user',
    senderId: userId,
    sequenceNumber: 1,
    parentMessageId: null,
  });
  await seatCurrentEpochHolder(db, { conversationId, userId: await seedUser(), departed });
  const { starts, realtime } = recordingRealtime();
  const res = await postRegenerate(
    realtime,
    { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
    {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      targetMessageId: anchor,
      action: 'retry',
      userMessage: { content: 'again' },
    }
  );
  return { res, starts, conversationId };
}

async function sendUserOnly(lapsed: boolean): Promise<{
  readonly res: Response;
  readonly starts: readonly number[];
  readonly conversationId: string;
}> {
  const { userId, conversationId } = await seedSender();
  await seatLink(conversationId, lapsed);
  const { starts, realtime } = recordingRealtime();
  const res = await postPath(
    `/chat/${conversationId}/message`,
    realtime,
    { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
    { content: 'no model' }
  );
  return { res, starts, conversationId };
}

// The recording double counts run starts, and the room places the admission
// hold only on a start: an empty count is the proof that no run began and no
// hold was placed. Each admitted twin shows the count does move.
describe('chat routes while a departed seat holds the current epoch', () => {
  it('refuses POST /chat with 409 ROTATION_PENDING, starting no run and writing no message', async () => {
    const { res, starts, conversationId } = await sendChat(true);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ROTATION_PENDING });
    expect(res.status).toBe(409);
    expect(starts).toHaveLength(0);
    expect(await messageCount(conversationId)).toBe(0);
  });

  it('admits POST /chat when the other seat is still live', async () => {
    const { res, starts } = await sendChat(false);
    expect(res.status).toBe(201);
    expect(starts).toHaveLength(1);
  });

  it('refuses POST /chat/guest with 409 ROTATION_PENDING, starting no run and writing no message', async () => {
    const { res, starts, conversationId } = await sendGuestRoute(true);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ROTATION_PENDING });
    expect(res.status).toBe(409);
    expect(starts).toHaveLength(0);
    expect(await messageCount(conversationId)).toBe(0);
  });

  it('admits POST /chat/guest when the link is still live', async () => {
    const { res, starts } = await sendGuestRoute(false);
    expect(res.status).toBe(201);
    expect(starts).toHaveLength(1);
  });

  it('refuses POST /chat/regenerate with 409 ROTATION_PENDING, starting no run and writing no message', async () => {
    const { res, starts, conversationId } = await regenerate(true);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ROTATION_PENDING });
    expect(res.status).toBe(409);
    expect(starts).toHaveLength(0);
    // The anchor alone: nothing was added and nothing superseded.
    expect(await messageCount(conversationId)).toBe(1);
  });

  it('admits POST /chat/regenerate when the other seat is still live', async () => {
    const { res, starts } = await regenerate(false);
    expect(res.status).toBe(201);
    expect(starts).toHaveLength(1);
  });

  it('refuses POST /chat/:conversationId/message with 409 ROTATION_PENDING, writing no message', async () => {
    const { res, starts, conversationId } = await sendUserOnly(true);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ROTATION_PENDING });
    expect(res.status).toBe(409);
    expect(starts).toHaveLength(0);
    expect(await messageCount(conversationId)).toBe(0);
  });

  it('stores the user-only message when the link is still live', async () => {
    const { res, conversationId } = await sendUserOnly(false);
    expect(res.status).toBe(200);
    expect(await messageCount(conversationId)).toBe(1);
  });
});
