import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, eq, inArray, like } from 'drizzle-orm';
import { HOUR_MS } from '@hushbox/shared/test-time';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  ledgerEntries,
  llmCompletions,
  messages,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { spendingByConversationRowSchema } from '@hushbox/shared';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createJobRegistry } from '../../lib/jobs/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import {
  BILLING_PORTAL_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../middleware/pipeline-session.js';
import { createWebhookVerifier } from './domain/index.js';
import { createMockPaymentProvider } from './adapters/payment-mock.js';
import { createBillingManifest, createBillingStores } from './index.js';
import { seedConversationWithEpoch } from '../../test-support/conversation-seed.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { BillingRouteDeps } from './routes.js';
import type { BillingStores } from './ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing usage-routes integration tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';
const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);

// Two whole UTC days the fixtures land in; queried inclusively below.
const DAY1 = '2026-03-10';
const DAY2 = '2026-03-11';
const at = (day: string): Date => new Date(Date.parse(`${day}T00:00:00.000Z`) + 12 * HOUR_MS);
// Distinct within-day times give the ledger reads a deterministic order.
const atHour = (day: string, hour: number): Date =>
  new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);

const MODEL_A = 'usage-reads/model-a';
const MODEL_B = 'usage-reads/model-b';
const MODEL_IMG = 'usage-reads/model-image';
const MODEL_CLASSIFIER = 'usage-reads/model-classifier';
const PROVIDER = 'usage-reads-provider';

const createdUserIds: string[] = [];
let counter = 0;

function buildApp(overrides: Partial<BillingRouteDeps> = {}): Hono<AppEnv> {
  const provider = createMockPaymentProvider({
    webhookUrl: 'http://localhost/billing/webhooks/payment',
    webhookVerifier: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=',
    webhookDelayMs: 0,
    fetchImpl: () => Promise.reject(new Error('unused')),
  });
  const deps: BillingRouteDeps = {
    stores,
    // The usage routes never resolve a payer; a reader that throws pins that.
    conversationFunding: () => () => {
      throw new Error('conversationFunding unexpectedly invoked');
    },
    paymentProvider: () => provider,
    webhookVerifier: () => createWebhookVerifier({ verifier: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' }),
    jobRegistry: createJobRegistry(),
    accountDefense: { lockForChargebackWithinTx: () => Promise.reject(new Error('unused')) },
    accountLockedEmail: { sendChargebackLockEmail: () => errAsync(unavailableError('unused')) },
    ...overrides,
  };
  const manifest = createBillingManifest(deps);
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function sessionCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

// The mobile → web billing-portal handoff presents its own path-scoped
// credential, never a login session; it reads the wallet through the
// `billing-token` route class, scoped by the sealed credential's own userId.
async function billingPortalCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      credentialKind: 'billing-portal',
      userId,
      sessionId: 'credential-1',
      createdAt: Date.now() - 1000,
    },
    { password: SECRET }
  );
  return `${BILLING_PORTAL_COOKIE_NAME}=${sealed}`;
}

