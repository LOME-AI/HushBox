import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  llmCompletions,
  messages,
  usageRecords,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { contentItemsByMessage } from './content-item-reads.js';
import { createMessagesReader } from './messages-reader.js';
import { seedConversationWithEpoch } from '../../../test-support/conversation-seed.js';
import type { ContentItemRow } from '../ports/stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversations content-item read tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([7, 7, 7]);

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
const createdUsageRecordIds: string[] = [];

interface Graph {
  readonly userId: string;
  readonly conversationId: string;
  readonly messageId: string;
}

async function seedGraph(): Promise<Graph> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@conv-item-reads.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const { conversationId } = await seedConversationWithEpoch(db, { userId, title: BYTES });
  createdConversationIds.push(conversationId);
  const messageRows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'assistant',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) throw new Error('message seed failed');
  return { userId, conversationId, messageId };
}

async function seedTextItem(messageId: string): Promise<string> {
  const rows = await db
    .insert(contentItems)
    .values({
      messageId,
      contentType: 'text',
      position: 0,
      encryptedBlob: BYTES,
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      providerName: 'openai',
    })
    .returning({ id: contentItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('content item seed failed');
  return id;
}

/** One billed completion anchored to a content item, with its token counts. */
async function seedCompletion(
  graph: Graph,
  contentItemId: string,
  tokens: { input: number; output: number; reasoning: number },
  reasoningDurationMs?: number
): Promise<void> {
  const rows = await db
    .insert(usageRecords)
    .values({
      payerUserId: graph.userId,
      contentItemId,
      conversationId: graph.conversationId,
      runId: crypto.randomUUID(),
      modelId: 'anthropic/claude',
      providerName: 'openai',
      modality: 'text',
      costNanoUsd: 680_000n,
      idempotencyKey: crypto.randomUUID(),
    })
    .returning({ id: usageRecords.id });
  const usageRecordId = rows[0]?.id;
  if (usageRecordId === undefined) throw new Error('usage record seed failed');
  createdUsageRecordIds.push(usageRecordId);
  await db.insert(llmCompletions).values({
    usageRecordId,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    ...(reasoningDurationMs === undefined ? {} : { reasoningDurationMs }),
  });
}

async function readItem(messageId: string): Promise<ContentItemRow | undefined> {
  const result = await contentItemsByMessage(db, [messageId]);
  return result._unsafeUnwrap().get(messageId)?.[0];
}

afterAll(async () => {
  if (createdUsageRecordIds.length > 0) {
    await db.delete(usageRecords).where(inArray(usageRecords.id, createdUsageRecordIds));
  }
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('contentItemsByMessage token counts', () => {
  it('sums the input tokens of two completion rows anchored to one item', async () => {
    const graph = await seedGraph();
    const itemId = await seedTextItem(graph.messageId);
    await seedCompletion(graph, itemId, { input: 100, output: 40, reasoning: 5 });
    await seedCompletion(graph, itemId, { input: 12, output: 3, reasoning: 0 });

    const item = await readItem(graph.messageId);

    expect(item?.inputTokens).toBe(112);
  });

  it('sums the output tokens of two completion rows anchored to one item', async () => {
    const graph = await seedGraph();
    const itemId = await seedTextItem(graph.messageId);
    await seedCompletion(graph, itemId, { input: 100, output: 40, reasoning: 5 });
    await seedCompletion(graph, itemId, { input: 12, output: 3, reasoning: 0 });

    const item = await readItem(graph.messageId);

    expect(item?.outputTokens).toBe(43);
  });

  it('gives null token counts to an item with no completion row', async () => {
    const graph = await seedGraph();
    await seedTextItem(graph.messageId);

    const item = await readItem(graph.messageId);

    expect(item?.inputTokens).toBeNull();
    expect(item?.outputTokens).toBeNull();
  });
});

describe('contentItemsByMessage over no messages', () => {
  it('reads nothing for an empty message list', async () => {
    const result = await contentItemsByMessage(db, []);

    expect(result._unsafeUnwrap().size).toBe(0);
  });
});

describe('contentItemsByMessage reasoning time', () => {
  it('sums the reasoning time of two completion rows anchored to one item', async () => {
    const graph = await seedGraph();
    const itemId = await seedTextItem(graph.messageId);
    await seedCompletion(graph, itemId, { input: 100, output: 40, reasoning: 5 }, 1200);
    await seedCompletion(graph, itemId, { input: 12, output: 3, reasoning: 2 }, 800);

    const item = await readItem(graph.messageId);

    expect(item?.reasoningDurationMs).toBe(2000);
  });

  it('gives null to an item none of whose completion rows recorded a reasoning time', async () => {
    const graph = await seedGraph();
    const itemId = await seedTextItem(graph.messageId);
    await seedCompletion(graph, itemId, { input: 100, output: 40, reasoning: 0 });
    await seedCompletion(graph, itemId, { input: 12, output: 3, reasoning: 0 });

    const item = await readItem(graph.messageId);

    expect(item?.reasoningDurationMs).toBeNull();
  });

  it('takes the answer row time beside a classifier row that recorded none', async () => {
    const graph = await seedGraph();
    const itemId = await seedTextItem(graph.messageId);
    await seedCompletion(graph, itemId, { input: 40, output: 2, reasoning: 0 });
    await seedCompletion(graph, itemId, { input: 100, output: 40, reasoning: 5 }, 900);

    const item = await readItem(graph.messageId);

    expect(item?.reasoningDurationMs).toBe(900);
  });

  it('keeps the answer row time beside a row without one that settled after it', async () => {
    const graph = await seedGraph();
    const itemId = await seedTextItem(graph.messageId);
    await seedCompletion(graph, itemId, { input: 100, output: 40, reasoning: 5 }, 900);
    await seedCompletion(graph, itemId, { input: 40, output: 2, reasoning: 0 });

    const item = await readItem(graph.messageId);

    expect(item?.reasoningDurationMs).toBe(900);
  });

  it('gives null to an item with no completion row', async () => {
    const graph = await seedGraph();
    await seedTextItem(graph.messageId);

    const item = await readItem(graph.messageId);

    expect(item?.reasoningDurationMs).toBeNull();
  });
});

describe('the history read over content-item reads', () => {
  it('carries each message row creation instant', async () => {
    const graph = await seedGraph();
    const stored = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(inArray(messages.id, [graph.messageId]));

    const result = await createMessagesReader(db).history({
      conversationId: graph.conversationId,
      minEpoch: 1,
      afterSequence: null,
      limit: 10,
    });
    const rows = result._unsafeUnwrap();

    expect(rows[0]?.createdAt).toEqual(stored[0]?.createdAt);
  });

  it('carries the summed token counts of each content item', async () => {
    const graph = await seedGraph();
    const itemId = await seedTextItem(graph.messageId);
    await seedCompletion(graph, itemId, { input: 100, output: 40, reasoning: 5 });
    await seedCompletion(graph, itemId, { input: 12, output: 3, reasoning: 0 });

    const result = await createMessagesReader(db).history({
      conversationId: graph.conversationId,
      minEpoch: 1,
      afterSequence: null,
      limit: 10,
    });
    const rows = result._unsafeUnwrap();

    expect(rows[0]?.contentItems[0]?.inputTokens).toBe(112);
    expect(rows[0]?.contentItems[0]?.outputTokens).toBe(43);
  });
});
