import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  epochMembers,
  epochs,
  ledgerEntries,
  mediaGenerations,
  messages,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { decryptTextFromEpoch, generateKeyPair, openEpochWrap } from '@hushbox/crypto';
import { createR2StorageFromEnv } from '../slices/media/index.js';
import {
  DevSeedError,
  createDevConversation,
  createDevGroupChat,
  createDevMediaConversation,
  createDevMultiModelConversation,
} from './factories.js';
import { conversationCost, nanoUsdToDecimalString } from './reads.js';
import { BILLING_KEYS } from '../slices/billing/domain/keys.js';
import type { EnvContext } from '@hushbox/shared';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for factory integration tests`);
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });
const storageEnv: EnvContext & Record<string, unknown> = {
  NODE_ENV: 'development',
  R2_S3_ENDPOINT: requiredEnv('R2_S3_ENDPOINT'),
  R2_BUCKET_MEDIA: requiredEnv('R2_BUCKET_MEDIA'),
  R2_ACCESS_KEY_ID: requiredEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requiredEnv('R2_SECRET_ACCESS_KEY'),
};
const storage = createR2StorageFromEnv(storageEnv, db);
const redis = new Redis({
  url: requiredEnv('UPSTASH_REDIS_REST_URL'),
  token: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
});

const createdUserIds: string[] = [];
const snapshotWalletIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  for (const walletId of snapshotWalletIds) {
    await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
  }
  await db.$client.end();
});

async function seedUser(): Promise<{ id: string; email: string; privateKey: Uint8Array }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const keys = generateKeyPair();
  const email = `factory-${suffix}@factory-dev.test`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email,
        username: `f${suffix}`,
        opaqueRegistration: new Uint8Array([1]),
        publicKey: keys.publicKey,
        passwordWrappedPrivateKey: new Uint8Array([1]),
        recoveryWrappedPrivateKey: new Uint8Array([1]),
        recoveryPublicKey: new Uint8Array([1]),
      })
    )
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return { id, email, privateKey: keys.privateKey };
}

const SEED_WALLET_BALANCE_NANO_USD = 5_000_000_000n;

/**
 * A persona shaped like a registered account: the user row plus the purchased
 * wallet registration provisions, which a seeded charge debits.
 */
async function seedFundedUser(): Promise<{ id: string; email: string; walletId: string }> {
  const user = await seedUser();
  const [wallet] = await db
    .insert(wallets)
    .values({
      userId: user.id,
      type: 'purchased',
      balanceNanoUsd: SEED_WALLET_BALANCE_NANO_USD,
    })
    .returning({ id: wallets.id });
  if (wallet === undefined) throw new Error('wallet seed failed');
  snapshotWalletIds.push(wallet.id);
  return { id: user.id, email: user.email, walletId: wallet.id };
}

/**
 * The admission snapshot as a spender's turn would have left it before the
 * seed runs: the pre-charge balance at the wallet's pre-charge ledger
 * sequence, which the post-commit refresh has to overwrite.
 */
async function writeStaleSnapshot(walletId: string): Promise<void> {
  await redis.set(
    BILLING_KEYS.walletSnapshot.buildKey(walletId),
    {
      balanceNanoUsd: SEED_WALLET_BALANCE_NANO_USD.toString(10),
      ledgerSeq: 0,
      type: 'purchased',
    },
    { ex: BILLING_KEYS.walletSnapshot.ttlSeconds }
  );
}

/**
 * Decrypts a seeded conversation's title by unwrapping the first-epoch key from
 * the owner's member wrap, then ECIES-decrypting the `conversations.title` blob —
 * the same path the client uses to render a title.
 */
async function decryptConversationTitle(
  conversationId: string,
  ownerPrivateKey: Uint8Array
): Promise<string> {
  const [convRow] = await db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  const [epochRow] = await db
    .select({
      id: epochs.id,
      epochNumber: epochs.epochNumber,
      epochPublicKey: epochs.epochPublicKey,
      confirmationHash: epochs.confirmationHash,
    })
    .from(epochs)
    .where(eq(epochs.conversationId, conversationId));
  if (convRow === undefined || epochRow === undefined) {
    throw new Error('conversation or epoch row missing');
  }
  const [wrapRow] = await db
    .select({ wrap: epochMembers.wrap })
    .from(epochMembers)
    .where(eq(epochMembers.epochId, epochRow.id));
  if (wrapRow === undefined) throw new Error('epoch member wrap missing');
  const opened = openEpochWrap(ownerPrivateKey, wrapRow.wrap, { conversationId, ...epochRow });
  if (!opened.ok) throw new Error(`epoch wrap did not open: ${opened.reason}`);
  const epochPrivateKey = opened.key;
  return decryptTextFromEpoch(epochPrivateKey, convRow.title, { conversationId, epochNumber: 1 });
}

describe('createDevConversation with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedUser();
    const id = crypto.randomUUID();
    const result = await createDevConversation(db, {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
      id,
    });
    expect(result.conversationId).toBe(id);
    const rows = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(rows).toHaveLength(1);
  });

  it('is idempotent on a pinned-id re-run (the profile seed re-runs)', async () => {
    const owner = await seedUser();
    const id = crypto.randomUUID();
    const params = {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
      id,
      messages: [{ content: 'hello', senderType: 'user' as const }],
    };
    const first = await createDevConversation(db, params);
    const second = await createDevConversation(db, params);
    expect(second.conversationId).toBe(first.conversationId);
    const messageRows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, id));
    expect(messageRows).toHaveLength(1);
  });

  it('stores a real title that decrypts to the supplied value', async () => {
    const owner = await seedUser();
    const result = await createDevConversation(db, {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
      title: 'Seed Conversation 1',
    });
    const decrypted = await decryptConversationTitle(result.conversationId, owner.privateKey);
    expect(decrypted).toBe('Seed Conversation 1');
  });

  it('mints a fresh random id when none is supplied', async () => {
    const owner = await seedUser();
    const a = await createDevConversation(db, {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
    });
    const b = await createDevConversation(db, {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
    });
    expect(a.conversationId).toMatch(UUID_RE);
    expect(b.conversationId).toMatch(UUID_RE);
    expect(a.conversationId).not.toBe(b.conversationId);
  });
});

describe('createDevMultiModelConversation with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedFundedUser();
    const id = crypto.randomUUID();
    const result = await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [{ content: 'a', modelName: 'dev/model', costNanoUsd: 1_000_000n }],
      id,
    });
    expect(result.conversationId).toBe(id);
  });
});

const MULTI_MODEL_RESPONSES = [
  { content: 'a', modelName: 'dev/model-a', costNanoUsd: 2_000_000n },
  { content: 'b', modelName: 'dev/model-b', costNanoUsd: 3_000_000n },
] as const;

const MULTI_MODEL_TOTAL_NANO_USD = 5_000_000n;

/** The seeded turn's charges, read the way settlement anchors them. */
async function readSeededCharges(conversationId: string): Promise<
  {
    usageCostNanoUsd: bigint;
    contentCostNanoUsd: bigint | null;
    payerUserId: string | null;
    senderUserId: string | null;
    runId: string;
    modelId: string;
    modality: string;
    stampedConversationId: string | null;
  }[]
> {
  return db
    .select({
      usageCostNanoUsd: usageRecords.costNanoUsd,
      contentCostNanoUsd: contentItems.costNanoUsd,
      payerUserId: usageRecords.payerUserId,
      senderUserId: usageRecords.senderUserId,
      runId: usageRecords.runId,
      modelId: usageRecords.modelId,
      modality: usageRecords.modality,
      stampedConversationId: usageRecords.conversationId,
    })
    .from(usageRecords)
    .innerJoin(contentItems, eq(contentItems.id, usageRecords.contentItemId))
    .innerJoin(messages, eq(messages.id, contentItems.messageId))
    .where(eq(messages.conversationId, conversationId));
}

describe('createDevMultiModelConversation billing shape', () => {
  it('anchors one usage record to every costed content item', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    const charges = await readSeededCharges(conversationId);
    expect(charges).toHaveLength(MULTI_MODEL_RESPONSES.length);
    for (const charge of charges) {
      expect(charge.usageCostNanoUsd).toBe(charge.contentCostNanoUsd);
    }
  });

  it('reports a charged total equal to the displayed total', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    expect(await conversationCost(db, conversationId)).toBe(
      nanoUsdToDecimalString(MULTI_MODEL_TOTAL_NANO_USD)
    );
  });

  it('records the owner as payer and sender of every sibling charge', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    const charges = await readSeededCharges(conversationId);
    expect(charges).toHaveLength(MULTI_MODEL_RESPONSES.length);
    for (const charge of charges) {
      expect(charge.payerUserId).toBe(owner.id);
      expect(charge.senderUserId).toBe(owner.id);
      expect(charge.modality).toBe('text');
    }
  });

  it('groups the siblings under one runId stamped with the conversation', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    const charges = await readSeededCharges(conversationId);
    expect(new Set(charges.map((charge) => charge.runId)).size).toBe(1);
    for (const charge of charges) {
      expect(charge.stampedConversationId).toBe(conversationId);
    }
  });

  it('debits the payer wallet by the charged total', async () => {
    const owner = await seedFundedUser();
    await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    const [wallet] = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.id, owner.walletId));
    expect(wallet?.balanceNanoUsd).toBe(SEED_WALLET_BALANCE_NANO_USD - MULTI_MODEL_TOTAL_NANO_USD);
  });

  it('posts zero-sum ledger legs for the charged total', async () => {
    const owner = await seedFundedUser();
    await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    const legs = await db
      .select({ amountNanoUsd: ledgerEntries.amountNanoUsd })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, owner.walletId));
    expect(legs).toHaveLength(MULTI_MODEL_RESPONSES.length);
    const walletLegTotal = legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n);
    expect(walletLegTotal).toBe(-MULTI_MODEL_TOTAL_NANO_USD);
  });

  it('refreshes the payer snapshot to the post-charge balance', async () => {
    const owner = await seedFundedUser();
    await writeStaleSnapshot(owner.walletId);

    await createDevMultiModelConversation(db, redis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    const raw = await redis.get(BILLING_KEYS.walletSnapshot.buildKey(owner.walletId));
    expect(BILLING_KEYS.walletSnapshot.schema.parse(raw)).toMatchObject({
      balanceNanoUsd: (SEED_WALLET_BALANCE_NANO_USD - MULTI_MODEL_TOTAL_NANO_USD).toString(10),
      type: 'purchased',
    });
  });

  it('completes the seed when the snapshot refresh fails', async () => {
    const owner = await seedFundedUser();
    // A Redis that cannot be reached: the refresh is advisory, so the seed the
    // database already committed must still succeed.
    const unreachableRedis = new Redis({
      url: 'http://127.0.0.1:1',
      token: 'unreachable',
      retry: false,
    });

    const { conversationId } = await createDevMultiModelConversation(db, unreachableRedis, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [...MULTI_MODEL_RESPONSES],
    });

    expect(await conversationCost(db, conversationId)).toBe(
      nanoUsdToDecimalString(MULTI_MODEL_TOTAL_NANO_USD)
    );
  });

  it('refuses a costed turn for an owner with no purchased wallet', async () => {
    const owner = await seedUser();
    await expect(
      createDevMultiModelConversation(db, redis, {
        ownerEmail: owner.email,
        userContent: 'compare',
        aiResponses: [...MULTI_MODEL_RESPONSES],
      })
    ).rejects.toThrow(DevSeedError);
  });
});

describe('createDevGroupChat with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const id = crypto.randomUUID();
    const result = await createDevGroupChat(db, {
      ownerEmail: owner.email,
      memberEmails: [member.email],
      seedAiModel: 'dev/model',
      id,
    });
    expect(result.conversationId).toBe(id);
  });

  it('is idempotent on a pinned-id re-run (the profile seed re-runs)', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const id = crypto.randomUUID();
    const params = {
      ownerEmail: owner.email,
      memberEmails: [member.email],
      seedAiModel: 'dev/model',
      id,
    };
    const first = await createDevGroupChat(db, params);
    const second = await createDevGroupChat(db, params);
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.members.map((m) => m.email)).toEqual(first.members.map((m) => m.email));
  });
});

const MEDIA_SEED_COST_NANO_USD = 3_000_000n;

describe('createDevMediaConversation with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedFundedUser();
    const id = crypto.randomUUID();
    const result = await createDevMediaConversation(db, storage, redis, {
      ownerEmail: owner.email,
      userContent: 'draw a cat',
      mediaType: 'image',
      modelId: 'dev/model',
      costNanoUsd: MEDIA_SEED_COST_NANO_USD,
      id,
    });
    expect(result.conversationId).toBe(id);
  });
});

/** Costed content the charged side cannot account for — the state settlement cannot produce. */
async function countUnbilledCostedContent(conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .innerJoin(messages, eq(messages.id, contentItems.messageId))
    .leftJoin(usageRecords, eq(usageRecords.contentItemId, contentItems.id))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNotNull(contentItems.costNanoUsd),
        isNull(usageRecords.id)
      )
    );
  return rows.length;
}

/** The per-generation dimension rows the seeded charges wrote. */
async function readSeededMediaGenerations(
  conversationId: string
): Promise<{ modality: string; imageCount: number | null }[]> {
  return db
    .select({ modality: mediaGenerations.modality, imageCount: mediaGenerations.imageCount })
    .from(mediaGenerations)
    .innerJoin(usageRecords, eq(usageRecords.id, mediaGenerations.usageRecordId))
    .innerJoin(contentItems, eq(contentItems.id, usageRecords.contentItemId))
    .innerJoin(messages, eq(messages.id, contentItems.messageId))
    .where(eq(messages.conversationId, conversationId));
}

describe('createDevMediaConversation billing shape', () => {
  it('anchors a usage record to the costed media content item', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMediaConversation(db, storage, redis, {
      ownerEmail: owner.email,
      userContent: 'draw a cat',
      mediaType: 'image',
      modelId: 'dev/model',
      costNanoUsd: MEDIA_SEED_COST_NANO_USD,
    });

    expect(await countUnbilledCostedContent(conversationId)).toBe(0);
  });

  it('charges the cost the media content item displays', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMediaConversation(db, storage, redis, {
      ownerEmail: owner.email,
      userContent: 'draw a cat',
      mediaType: 'image',
      modelId: 'dev/model',
      costNanoUsd: MEDIA_SEED_COST_NANO_USD,
    });

    const charges = await readSeededCharges(conversationId);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.usageCostNanoUsd).toBe(MEDIA_SEED_COST_NANO_USD);
    expect(charges[0]?.contentCostNanoUsd).toBe(MEDIA_SEED_COST_NANO_USD);
  });

  it('records the image modality on a seeded image charge', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMediaConversation(db, storage, redis, {
      ownerEmail: owner.email,
      userContent: 'draw a cat',
      mediaType: 'image',
      modelId: 'dev/model',
      costNanoUsd: MEDIA_SEED_COST_NANO_USD,
    });

    const charges = await readSeededCharges(conversationId);
    expect(charges[0]?.modality).toBe('image');
  });

  it('records the video modality on a seeded video charge', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMediaConversation(db, storage, redis, {
      ownerEmail: owner.email,
      userContent: 'film a cat',
      mediaType: 'video',
      modelId: 'dev/model',
      costNanoUsd: MEDIA_SEED_COST_NANO_USD,
    });

    const charges = await readSeededCharges(conversationId);
    expect(charges[0]?.modality).toBe('video');
  });

  it('records one generated image on a seeded image charge', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMediaConversation(db, storage, redis, {
      ownerEmail: owner.email,
      userContent: 'draw a cat',
      mediaType: 'image',
      modelId: 'dev/model',
      costNanoUsd: MEDIA_SEED_COST_NANO_USD,
    });

    expect(await readSeededMediaGenerations(conversationId)).toEqual([
      { modality: 'image', imageCount: 1 },
    ]);
  });

  it('records no image count on a seeded video charge', async () => {
    const owner = await seedFundedUser();
    const { conversationId } = await createDevMediaConversation(db, storage, redis, {
      ownerEmail: owner.email,
      userContent: 'film a cat',
      mediaType: 'video',
      modelId: 'dev/model',
      costNanoUsd: MEDIA_SEED_COST_NANO_USD,
    });

    expect(await readSeededMediaGenerations(conversationId)).toEqual([
      { modality: 'video', imageCount: null },
    ]);
  });

  it('refuses a costed media turn for an owner with no purchased wallet', async () => {
    const owner = await seedUser();
    await expect(
      createDevMediaConversation(db, storage, redis, {
        ownerEmail: owner.email,
        userContent: 'draw a cat',
        mediaType: 'image',
        modelId: 'dev/model',
        costNanoUsd: MEDIA_SEED_COST_NANO_USD,
      })
    ).rejects.toThrow(DevSeedError);
  });
});