async function seedUser(): Promise<string> {
  counter += 1;
  const username = `blur${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@usage-reads.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedConversation(userId: string): Promise<string> {
  const { conversationId } = await seedConversationWithEpoch(db, { userId, title: BYTES });
  return conversationId;
}

let sequence = 0;

/**
 * One assistant reply: a message plus its content item, stamped with the
 * generating model. Every billed generation below anchors to one of these.
 */
async function seedReply(args: {
  conversationId: string;
  modelId: string;
  contentType: 'text' | 'image';
}): Promise<string> {
  sequence += 1;
  const messageRows = await db
    .insert(messages)
    .values({
      conversationId: args.conversationId,
      senderType: 'assistant',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: sequence,
    })
    .returning({ id: messages.id });
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) throw new Error('message seed failed');
  const body =
    args.contentType === 'text'
      ? { contentType: 'text' as const, encryptedBlob: BYTES }
      : {
          contentType: 'image' as const,
          storageKey: `usage-reads/${crypto.randomUUID()}`,
          mimeType: 'image/png',
          sizeBytes: BYTES.length,
        };
  const contentRows = await db
    .insert(contentItems)
    .values({ messageId, modelId: args.modelId, providerName: PROVIDER, ...body })
    .returning({ id: contentItems.id });
  const contentItemId = contentRows[0]?.id;
  if (contentItemId === undefined) throw new Error('content item seed failed');
  return contentItemId;
}

async function seedTextUsage(args: {
  userId: string;
  conversationId: string;
  contentItemId?: string;
  modelId: string;
  costNanoUsd: bigint;
  createdAt: Date;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  providerName?: string;
}): Promise<void> {
  const inserted = await db
    .insert(usageRecords)
    .values({
      payerUserId: args.userId,
      conversationId: args.conversationId,
      ...(args.contentItemId === undefined ? {} : { contentItemId: args.contentItemId }),
      runId: crypto.randomUUID(),
      modelId: args.modelId,
      providerName: args.providerName ?? PROVIDER,
      modality: 'text',
      costNanoUsd: args.costNanoUsd,
      isEstimated: false,
      idempotencyKey: `usage-reads:${crypto.randomUUID()}`,
      createdAt: args.createdAt,
    })
    .returning({ id: usageRecords.id });
  const usageRecordId = inserted[0]?.id;
  if (usageRecordId === undefined) throw new Error('usage seed failed');
  await db.insert(llmCompletions).values({
    usageRecordId,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cachedInputTokens: args.cachedInputTokens,
  });
}

async function seedImageUsage(args: {
  userId: string;
  conversationId: string;
  contentItemId: string;
  costNanoUsd: bigint;
  createdAt: Date;
}): Promise<void> {
  // No llm_completions row — an image generation is deliberately absent from the
  // token-joined aggregations but present in the per-conversation total.
  await db.insert(usageRecords).values({
    payerUserId: args.userId,
    conversationId: args.conversationId,
    contentItemId: args.contentItemId,
    runId: crypto.randomUUID(),
    modelId: MODEL_IMG,
    providerName: PROVIDER,
    modality: 'image',
    costNanoUsd: args.costNanoUsd,
    isEstimated: false,
    idempotencyKey: `usage-reads:${crypto.randomUUID()}`,
    createdAt: args.createdAt,
  });
}

async function seedWallet(userId: string): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased' })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  return id;
}

async function seedLeg(args: {
  walletId: string;
  kind: 'deposit' | 'charge' | 'clawback' | 'promo' | 'refund';
  amountNanoUsd: bigint;
  balanceAfterNanoUsd: bigint;
  createdAt: Date;
}): Promise<void> {
  // Double-entry: the user-wallet leg plus a balancing house leg (excluded from
  // every read here) sharing a transactionId — the deferred zero-sum trigger
  // checks the pair at commit, so both must land in one transaction.
  const transactionId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(ledgerEntries).values([
      {
        transactionId,
        walletId: args.walletId,
        kind: args.kind,
        amountNanoUsd: args.amountNanoUsd,
        balanceAfterNanoUsd: args.balanceAfterNanoUsd,
        idempotencyKey: `usage-reads-leg:${crypto.randomUUID()}`,
        createdAt: args.createdAt,
      },
      {
        transactionId,
        houseAccount: 'revenue',
        kind: args.kind,
        amountNanoUsd: -args.amountNanoUsd,
        idempotencyKey: `usage-reads-house:${crypto.randomUUID()}`,
        createdAt: args.createdAt,
      },
    ]);
  });
}

let userId: string;
let otherUserId: string;
let convA: string;
let convB: string;
let cookie: string;
let walletId: string;

beforeAll(async () => {
  userId = await seedUser();
  otherUserId = await seedUser();
  cookie = await sessionCookie(userId);
  convA = await seedConversation(userId);
  convB = await seedConversation(userId);
  walletId = await seedWallet(userId);

  await seedTextUsage({
    userId,
    conversationId: convA,
    contentItemId: await seedReply({
      conversationId: convA,
      modelId: MODEL_A,
      contentType: 'text',
    }),
    modelId: MODEL_A,
    costNanoUsd: 1000n,
    createdAt: at(DAY1),
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 10,
  });
  await seedTextUsage({
    userId,
    conversationId: convA,
    contentItemId: await seedReply({
      conversationId: convA,
      modelId: MODEL_A,
      contentType: 'text',
    }),
    modelId: MODEL_A,
    costNanoUsd: 2000n,
    createdAt: at(DAY1),
    inputTokens: 200,
    outputTokens: 100,
    cachedInputTokens: 20,
  });
  await seedTextUsage({
    userId,
    conversationId: convB,
    contentItemId: await seedReply({
      conversationId: convB,
      modelId: MODEL_B,
      contentType: 'text',
    }),
    modelId: MODEL_B,
    costNanoUsd: 5000n,
    createdAt: at(DAY2),
    inputTokens: 300,
    outputTokens: 150,
    cachedInputTokens: 0,
  });
  await seedImageUsage({
    userId,
    conversationId: convB,
    contentItemId: await seedReply({
      conversationId: convB,
      modelId: MODEL_IMG,
      contentType: 'image',
    }),
    costNanoUsd: 3000n,
    createdAt: at(DAY2),
  });
  // Another user's usage must never leak into the caller's reads.
  const otherConv = await seedConversation(otherUserId);
  await seedTextUsage({
    userId: otherUserId,
    conversationId: otherConv,
    modelId: MODEL_A,
    costNanoUsd: 9000n,
    createdAt: at(DAY1),
    inputTokens: 999,
    outputTokens: 999,
    cachedInputTokens: 999,
  });

  // One ledger leg of every kind (covers the kind → legacy-type mapping), plus a
  // house-account leg that the user-leg reads must exclude.
  await seedLeg({
    walletId,
    kind: 'deposit',
    amountNanoUsd: 10_000n,
    balanceAfterNanoUsd: 10_000n,
    createdAt: atHour(DAY1, 10),
  });
  await seedLeg({
    walletId,
    kind: 'charge',
    amountNanoUsd: -3000n,
    balanceAfterNanoUsd: 7000n,
    createdAt: atHour(DAY1, 11),
  });
  await seedLeg({
    walletId,
    kind: 'clawback',
    amountNanoUsd: -500n,
    balanceAfterNanoUsd: 6500n,
    createdAt: atHour(DAY2, 10),
  });
  await seedLeg({
    walletId,
    kind: 'promo',
    amountNanoUsd: 200n,
    balanceAfterNanoUsd: 6700n,
    createdAt: atHour(DAY2, 11),
  });
  await seedLeg({
    walletId,
    kind: 'refund',
    amountNanoUsd: 300n,
    balanceAfterNanoUsd: 7000n,
    createdAt: atHour(DAY2, 12),
  });
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.userId, createdUserIds));
    const walletIds = walletRows.map((row) => row.id);
    // Both legs of each seeded transaction go in one statement — a partial
    // delete would leave an unbalanced transaction and trip the zero-sum trigger.
    await db.delete(ledgerEntries).where(like(ledgerEntries.idempotencyKey, 'usage-reads-%'));
    await db.delete(usageRecords).where(inArray(usageRecords.payerUserId, createdUserIds));
    if (walletIds.length > 0) {
      await db.delete(wallets).where(inArray(wallets.id, walletIds));
    }
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

function get(app: Hono<AppEnv>, path: string, authed = true): Promise<Response> {
  return Promise.resolve(app.request(path, authed ? { headers: { cookie } } : {}, testEnv));
}

async function jsonBody<T>(res: Response): Promise<T> {
  const body: unknown = await res.json();
  return body as T;
}

interface Series<Row> {
  data: Row[];
}

interface ConversationRow {
  conversationId: string;
  totalSpent: string;
  messageCount: number;
  modelIds: string[];
}

interface Page {
  transactions: { type: string }[];
  nextCursor: string | null;
}

const RANGE = `startDate=${DAY1}&endDate=${DAY2}`;

describe('GET /billing/usage/summary', () => {
  it('rejects an unauthenticated caller', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?${RANGE}`, false);
    expect(res.status).toBe(401);
  });

  it('totals spend over every charge in the range, images included', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?${RANGE}`);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ totalSpent: string }>(res);
    // Text 1000 + 2000 + 5000, image 3000.
    expect(body.totalSpent).toBe('11000');
  });

  it('counts each billed reply once, any modality', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?${RANGE}`);
    const body = await jsonBody<{ messageCount: number }>(res);
    // Three text replies and one image reply.
    expect(body.messageCount).toBe(4);
  });

  it('totals tokens over the caller’s language generations only', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?${RANGE}`);
    const body = await jsonBody<{
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCachedTokens: number;
    }>(res);
    expect(body.totalInputTokens).toBe(600);
    expect(body.totalOutputTokens).toBe(300);
    expect(body.totalCachedTokens).toBe(30);
  });

  it('totals the same spend as the sum of its per-conversation rows', async () => {
    const summaryRes = await get(buildApp(), `/billing/usage/summary?${RANGE}`);
    const summary = await jsonBody<{ totalSpent: string }>(summaryRes);
    const rowsRes = await get(buildApp(), `/billing/usage/spending-by-conversation?${RANGE}`);
    const { data } = await jsonBody<Series<ConversationRow>>(rowsRes);
    const rowTotal = data.reduce((sum, row) => sum + BigInt(row.totalSpent), 0n);
    expect(BigInt(summary.totalSpent)).toBe(rowTotal);
  });

  it('returns zeros for a range with no usage', async () => {
    const res = await get(
      buildApp(),
      `/billing/usage/summary?startDate=2020-01-01&endDate=2020-01-02`
    );
    const body = await jsonBody<{ totalSpent: string; messageCount: number }>(res);
    expect(body.totalSpent).toBe('0');
    expect(body.messageCount).toBe(0);
  });

  it('rejects a malformed date range', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?startDate=nope&endDate=${DAY2}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('GET /billing/usage/spending-over-time', () => {
  it('buckets spend by day and model', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-over-time?${RANGE}&granularity=day`);
    expect(res.status).toBe(200);
    const { data } =
      await jsonBody<Series<{ period: string; model: string; totalCost: string; count: number }>>(
        res
      );
    const a = data.find((row) => row.model === MODEL_A);
    expect(a?.totalCost).toBe('3000');
    expect(a?.count).toBe(2);
    const b = data.find((row) => row.model === MODEL_B);
    expect(b?.totalCost).toBe('5000');
    expect(b?.count).toBe(1);
  });

  it('narrows to a single model when filtered', async () => {
    const res = await get(
      buildApp(),
      `/billing/usage/spending-over-time?${RANGE}&granularity=week&model=${MODEL_A}`
    );
    const { data } = await jsonBody<Series<{ model: string }>>(res);
    expect(data.every((row) => row.model === MODEL_A)).toBe(true);
  });
});

describe('GET /billing/usage/cost-by-model', () => {
  it('breaks down spend + tokens per model, priciest first, excluding media', async () => {
    const res = await get(buildApp(), `/billing/usage/cost-by-model?${RANGE}`);
    const { data } = await jsonBody<
      Series<{
        model: string;
        provider: string;
        totalCost: string;
        messageCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      }>
    >(res);
    expect(data.map((row) => row.model)).toEqual([MODEL_B, MODEL_A]);
    expect(data.some((row) => row.model === MODEL_IMG)).toBe(false);
    const a = data.find((row) => row.model === MODEL_A);
    expect(a?.totalCost).toBe('3000');
    expect(a?.provider).toBe('usage-reads');
    expect(a?.totalInputTokens).toBe(300);
    expect(a?.totalOutputTokens).toBe(150);
  });
});

describe('GET /billing/usage/cost-by-model — a model served by two endpoints', () => {
  it('reports one row for the model, named by its maker', async () => {
    const servedUserId = await seedUser();
    const servedConversation = await seedConversation(servedUserId);
    for (const [providerName, costNanoUsd] of [
      ['Google Vertex', 1000n],
      ['Amazon Bedrock', 2500n],
    ] as const) {
      await seedTextUsage({
        userId: servedUserId,
        conversationId: servedConversation,
        modelId: MODEL_A,
        costNanoUsd,
        createdAt: at(DAY1),
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        providerName,
      });
    }

    const res = await Promise.resolve(
      buildApp().request(
        `/billing/usage/cost-by-model?${RANGE}`,
        { headers: { cookie: await sessionCookie(servedUserId) } },
        testEnv
      )
    );
    const { data } =
      await jsonBody<Series<{ model: string; provider: string; totalCost: string }>>(res);

    expect(data).toEqual([
      expect.objectContaining({ model: MODEL_A, provider: 'usage-reads', totalCost: '3500' }),
    ]);
  });
});

describe('GET /billing/usage/cost-by-model — a model id with no maker segment', () => {
  it('names the model by its whole id', async () => {
    const soloUserId = await seedUser();
    await seedTextUsage({
      userId: soloUserId,
      conversationId: await seedConversation(soloUserId),
      modelId: 'usage-reads-unsegmented',
      costNanoUsd: 700n,
      createdAt: at(DAY1),
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
    });

    const res = await Promise.resolve(
      buildApp().request(
        `/billing/usage/cost-by-model?${RANGE}`,
        { headers: { cookie: await sessionCookie(soloUserId) } },
        testEnv
      )
    );
    const { data } = await jsonBody<Series<{ model: string; provider: string }>>(res);

    expect(data.map((row) => row.provider)).toEqual(['usage-reads-unsegmented']);
  });
});

describe('GET /billing/usage/spending-by-conversation', () => {
  it('groups spend by conversation (all modalities), priciest first', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-by-conversation?${RANGE}`);
    const { data } = await jsonBody<Series<ConversationRow>>(res);
    expect(data.map((row) => row.conversationId)).toEqual([convB, convA]);
    // convB carries the text (5000) and the image (3000) generation.
    expect(data.find((row) => row.conversationId === convB)?.totalSpent).toBe('8000');
    expect(data.find((row) => row.conversationId === convA)?.totalSpent).toBe('3000');
  });

  it('counts two replies by one model as two messages of that model', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-by-conversation?${RANGE}`);
    const { data } = await jsonBody<Series<ConversationRow>>(res);
    const row = data.find((entry) => entry.conversationId === convA);
    expect(row?.messageCount).toBe(2);
    expect(row?.modelIds).toEqual([MODEL_A]);
  });

  it('lists every modality’s generating model, highest spend first', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-by-conversation?${RANGE}`);
    const { data } = await jsonBody<Series<ConversationRow>>(res);
    const row = data.find((entry) => entry.conversationId === convB);
    expect(row?.messageCount).toBe(2);
    expect(row?.modelIds).toEqual([MODEL_B, MODEL_IMG]);
  });

  it('caps the rows at the requested limit, keeping the priciest', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-by-conversation?${RANGE}&limit=1`);
    const { data } = await jsonBody<Series<ConversationRow>>(res);
    expect(data.map((row) => row.conversationId)).toEqual([convB]);
  });

  it('serializes exactly the row fields the shared schema declares', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-by-conversation?${RANGE}`);
    const { data } = await jsonBody<Series<ConversationRow>>(res);
    for (const row of data) {
      expect(spendingByConversationRowSchema.strict().parse(row)).toEqual(row);
    }
  });
});

describe('usage reads over multi-generation turns', () => {
  let turnsUserId: string;
  let turnsCookie: string;
  let twoModelConv: string;
  let autoConv: string;

  beforeAll(async () => {
    turnsUserId = await seedUser();
    turnsCookie = await sessionCookie(turnsUserId);
    twoModelConv = await seedConversation(turnsUserId);
    autoConv = await seedConversation(turnsUserId);

    // A two-model turn: one reply per model, each billed on its own.
    for (const [modelId, costNanoUsd] of [
      [MODEL_A, 4000n],
      [MODEL_B, 6000n],
    ] as const) {
      await seedTextUsage({
        userId: turnsUserId,
        conversationId: twoModelConv,
        contentItemId: await seedReply({
          conversationId: twoModelConv,
          modelId,
          contentType: 'text',
        }),
        modelId,
        costNanoUsd,
        createdAt: at(DAY1),
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
      });
    }

    // An Auto turn: the classifier's generation and the answer's anchor to the
    // one reply, which records the answering model.
    const answer = await seedReply({
      conversationId: autoConv,
      modelId: MODEL_A,
      contentType: 'text',
    });
    for (const [modelId, costNanoUsd] of [
      [MODEL_CLASSIFIER, 500n],
      [MODEL_A, 2500n],
    ] as const) {
      await seedTextUsage({
        userId: turnsUserId,
        conversationId: autoConv,
        contentItemId: answer,
        modelId,
        costNanoUsd,
        createdAt: at(DAY2),
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
      });
    }
  });

  function getAs(path: string): Promise<Response> {
    return Promise.resolve(buildApp().request(path, { headers: { cookie: turnsCookie } }, testEnv));
  }

  async function rows(): Promise<ConversationRow[]> {
    const res = await getAs(`/billing/usage/spending-by-conversation?${RANGE}`);
    const { data } = await jsonBody<Series<ConversationRow>>(res);
    return data;
  }

  async function rowFor(conversationId: string): Promise<ConversationRow | undefined> {
    const all = await rows();
    return all.find((entry) => entry.conversationId === conversationId);
  }

  it('counts a two-model turn as one message per model', async () => {
    const row = await rowFor(twoModelConv);
    expect(row?.messageCount).toBe(2);
    expect(row?.modelIds).toEqual([MODEL_B, MODEL_A]);
  });

  it('counts an Auto turn as one message of the answering model', async () => {
    const row = await rowFor(autoConv);
    expect(row?.messageCount).toBe(1);
    expect(row?.modelIds).toEqual([MODEL_A]);
  });

  it('bills the classifier’s generation into the Auto turn’s conversation', async () => {
    const row = await rowFor(autoConv);
    expect(row?.totalSpent).toBe('3000');
  });

  it('counts the summary’s messages as the rows count them', async () => {
    const res = await getAs(`/billing/usage/summary?${RANGE}`);
    const summary = await jsonBody<{ messageCount: number }>(res);
    const all = await rows();
    const rowCount = all.reduce((sum, row) => sum + row.messageCount, 0);
    expect(summary.messageCount).toBe(3);
    expect(rowCount).toBe(3);
  });

  it('totals the summary’s spend as the sum of the rows', async () => {
    const res = await getAs(`/billing/usage/summary?${RANGE}`);
    const summary = await jsonBody<{ totalSpent: string }>(res);
    const all = await rows();
    const rowTotal = all.reduce((sum, row) => sum + BigInt(row.totalSpent), 0n);
    expect(summary.totalSpent).toBe('13000');
    expect(BigInt(summary.totalSpent)).toBe(rowTotal);
  });
});

describe('readLedgerHistory', () => {
  const window = {
    start: new Date(`${DAY1}T00:00:00.000Z`),
    end: new Date(`${DAY2}T23:59:59.999Z`),
  };

  it('returns user-wallet legs oldest-first, excluding house legs', async () => {
    const result = await stores.readLedgerHistory(db, { userId, ...window, limit: 200 });
    const rows = result._unsafeUnwrap();
    expect(rows.map((row) => row.kind)).toEqual([
      'deposit',
      'charge',
      'clawback',
      'promo',
      'refund',
    ]);
    expect(rows[0]?.amountNanoUsd).toBe(10_000n);
    expect(rows[0]?.balanceAfterNanoUsd).toBe(10_000n);
    expect(rows[1]?.amountNanoUsd).toBe(-3000n);
  });

  it('respects the row limit', async () => {
    const result = await stores.readLedgerHistory(db, { userId, ...window, limit: 2 });
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });
});

describe('GET /billing/usage/models', () => {
  it('lists the caller’s distinct models ascending', async () => {
    const res = await get(buildApp(), '/billing/usage/models');
    const { models } = await jsonBody<{ models: string[] }>(res);
    expect(models).toEqual([MODEL_A, MODEL_B, MODEL_IMG]);
  });
});

describe('GET /billing/transactions', () => {
  it('pages newest-first with a next cursor, serializing the ledger kind', async () => {
    const res = await get(buildApp(), '/billing/transactions?limit=2');
    const body = await jsonBody<{
      transactions: { type: string; amount: string; balanceAfter: string; model: null }[];
      nextCursor: string | null;
    }>(res);
    expect(body.transactions).toHaveLength(2);
    // Newest-first: refund then promo (both on DAY2, insertion order).
    expect(body.transactions[0]?.type).toBe('refund');
    expect(body.transactions[0]?.model).toBeNull();
    expect(body.nextCursor).not.toBeNull();
  });

  it('walks the whole history across a cursor and back-fills every kind', async () => {
    const firstRes = await get(buildApp(), '/billing/transactions?limit=3');
    const first = await jsonBody<Page>(firstRes);
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('expected a next cursor');
    const secondRes = await get(
      buildApp(),
      `/billing/transactions?limit=3&cursor=${encodeURIComponent(cursor)}`
    );
    const second = await jsonBody<Page>(secondRes);
    const types = [...first.transactions, ...second.transactions].map((txn) => txn.type);
    expect(new Set(types)).toEqual(new Set(['deposit', 'charge', 'clawback', 'promo', 'refund']));
    expect(second.nextCursor).toBeNull();
  });

  it.each([['deposit'], ['charge'], ['refund'], ['clawback'], ['promo']])(
    'filters by ledger kind %s',
    async (filter) => {
      const res = await get(buildApp(), `/billing/transactions?type=${filter}`);
      const { transactions } = await jsonBody<Page>(res);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.type).toBe(filter);
    }
  );

  it('rejects the retired `renewal` type at the query schema', async () => {
    // `renewal` is a retired legacy ledger kind — the new ledger writes no such
    // rows, so the value is gone from the enum and the filter is schema-rejected
    // rather than silently returning an empty page.
    const res = await get(buildApp(), '/billing/transactions?type=renewal');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('honors an offset page', async () => {
    const res = await get(buildApp(), '/billing/transactions?limit=2&offset=2');
    const { transactions } = await jsonBody<Page>(res);
    expect(transactions.length).toBeGreaterThan(0);
  });

  it('admits the billing-portal credential to read its own transactions', async () => {
    const res = await buildApp().request(
      '/billing/transactions?limit=2',
      { headers: { cookie: await billingPortalCookie(userId) } },
      testEnv
    );
    expect(res.status).toBe(200);
    const { transactions } = await jsonBody<Page>(res);
    expect(transactions.length).toBeGreaterThan(0);
  });

  it('scopes a billing-portal transactions read to its own ledger, never another user’s', async () => {
    // otherUserId owns usage rows but NO ledger legs — every seeded leg belongs
    // to userId's wallet. A billing-portal principal for otherUserId therefore
    // reads an empty page, proving userId's ledger never leaks cross-user.
    const res = await buildApp().request(
      '/billing/transactions',
      { headers: { cookie: await billingPortalCookie(otherUserId) } },
      testEnv
    );
    expect(res.status).toBe(200);
    const { transactions } = await jsonBody<Page>(res);
    expect(transactions).toHaveLength(0);
  });
});

describe('usage reads the usage page no longer draws', () => {
  it.each([
    `/billing/usage/token-usage-over-time?${RANGE}&granularity=day`,
    `/billing/usage/balance-history?${RANGE}`,
  ])('answers 404 for %s', async (path) => {
    const res = await get(buildApp(), path);
    expect(res.status).toBe(404);
  });
});

describe('usage reads under store failure', () => {
  const failing: Partial<BillingStores> = {
    summarizeUsage: () => errAsync(unavailableError('down')),
    usageSpendingOverTime: () => errAsync(unavailableError('down')),
    usageCostByModel: () => errAsync(unavailableError('down')),
    usageSpendingByConversation: () => errAsync(unavailableError('down')),
    distinctUsageModels: () => errAsync(unavailableError('down')),
    listLedgerTransactions: () => errAsync(unavailableError('down')),
  };
  const app = (): Hono<AppEnv> => buildApp({ stores: { ...createBillingStores(), ...failing } });

  it.each([
    `/billing/usage/summary?${RANGE}`,
    `/billing/usage/spending-over-time?${RANGE}`,
    `/billing/usage/cost-by-model?${RANGE}`,
    `/billing/usage/spending-by-conversation?${RANGE}`,
    '/billing/usage/models',
    '/billing/transactions',
  ])('maps a store failure to 503 for %s', async (path) => {
    const res = await get(app(), path);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

// Referenced to keep the eslint no-unused import guard satisfied where `and`/`eq`
// help future assertions; a lightweight sanity read of a seeded row.
describe('seed sanity', () => {
  it('stamped the conversation onto a seeded usage row', async () => {
    const rows = await db
      .select({ conversationId: usageRecords.conversationId })
      .from(usageRecords)
      .where(and(eq(usageRecords.payerUserId, userId), eq(usageRecords.modelId, MODEL_B)));
    expect(rows[0]?.conversationId).toBe(convB);
  });
});
