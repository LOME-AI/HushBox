import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  bannerConfig,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  feedback,
  growthHourlyFunnel,
  jobs,
  ledgerEntries,
  llmCompletions,
  messages,
  modelCatalog,
  newsletterSubscribers,
  sharedLinks,
  sharedMessages,
  usageRecords,
  userAcquisition,
  users,
  verificationTokens,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { decryptTextFromEpoch, generateKeyPair, openEpochWrap } from '@hushbox/crypto';
import { GROWTH_DIRECT_CAMPAIGN } from '@hushbox/shared';
import {
  HOUR_MS,
  TEST_DAY_START,
  TEST_YEAR_START,
  freezeClock,
  isoAt,
  secondsAt,
} from '@hushbox/shared/test-time';
import { applyPipeline } from '../middleware/pipeline.js';
import { GROWTH_REDIS_KEYS, callerIpIdForAddress, growthHourBucket } from '../lib/redis/index.js';
import {
  adminDashboardRateLimit,
  adminJobQueueRateLimit,
  adminSqlPanelRateLimit,
} from '../slices/admin/index.js';
import {
  createAnnouncementsManifest,
  createAnnouncementsStores,
} from '../slices/announcements/index.js';
import { guestConversationIpRateLimit } from '../slices/conversations/index.js';
import { countRegistrationStarted } from '../slices/growth/public/funnel.js';
import { clearVersionOverride, getVersionOverride } from '../middleware/version-override.js';
import * as notificationsBarrel from '../slices/notifications/index.js';
import { createEmailSenderFromEnv } from '../slices/notifications/index.js';
import { createDevManifest } from './routes.js';
import { hmacRateLimitId, rateLimitKey } from '../lib/rate-limit/index.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for dev route integration tests`);
  }
  return value;
}

/** Typed JSON read severed from hono's Response inference (json() is unknown here). */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * A caller address no concurrently-running file can collide with. RFC 1918
 * space rather than documentation space deliberately: the E2E suite derives its
 * guest identities across the whole of TEST-NET-3 and its callers across
 * TEST-NET-1, and a Playwright run spending those windows shares this Redis.
 */
function uniqueIp(): string {
  return `10.${[...crypto.getRandomValues(new Uint8Array(3))].join('.')}`;
}

const testEnv: Bindings & TelemetryEnv & Record<string, unknown> = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
  R2_S3_ENDPOINT: requiredEnv('R2_S3_ENDPOINT'),
  R2_BUCKET_MEDIA: requiredEnv('R2_BUCKET_MEDIA'),
  R2_ACCESS_KEY_ID: requiredEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requiredEnv('R2_SECRET_ACCESS_KEY'),
};

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({
  url: requiredEnv('UPSTASH_REDIS_REST_URL'),
  token: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
});

const MODEL_PREFIX = 'platform-dev';
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Conversations first: a user delete would SET NULL membership rows,
    // tripping the members identity-or-left check; the conversation cascade
    // removes members/messages/epochs cleanly.
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(like(modelCatalog.modelId, `${MODEL_PREFIX}%`));
  await db
    .delete(growthHourlyFunnel)
    .where(eq(growthHourlyFunnel.hour, new Date(`${ROLLUP_FIXTURE_HOUR}:00:00.000Z`)));
  await redis.del(GROWTH_REDIS_KEYS.started.buildKey(ROLLUP_FIXTURE_HOUR, GROWTH_DIRECT_CAMPAIGN));
  await db.$client.end();
});

afterEach(() => {
  clearVersionOverride();
});

function buildApp(): Hono<AppEnv> {
  const manifest = createDevManifest();
  // The public banner read is mounted beside the dev routes so the banner
  // reset is observed through the surface its callers read.
  const announcements = createAnnouncementsManifest({ stores: createAnnouncementsStores });
  const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: {} } });
  app.route(manifest.basePath, manifest.routes);
  app.route(announcements.basePath, announcements.routes);
  return app;
}

const app = buildApp();

async function request(
  path: string,
  init: { method?: string; body?: unknown } = {},
  env: typeof testEnv = testEnv
): Promise<Response> {
  return app.request(
    path,
    {
      method: init.method ?? 'GET',
      ...(init.body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(init.body),
          }),
    },
    env
  );
}

async function seedUser(
  emailDomain = 'platform-dev.test'
): Promise<{ id: string; email: string; privateKey: Uint8Array }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const keys = generateKeyPair();
  const email = `pd-${suffix}@${emailDomain}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email,
        username: `pd${suffix}`,
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

/** A persona with the purchased wallet registration provisions. */
async function seedFundedUser(): Promise<{ id: string; email: string }> {
  const user = await seedUser();
  await db.insert(wallets).values({
    userId: user.id,
    type: 'purchased',
    balanceNanoUsd: 5_000_000_000n,
  });
  return { id: user.id, email: user.email };
}

/**
 * Decrypts a seeded conversation's title along the path the client uses to
 * render it: unwrap the first-epoch key from the owner's member wrap, then
 * ECIES-decrypt the `conversations.title` blob. The title is stored encrypted,
 * so this is the only way to assert the plaintext the route forwarded.
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
  return decryptTextFromEpoch(epochPrivateKey, convRow.title, {
    conversationId,
    epochNumber: 1,
  });
}

async function seedTextModel(): Promise<string> {
  const modelId = `${MODEL_PREFIX}/${crypto.randomUUID().slice(0, 8)}`;
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: {
        id: modelId,
        provider: 'p',
        version: '3',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: [],
        limits: { contextLength: 1000 },
        pricing: { kind: 'tokens', anchor: { base: { input: '2', output: '3' }, tiers: [] } },
        zdrReachable: true,
        releasedAt: FIXTURE_STAMP_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
  return modelId;
}

/** Factory calls resolve a seed model from the catalog, which the no-text-model
 *  test below empties — so every such call re-seeds first. */
async function withSeededCatalog<T>(run: () => Promise<T>): Promise<T> {
  await seedTextModel();
  return run();
}

describe('dev route class', () => {
  it('hides every dev route in production (404, indistinguishable from missing)', async () => {
    const productionEnv = { ...testEnv, NODE_ENV: 'production' };
    const res = await request('/dev/personas', {}, productionEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
    const post = await request(
      '/dev/set-version',
      { method: 'POST', body: { version: '9.9.9' } },
      productionEnv
    );
    expect(post.status).toBe(404);
  });
});

describe('GET /dev/personas', () => {
  it('lists dev-domain personas with stats and credits', async () => {
    const persona = await seedUser('dev.hushbox.ai');
    await db.insert(wallets).values({
      userId: persona.id,
      type: 'purchased',
      balanceNanoUsd: 5_000_000_000n,
    });
    const res = await request('/dev/personas?type=dev');
    expect(res.status).toBe(200);
    const body = await readJson<{ personas: Record<string, unknown>[] }>(res);
    const found = body.personas.find((p) => p['email'] === persona.email);
    expect(found).toMatchObject({
      id: persona.id,
      emailVerified: false,
      credits: '$5.00',
      stats: { conversationCount: 0, messageCount: 0, projectCount: 0 },
    });
  });
});

async function assertConversationShell(
  conversationId: string,
  ownerId: string,
  memberCount: number
): Promise<void> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  expect(conversation?.userId).toBe(ownerId);

  const epochRows = await db.select().from(epochs).where(eq(epochs.conversationId, conversationId));
  expect(epochRows).toHaveLength(1);
  const wraps = await db
    .select()
    .from(epochMembers)
    .where(eq(epochMembers.epochId, epochRows[0]?.id ?? ''));
  expect(wraps).toHaveLength(memberCount);

  const memberRows = await db
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  expect(memberRows).toHaveLength(memberCount);
  expect(memberRows.some((row) => row.userId === ownerId && row.privilege === 'owner')).toBe(true);
}

async function assertModeledTextItem(messageId: string): Promise<void> {
  const items = await db.select().from(contentItems).where(eq(contentItems.messageId, messageId));
  expect(items).toHaveLength(1);
  expect(items[0]?.contentType).toBe('text');
  expect(items[0]?.modelId).not.toBeNull();
}

async function assertSeededMessageChain(conversationId: string): Promise<void> {
  const messageRows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sequenceNumber));
  expect(messageRows).toHaveLength(2);
  const [userMessage, aiMessage] = messageRows;
  expect(userMessage?.senderType).toBe('user');
  expect(aiMessage?.senderType).toBe('assistant');
  expect(aiMessage?.parentMessageId).toBe(userMessage?.id);
  expect(aiMessage?.batchId).toBe(userMessage?.batchId);
  await assertModeledTextItem(aiMessage?.id ?? '');
}

describe('GET /dev/personas (type variants)', () => {
  it('defaults to the dev domain when no type is given', async () => {
    const res = await request('/dev/personas');
    expect(res.status).toBe(200);
  });

  it('lists test-domain personas for type=test', async () => {
    const persona = await seedUser('test.hushbox.ai');
    const res = await request('/dev/personas?type=test');
    expect(res.status).toBe(200);
    const body = await readJson<{ personas: { email: string }[] }>(res);
    expect(body.personas.some((p) => p.email === persona.email)).toBe(true);
  });
});

describe('POST /dev/conversation', () => {
  it('seeds a conversation with epoch, membership and a parented message chain', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          messages: [
            { content: 'hello', senderType: 'user' },
            { content: 'world', senderType: 'ai' },
          ],
        },
      })
    );
    expect(res.status).toBe(201);
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    await assertConversationShell(conversationId, owner.id, 1);
    await assertSeededMessageChain(conversationId);
  });

  it('forwards an optional title to the seeded conversation', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: { ownerEmail: owner.email, title: 'Mobile render proof' },
      })
    );
    expect(res.status).toBe(201);
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    expect(await decryptConversationTitle(conversationId, owner.privateKey)).toBe(
      'Mobile render proof'
    );
  });

  it('leaves the conversation untitled when no title is given', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: { ownerEmail: owner.email },
      })
    );
    expect(res.status).toBe(201);
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    expect(await decryptConversationTitle(conversationId, owner.privateKey)).toBe('');
  });

  it('seeds the multi-model fan-out shape (shared batchId, common parent, distinct costs)', async () => {
    // A costed seed turn is charged like a real one, so the owner needs the
    // purchased wallet registration provisions.
    const owner = await seedFundedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          aiTurn: { userContent: 'compare', responseCount: 2 },
        },
      })
    );
    expect(res.status).toBe(201);
    const { conversationId } = await readJson<{ conversationId: string }>(res);

    const messageRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.sequenceNumber));
    expect(messageRows).toHaveLength(3);
    const [userMessage, ...siblings] = messageRows;
    expect(userMessage?.senderType).toBe('user');
    for (const sibling of siblings) {
      expect(sibling.senderType).toBe('assistant');
      expect(sibling.parentMessageId).toBe(userMessage?.id);
      expect(sibling.batchId).toBe(userMessage?.batchId);
    }

    const items = await db
      .select()
      .from(contentItems)
      .where(
        inArray(
          contentItems.messageId,
          siblings.map((sibling) => sibling.id)
        )
      );
    const costs = items.map((item) => item.costNanoUsd);
    expect(new Set(costs.map(String)).size).toBe(2);
    expect(costs.every((cost) => cost !== null && cost > 0n)).toBe(true);
  });

  it('seeds an empty conversation when no messages are given', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', { method: 'POST', body: { ownerEmail: owner.email } })
    );
    expect(res.status).toBe(201);
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(0);
  });

  it('answers 404 when the model catalog exposes no text model', async () => {
    const owner = await seedUser();
    await db.delete(modelCatalog);
    const res = await request('/dev/conversation', {
      method: 'POST',
      body: { ownerEmail: owner.email },
    });
    expect(res.status).toBe(404);
  });

  it('answers 404 for an unknown owner email', async () => {
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: { ownerEmail: `missing-${crypto.randomUUID().slice(0, 8)}@nope.test` },
      })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });
});

describe('POST /dev/media-conversation', () => {
  it('seeds a finished media turn with a stored ciphertext object', async () => {
    // The seeded media cost is charged like a real one, so the owner needs the
    // purchased wallet registration provisions.
    const owner = await seedFundedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/media-conversation', {
        method: 'POST',
        body: { ownerEmail: owner.email, userContent: 'draw a cat', mediaType: 'image' },
      })
    );
    expect(res.status).toBe(201);
    const body = await readJson<{ conversationId: string; assistantMessageId: string }>(res);
    expect(body.conversationId).toBeTruthy();

    const items = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, body.assistantMessageId));
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.contentType).toBe('image');
    expect(item?.mimeType).toBe('image/png');
    expect(item?.storageKey).toContain(`media/${body.conversationId}/${body.assistantMessageId}/`);
    expect(item?.sizeBytes).toBeGreaterThan(0);
    expect(item?.costNanoUsd).toBe(3_000_000n);
  });

  it('surfaces a storage-unavailable seed failure as 503 UNAVAILABLE, not opaque 404', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request(
        '/dev/media-conversation',
        {
          method: 'POST',
          body: { ownerEmail: owner.email, userContent: 'draw a cat', mediaType: 'image' },
        },
        { ...testEnv, R2_BUCKET_MEDIA: 'hushbox-no-such-bucket' }
      )
    );
    expect(res.status).toBe(503);
    const body = await readJson<{ code: string }>(res);
    expect(body.code).toBe('UNAVAILABLE');
  });
});

describe('POST /dev/group-chat', () => {
  it('seeds members with wraps, honouring pending invitees', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pending = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/group-chat', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          memberEmails: [member.email, pending.email],
          pendingMemberEmails: [pending.email],
          messages: [
            { content: 'hi from member', senderType: 'user', senderEmail: member.email },
            { content: 'answer', senderType: 'ai' },
          ],
        },
      })
    );
    expect(res.status).toBe(201);
    const body = await readJson<{
      conversationId: string;
      members: { userId: string; username: string; email: string }[];
    }>(res);
    expect(body.members.map((m) => m.userId)).toEqual([owner.id, member.id, pending.id]);

    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, body.conversationId));
    expect(memberRows).toHaveLength(3);
    const byUser = new Map(memberRows.map((row) => [row.userId, row]));
    expect(byUser.get(owner.id)?.privilege).toBe('owner');
    expect(byUser.get(member.id)?.acceptedAt).not.toBeNull();
    expect(byUser.get(pending.id)?.acceptedAt).toBeNull();

    const epochRows = await db
      .select()
      .from(epochs)
      .where(eq(epochs.conversationId, body.conversationId));
    const wraps = await db
      .select()
      .from(epochMembers)
      .where(eq(epochMembers.epochId, epochRows[0]?.id ?? ''));
    expect(wraps).toHaveLength(3);

    const messageRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, body.conversationId))
      .orderBy(asc(messages.sequenceNumber));
    expect(messageRows[0]?.senderId).toBe(member.id);
    expect(messageRows[1]?.senderType).toBe('assistant');
  });

  it('seeds a bare group chat (no messages) and attributes unknown senderEmail to the owner', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const bare = await withSeededCatalog(() =>
      request('/dev/group-chat', {
        method: 'POST',
        body: { ownerEmail: owner.email, memberEmails: [member.email] },
      })
    );
    expect(bare.status).toBe(201);
    const bareBody = await readJson<{ conversationId: string }>(bare);
    const bareMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, bareBody.conversationId));
    expect(bareMessages).toHaveLength(0);

    const withGhostSender = await withSeededCatalog(() =>
      request('/dev/group-chat', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          memberEmails: [member.email],
          messages: [
            {
              content: 'ghost-authored',
              senderType: 'user',
              senderEmail: `ghost-${crypto.randomUUID().slice(0, 8)}@nope.test`,
            },
          ],
        },
      })
    );
    expect(withGhostSender.status).toBe(201);
    const ghostBody = await readJson<{ conversationId: string }>(withGhostSender);
    const ghostMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, ghostBody.conversationId));
    expect(ghostMessages[0]?.senderId).toBe(owner.id);
  });

  it('answers 404 when a member email is unknown', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/group-chat', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          memberEmails: [`ghost-${crypto.randomUUID().slice(0, 8)}@nope.test`],
        },
      })
    );
    expect(res.status).toBe(404);
  });

  it('answers 404 when the owner email is unknown', async () => {
    const member = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/group-chat', {
        method: 'POST',
        body: {
          ownerEmail: `ghost-${crypto.randomUUID().slice(0, 8)}@nope.test`,
          memberEmails: [member.email],
        },
      })
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /dev/wallet-balance', () => {
  it('sets the wallet to an exact value with a zero-sum ledger pair', async () => {
    const user = await seedUser();
    const walletRows = await db
      .insert(wallets)
      .values({ userId: user.id, type: 'purchased', balanceNanoUsd: 1_000_000_000n })
      .returning({ id: wallets.id });
    const walletId = walletRows[0]?.id ?? '';

    const res = await request('/dev/wallet-balance', {
      method: 'POST',
      body: { email: user.email, walletType: 'purchased', balance: '5.00' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, newBalance: '5.000000000' });

    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId));
    expect(wallet?.balanceNanoUsd).toBe(5_000_000_000n);

    const legs = await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, walletId));
    expect(legs).toHaveLength(1);
    const transactionId = legs[0]?.transactionId ?? '';
    const pair = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, transactionId));
    expect(pair).toHaveLength(2);
    const sum = pair.reduce((total, leg) => total + leg.amountNanoUsd, 0n);
    expect(sum).toBe(0n);
  });

  it('is a no-op when the balance already matches (idempotent repeat)', async () => {
    const user = await seedUser();
    await db
      .insert(wallets)
      .values({ userId: user.id, type: 'purchased', balanceNanoUsd: 2_000_000_000n });
    const body = { email: user.email, walletType: 'purchased', balance: '2.00' };
    const res = await request('/dev/wallet-balance', { method: 'POST', body });
    expect(res.status).toBe(200);
    const again = await request('/dev/wallet-balance', { method: 'POST', body });
    expect(again.status).toBe(200);
  });

  it('answers 404 for an unknown user and for a missing wallet type', async () => {
    const noUser = await request('/dev/wallet-balance', {
      method: 'POST',
      body: {
        email: `missing-${crypto.randomUUID().slice(0, 8)}@nope.test`,
        walletType: 'purchased',
        balance: '1.00',
      },
    });
    expect(noUser.status).toBe(404);

    const user = await seedUser();
    const noWallet = await request('/dev/wallet-balance', {
      method: 'POST',
      body: { email: user.email, walletType: 'free_tier', balance: '1.00' },
    });
    expect(noWallet.status).toBe(404);
  });
});

describe('DELETE /dev/banner', () => {
  async function readPublicBanner(): Promise<{ hash: string | null; messages: unknown[] }> {
    const res = await request('/announcements/banner');
    expect(res.status).toBe(200);
    return readJson<{ hash: string | null; messages: unknown[] }>(res);
  }

  async function seedEnabledBanner(): Promise<void> {
    await db.delete(bannerConfig);
    await db.insert(bannerConfig).values({
      enabled: true,
      messages: [{ text: 'left enabled by a test', variant: 'warning' }],
    });
  }

  // `banner_config` is global to the worker slot's database, which later files
  // in the slot share, so no row outlives the test that wrote it.
  afterEach(async () => {
    await db.delete(bannerConfig);
  });

  it('disables an enabled banner and clears its messages', async () => {
    await seedEnabledBanner();
    const before = await readPublicBanner();
    expect(before.hash).not.toBeNull();

    const res = await request('/dev/banner', { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(await readPublicBanner()).toEqual({ hash: null, messages: [] });
    const rows = await db
      .select({ enabled: bannerConfig.enabled, messages: bannerConfig.messages })
      .from(bannerConfig);
    expect(rows).toEqual([{ enabled: false, messages: [] }]);
  });

  it('answers 200 and leaves the banner disabled when it is already disabled', async () => {
    await seedEnabledBanner();
    const first = await request('/dev/banner', { method: 'DELETE' });
    expect(first.status).toBe(200);

    const again = await request('/dev/banner', { method: 'DELETE' });
    expect(again.status).toBe(200);
    const after = await readPublicBanner();
    expect(after.hash).toBeNull();
  });
});

describe('POST /dev/usage-history', () => {
  async function seedOwnerWithConversation(): Promise<{
    email: string;
    conversationId: string;
  }> {
    const owner = await seedFundedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', { method: 'POST', body: { ownerEmail: owner.email } })
    );
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    return { email: owner.email, conversationId };
  }

  /** One text record's wire shape; the instant is a named test constant. */
  function record(
    modelId: string,
    providerName: string,
    costNanoUsd: string
  ): Record<string, unknown> {
    return {
      modelId,
      providerName,
      costNanoUsd,
      inputTokens: 120,
      outputTokens: 45,
      createdAt: isoAt(TEST_DAY_START),
    };
  }

  async function seededRows(
    conversationId: string
  ): Promise<{ modelId: string; providerName: string; costNanoUsd: bigint; createdAt: Date }[]> {
    return db
      .select({
        modelId: usageRecords.modelId,
        providerName: usageRecords.providerName,
        costNanoUsd: usageRecords.costNanoUsd,
        createdAt: usageRecords.createdAt,
      })
      .from(usageRecords)
      .where(eq(usageRecords.conversationId, conversationId));
  }

  async function seededTokens(
    conversationId: string
  ): Promise<{ inputTokens: number; outputTokens: number }[]> {
    return db
      .select({
        inputTokens: llmCompletions.inputTokens,
        outputTokens: llmCompletions.outputTokens,
      })
      .from(llmCompletions)
      .innerJoin(usageRecords, eq(usageRecords.id, llmCompletions.usageRecordId))
      .where(eq(usageRecords.conversationId, conversationId));
  }

  it('writes a backdated usage record with its token dimension', async () => {
    const owner = await seedOwnerWithConversation();
    const res = await request('/dev/usage-history', {
      method: 'POST',
      body: {
        ownerEmail: owner.email,
        conversationId: owner.conversationId,
        records: [record('vendor-a/model-one', 'Vendor A', '2000000')],
      },
    });
    expect(res.status).toBe(201);
    expect(await readJson<unknown>(res)).toEqual({
      usageRecordsCreated: 1,
      totalChargedNanoUsd: '2000000',
    });

    const rows = await seededRows(owner.conversationId);
    expect(rows).toEqual([
      {
        modelId: 'vendor-a/model-one',
        providerName: 'Vendor A',
        costNanoUsd: 2_000_000n,
        createdAt: new Date(TEST_DAY_START),
      },
    ]);
    expect(await seededTokens(owner.conversationId)).toEqual([
      { inputTokens: 120, outputTokens: 45 },
    ]);
  });

  it('keeps one model billed under two providers as two rows', async () => {
    const owner = await seedOwnerWithConversation();
    const res = await request('/dev/usage-history', {
      method: 'POST',
      body: {
        ownerEmail: owner.email,
        conversationId: owner.conversationId,
        records: [
          record('vendor-a/model-one', 'Vendor A', '2000000'),
          record('vendor-a/model-one', 'Vendor B', '3000000'),
        ],
      },
    });
    expect(res.status).toBe(201);

    const rows = await seededRows(owner.conversationId);
    expect(
      rows.map((row) => row.providerName).toSorted((left, right) => left.localeCompare(right))
    ).toEqual(['Vendor A', 'Vendor B']);
    expect(new Set(rows.map((row) => row.modelId))).toEqual(new Set(['vendor-a/model-one']));
  });

  it('mints fresh rows on a repeat so two callers cannot collide', async () => {
    const owner = await seedOwnerWithConversation();
    const body = {
      ownerEmail: owner.email,
      conversationId: owner.conversationId,
      records: [record('vendor-a/model-one', 'Vendor A', '2000000')],
    };
    const first = await request('/dev/usage-history', { method: 'POST', body });
    expect(first.status).toBe(201);
    const second = await request('/dev/usage-history', { method: 'POST', body });
    expect(second.status).toBe(201);
    expect(await seededRows(owner.conversationId)).toHaveLength(2);
  });

  it('rejects a decimal-dollar cost with 400', async () => {
    const owner = await seedOwnerWithConversation();
    const res = await request('/dev/usage-history', {
      method: 'POST',
      body: {
        ownerEmail: owner.email,
        conversationId: owner.conversationId,
        records: [record('vendor-a/model-one', 'Vendor A', '0.002')],
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-canonical integer cost with 400', async () => {
    const owner = await seedOwnerWithConversation();
    const res = await request('/dev/usage-history', {
      method: 'POST',
      body: {
        ownerEmail: owner.email,
        conversationId: owner.conversationId,
        records: [record('vendor-a/model-one', 'Vendor A', '012')],
      },
    });
    expect(res.status).toBe(400);
  });

  it('answers 404 for an unknown owner', async () => {
    const owner = await seedOwnerWithConversation();
    const res = await request('/dev/usage-history', {
      method: 'POST',
      body: {
        ownerEmail: `missing-${crypto.randomUUID().slice(0, 8)}@nope.test`,
        conversationId: owner.conversationId,
        records: [record('vendor-a/model-one', 'Vendor A', '2000000')],
      },
    });
    expect(res.status).toBe(404);
  });

  it('answers 404 when the owner has no purchased wallet', async () => {
    const owner = await seedUser();
    const seeded = await withSeededCatalog(() =>
      request('/dev/conversation', { method: 'POST', body: { ownerEmail: owner.email } })
    );
    const { conversationId } = await readJson<{ conversationId: string }>(seeded);
    const res = await request('/dev/usage-history', {
      method: 'POST',
      body: {
        ownerEmail: owner.email,
        conversationId,
        records: [record('vendor-a/model-one', 'Vendor A', '2000000')],
      },
    });
    expect(res.status).toBe(404);
  });

  it('is hidden in production like every other dev route', async () => {
    const owner = await seedOwnerWithConversation();
    const res = await request(
      '/dev/usage-history',
      {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          conversationId: owner.conversationId,
          records: [record('vendor-a/model-one', 'Vendor A', '2000000')],
        },
      },
      { ...testEnv, NODE_ENV: 'production' }
    );
    expect(res.status).toBe(404);
  });
});

describe('redis reset routes', () => {
  it('DELETE /dev/trial-usage clears trial:* keys', async () => {
    const key = `trial:usage:session:pd-${crypto.randomUUID()}`;
    await redis.set(key, 3, { ex: 300 });
    const res = await request('/dev/trial-usage', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await readJson<{ success: boolean; deleted: number }>(res);
    expect(body.success).toBe(true);
    expect(body.deleted).toBeGreaterThanOrEqual(1);
    expect(await redis.get(key)).toBeNull();
  });

  it('DELETE /dev/auth-rate-limits clears the named account’s lockouts and TOTP markers', async () => {
    const user = await seedUser();
    const lockout = `ratelimit:identity:login:lockout:${hmacRateLimitId(user.email)}`;
    const userLockout = `ratelimit:identity:totp:lockout:${hmacRateLimitId(user.id)}`;
    const marker = `totp:used:${user.id}:123456`;
    await redis.set(lockout, 1, { ex: 300 });
    await redis.set(userLockout, 1, { ex: 300 });
    await redis.set(marker, 1, { ex: 300 });
    const res = await request('/dev/auth-rate-limits', {
      method: 'DELETE',
      body: { identifiers: [user.email] },
    });
    expect(res.status).toBe(200);
    expect(await redis.get(lockout)).toBeNull();
    expect(await redis.get(userLockout)).toBeNull();
    expect(await redis.get(marker)).toBeNull();
  });

  it('DELETE /dev/auth-rate-limits leaves an account it was not asked about standing', async () => {
    // The property the endpoint exists to have. It is driven from Playwright
    // workers and from api integration tests against one shared Redis, so a
    // reset that reached past its subject deleted counters another caller was
    // mid-way through counting.
    const named = await seedUser();
    const other = await seedUser();
    const theirLockout = `ratelimit:identity:totp:lockout:${hmacRateLimitId(other.id)}`;
    const theirIdentifierLockout = `ratelimit:identity:recovery-getkey:lockout:${hmacRateLimitId(other.email)}`;
    const theirMarker = `totp:used:${other.id}:654321`;
    await redis.set(theirLockout, 1, { ex: 300 });
    await redis.set(theirIdentifierLockout, 1, { ex: 300 });
    await redis.set(theirMarker, 1, { ex: 300 });

    const res = await request('/dev/auth-rate-limits', {
      method: 'DELETE',
      body: { identifiers: [named.email] },
    });

    expect(res.status).toBe(200);
    expect(await redis.get(theirLockout)).toBe(1);
    expect(await redis.get(theirIdentifierLockout)).toBe(1);
    expect(await redis.get(theirMarker)).toBe(1);
    await redis.del(theirLockout, theirIdentifierLockout, theirMarker);
  });

  it('DELETE /dev/auth-rate-limits clears an identifier that names no account', async () => {
    // Registration and resend key on an email address, which exists before its
    // account does, so an unresolved identifier is a subject rather than a 404.
    const email = `pd-${crypto.randomUUID().slice(0, 8)}@unregistered.test`;
    const throttle = `ratelimit:identity:register:email:${hmacRateLimitId(email)}`;
    await redis.set(throttle, 1, { ex: 300 });
    const res = await request('/dev/auth-rate-limits', {
      method: 'DELETE',
      body: { identifiers: [email] },
    });
    expect(res.status).toBe(200);
    expect(await redis.get(throttle)).toBeNull();
  });

  it('DELETE /dev/auth-rate-limits names a username the way the limiters key it', async () => {
    // The limiters key on the canonical identifier, so a display-cased username
    // must reach the same key the login lockout wrote.
    const user = await seedUser();
    const [, username] = /^pd-(.+)@/.exec(user.email) ?? [];
    const lockout = `ratelimit:identity:login:lockout:${hmacRateLimitId('pd' + String(username))}`;
    await redis.set(lockout, 1, { ex: 300 });
    const res = await request('/dev/auth-rate-limits', {
      method: 'DELETE',
      body: { identifiers: [`PD${String(username).toUpperCase()}`] },
    });
    expect(res.status).toBe(200);
    expect(await redis.get(lockout)).toBeNull();
  });

  it('DELETE /dev/auth-rate-limits refuses a body that omits the identifiers list', async () => {
    // The account scope is stated, never inferred: `{ identifiers: [] }` asks
    // for the caller's per-IP windows alone and is legal, and omitting the field
    // is refused. An `.optional()` or `.default([])` there would turn a caller
    // that forgot the list into a silently narrower reset instead of a 400, and
    // every other case in this file would stay green.
    const res = await request('/dev/auth-rate-limits', { method: 'DELETE', body: {} });
    expect(res.status).toBe(400);
    expect(await readJson<{ code: string }>(res)).toEqual({ code: 'VALIDATION' });
  });

  it('DELETE /dev/usage-rate-limits clears stream limits but preserves admission state', async () => {
    const streamUser = `pd-${crypto.randomUUID()}`;
    const streamKey = `ratelimit:chat:stream:user:${hmacRateLimitId(streamUser)}`;
    const admissionKey = `billing:admission:wallet:pd-${crypto.randomUUID()}`;
    await redis.set(streamKey, 1, { ex: 300 });
    await redis.set(admissionKey, 1, { ex: 300 });
    const res = await request('/dev/usage-rate-limits', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await redis.get(streamKey)).toBeNull();
    // Per-test cleanup must NOT touch admission state: it is global across all
    // wallets, and wiping it under parallel workers races another worker's live
    // hold/snapshot into a false INSUFFICIENT_ADMISSION refusal. Admission state
    // starts an E2E run clean through the bring-up's flush of that stack's Redis
    // database locally, and a CI runner's empty Redis in CI.
    expect(await redis.get(admissionKey)).toBe(1);
  });

  it('DELETE /dev/usage-rate-limits clears the caller’s guest window, not another address’s', async () => {
    // End to end through the real hash: two addresses, one reset. The window
    // that must survive is the one this caller never presented — that is what
    // lets each Playwright project (and each worker's guest identity) clear its
    // own windows without touching a concurrently-running one's.
    const mineIp = uniqueIp();
    const theirsIp = uniqueIp();
    const mine = rateLimitKey(
      guestConversationIpRateLimit,
      await callerIpIdForAddress(mineIp)
    )._unsafeUnwrap();
    const theirs = rateLimitKey(
      guestConversationIpRateLimit,
      await callerIpIdForAddress(theirsIp)
    )._unsafeUnwrap();
    await redis.set(mine, 1, { ex: 300 });
    await redis.set(theirs, 1, { ex: 300 });

    const res = await app.request(
      '/dev/usage-rate-limits',
      { method: 'DELETE', headers: { 'cf-connecting-ip': mineIp } },
      testEnv
    );

    expect(res.status).toBe(200);
    expect(await redis.get(mine)).toBeNull();
    expect(await redis.get(theirs)).toBe(1);
    await redis.del(theirs);
  });

  it('answers DELETE /dev/admission-state with 404, as no route serves it', async () => {
    const res = await request('/dev/admission-state', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('DELETE /dev/admin-dashboard-reads clears the dashboard window for every actor', async () => {
    // The admin read caps key on a hashed Access actor, so no caller can scope
    // this the way the per-IP resets scope theirs — it clears every actor's
    // dashboard window or none. That is why it never runs between tests (see
    // `resetUsageRateLimits` for what a per-test global wipe costs under
    // parallel workers).
    const mine = rateLimitKey(adminDashboardRateLimit, `pd-${crypto.randomUUID()}`)._unsafeUnwrap();
    const theirs = rateLimitKey(
      adminDashboardRateLimit,
      `pd-${crypto.randomUUID()}`
    )._unsafeUnwrap();
    const sqlPanel = rateLimitKey(
      adminSqlPanelRateLimit,
      `pd-${crypto.randomUUID()}`
    )._unsafeUnwrap();
    await redis.set(mine, 1, { ex: 300 });
    await redis.set(theirs, 1, { ex: 300 });
    await redis.set(sqlPanel, 1, { ex: 300 });

    const res = await request('/dev/admin-dashboard-reads', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await redis.get(mine)).toBeNull();
    expect(await redis.get(theirs)).toBeNull();
    // Scope pinned: a sibling admin cap must survive. `resetAdminDashboardReads`
    // in `apps/api/src/dev/redis-resets.ts` states why the dashboard window has
    // a reset.
    expect(await redis.get(sqlPanel)).toBe(1);
    await redis.del(sqlPanel);
  });

  it('DELETE /dev/admin-job-queue-reads clears the job-queue window for every actor', async () => {
    const mine = rateLimitKey(adminJobQueueRateLimit, `pd-${crypto.randomUUID()}`)._unsafeUnwrap();
    const theirs = rateLimitKey(
      adminJobQueueRateLimit,
      `pd-${crypto.randomUUID()}`
    )._unsafeUnwrap();
    const dashboard = rateLimitKey(
      adminDashboardRateLimit,
      `pd-${crypto.randomUUID()}`
    )._unsafeUnwrap();
    await redis.set(mine, 1, { ex: 300 });
    await redis.set(theirs, 1, { ex: 300 });
    await redis.set(dashboard, 1, { ex: 300 });

    const res = await request('/dev/admin-job-queue-reads', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await redis.get(mine)).toBeNull();
    expect(await redis.get(theirs)).toBeNull();
    // Scope pinned: a sibling admin cap must survive. Each admin window that
    // has a reset has its OWN glob, so one reset cannot answer another's
    // obligation to the counter cross-check — the dashboard's is the sibling
    // this one must leave standing.
    expect(await redis.get(dashboard)).toBe(1);
    await redis.del(dashboard);
  });

  it('DELETE /dev/totp-replay clears only the named user’s markers', async () => {
    const user = await seedUser();
    const other = await seedUser();
    const mine = `totp:used:${user.id}:111111`;
    const theirs = `totp:used:${other.id}:222222`;
    await redis.set(mine, 1, { ex: 300 });
    await redis.set(theirs, 1, { ex: 300 });

    const res = await request('/dev/totp-replay', {
      method: 'DELETE',
      body: { email: user.email },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: 1 });
    expect(await redis.get(mine)).toBeNull();
    expect(await redis.get(theirs)).not.toBeNull();
    await redis.del(theirs);
  });

  it('DELETE /dev/totp-replay answers 404 for an unknown email', async () => {
    const res = await request('/dev/totp-replay', {
      method: 'DELETE',
      body: { email: `missing-${crypto.randomUUID().slice(0, 8)}@nope.test` },
    });
    expect(res.status).toBe(404);
  });
});

describe('redis reset routes fail closed when Redis is down', () => {
  const badRedisEnv = { ...testEnv, UPSTASH_REDIS_REST_TOKEN: 'wrong-srh-token' };

  it.each([
    '/dev/trial-usage',
    '/dev/usage-rate-limits',
    '/dev/admin-dashboard-reads',
    '/dev/admin-job-queue-reads',
    '/dev/admin-ops-runs',
  ])('DELETE %s answers 503 UNAVAILABLE', async (path) => {
    const res = await request(path, { method: 'DELETE' }, badRedisEnv);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('DELETE /dev/auth-rate-limits answers 503 UNAVAILABLE', async () => {
    // Its own case rather than a row above: the route takes a body now, and the
    // rows there send none.
    const res = await request(
      '/dev/auth-rate-limits',
      { method: 'DELETE', body: { identifiers: [] } },
      badRedisEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('DELETE /dev/totp-replay answers 503 UNAVAILABLE for a known user', async () => {
    const user = await seedUser();
    const res = await request(
      '/dev/totp-replay',
      { method: 'DELETE', body: { email: user.email } },
      badRedisEnv
    );
    expect(res.status).toBe(503);
  });
});

describe('POST /dev/set-version', () => {
  it('sets the module override the version-check middleware reads', async () => {
    const res = await request('/dev/set-version', {
      method: 'POST',
      body: { version: '7.7.7' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, version: '7.7.7' });
    expect(getVersionOverride()).toBe('7.7.7');
  });

  it('rejects an empty version with 400', async () => {
    const res = await request('/dev/set-version', { method: 'POST', body: { version: '' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /dev/set-checksum', () => {
  it('sets the bundle-checksum override the updates route reads', async () => {
    const checksum = 'd'.repeat(64);
    const res = await request('/dev/set-checksum', {
      method: 'POST',
      body: { platform: 'android-direct', checksum },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, platform: 'android-direct', checksum });
  });

  it('rejects a platform that never takes an OTA bundle with 400', async () => {
    const res = await request('/dev/set-checksum', {
      method: 'POST',
      body: { platform: 'web', checksum: 'd'.repeat(64) },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty checksum with 400', async () => {
    const res = await request('/dev/set-checksum', {
      method: 'POST',
      body: { platform: 'ios', checksum: '' },
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /dev/verify-token/:email', () => {
  it('returns the latest live verification token for the email', async () => {
    const user = await seedUser();
    const token = `tok-${crypto.randomUUID()}`;
    await db.insert(verificationTokens).values({
      userId: user.id,
      token,
      purpose: 'email_verification',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await request(`/dev/verify-token/${encodeURIComponent(user.email)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token });
  });

  it('answers 404 when no live token exists', async () => {
    const user = await seedUser();
    const res = await request(`/dev/verify-token/${encodeURIComponent(user.email)}`);
    expect(res.status).toBe(404);
  });
});

describe('conversation observation routes', () => {
  async function seedSettledCharge(): Promise<{
    conversationId: string;
    payerId: string;
    aiMessageId: string;
  }> {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          messages: [
            { content: 'q', senderType: 'user' },
            { content: 'a', senderType: 'ai' },
          ],
        },
      })
    );
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    const aiMessage = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'assistant'))
      );
    const aiMessageId = aiMessage[0]?.id ?? '';
    const [item] = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(eq(contentItems.messageId, aiMessageId));

    const usage = await db
      .insert(usageRecords)
      .values({
        payerUserId: owner.id,
        contentItemId: item?.id ?? null,
        runId: crypto.randomUUID(),
        conversationId,
        modelId: 'platform-dev/model',
        providerName: 'dev',
        modality: 'text',
        costNanoUsd: 7_000_000n,
        idempotencyKey: `platform-dev:${crypto.randomUUID()}`,
      })
      .returning({ id: usageRecords.id });
    await db.insert(llmCompletions).values({
      usageRecordId: usage[0]?.id ?? '',
      inputTokens: 10,
      outputTokens: 20,
    });
    return { conversationId, payerId: owner.id, aiMessageId };
  }

  it('GET /dev/llm-completions-count counts the conversation’s completions', async () => {
    const seeded = await seedSettledCharge();
    const res = await request(`/dev/llm-completions-count/${seeded.conversationId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });
  });

  it('GET /dev/message-payers resolves each assistant message’s payer', async () => {
    const seeded = await seedSettledCharge();
    const res = await request(`/dev/message-payers/${seeded.conversationId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      payers: [
        {
          messageId: seeded.aiMessageId,
          payerId: seeded.payerId,
          senderUserId: null,
          senderLinkId: null,
        },
      ],
    });
  });

  it('GET /dev/message-payers reports the sender beside the payer', async () => {
    const seeded = await seedSettledCharge();
    const sender = await seedUser();
    await db
      .update(usageRecords)
      .set({ senderUserId: sender.id })
      .where(eq(usageRecords.conversationId, seeded.conversationId));
    const res = await request(`/dev/message-payers/${seeded.conversationId}`);
    const body = await readJson<{ payers: { senderUserId: string | null }[] }>(res);
    expect(body.payers[0]?.senderUserId).toBe(sender.id);
  });

  it('GET /dev/message-payers reports null for an uncharged assistant message', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          messages: [
            { content: 'q', senderType: 'user' },
            { content: 'a', senderType: 'ai' },
          ],
        },
      })
    );
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    const payers = await request(`/dev/message-payers/${conversationId}`);
    const body = await readJson<{ payers: { payerId: string | null }[] }>(payers);
    expect(body.payers).toHaveLength(1);
    expect(body.payers[0]?.payerId).toBeNull();
  });

  it('GET /dev/message-payers keeps the first charge when a message carries several', async () => {
    const seeded = await seedSettledCharge();
    // A second charge anchored to the same content item (an agentic step).
    const [item] = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(eq(contentItems.messageId, seeded.aiMessageId));
    await db.insert(usageRecords).values({
      payerUserId: seeded.payerId,
      contentItemId: item?.id ?? null,
      runId: crypto.randomUUID(),
      conversationId: seeded.conversationId,
      modelId: 'platform-dev/model',
      providerName: 'dev',
      modality: 'text',
      costNanoUsd: 1_000_000n,
      idempotencyKey: `platform-dev:${crypto.randomUUID()}`,
    });
    const res = await request(`/dev/message-payers/${seeded.conversationId}`);
    expect(await res.json()).toEqual({
      payers: [
        {
          messageId: seeded.aiMessageId,
          payerId: seeded.payerId,
          senderUserId: null,
          senderLinkId: null,
        },
      ],
    });
  });

  it('GET /dev/mock-charge-basis serves the mock’s declared charge basis', async () => {
    const res = await request('/dev/mock-charge-basis');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      generationChargeNanoUsd: '1150',
      echoPrefix: 'Echo:\n',
      echoSuffix: '\n\n```json\n{\n  "ok": true\n}\n```',
    });
  });

  it('GET /dev/conversation-cost sums surviving charges as a decimal string', async () => {
    const seeded = await seedSettledCharge();
    const res = await request(`/dev/conversation-cost/${seeded.conversationId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cost: '0.007000000' });
  });

  it('rejects a non-uuid conversation id with 400', async () => {
    const res = await request('/dev/conversation-cost/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('POST /dev/revoke-message-share', () => {
  it('deletes the shared message row', async () => {
    const owner = await seedUser();
    const res = await withSeededCatalog(() =>
      request('/dev/conversation', {
        method: 'POST',
        body: {
          ownerEmail: owner.email,
          messages: [{ content: 'shared', senderType: 'user' }],
        },
      })
    );
    const { conversationId } = await readJson<{ conversationId: string }>(res);
    const [message] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const shareRows = await db
      .insert(sharedMessages)
      .values({
        messageId: message?.id ?? '',
        createdBy: owner.id,
        wrappedContentKey: new Uint8Array([1, 2, 3]),
      })
      .returning({ id: sharedMessages.id });
    const shareId = shareRows[0]?.id ?? '';

    const revoke = await request('/dev/revoke-message-share', {
      method: 'POST',
      body: { shareId },
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ success: true, rowsAffected: 1 });
    const remaining = await db.select().from(sharedMessages).where(eq(sharedMessages.id, shareId));
    expect(remaining).toHaveLength(0);
  });

  it('reports zero rows for an unknown share id', async () => {
    const res = await request('/dev/revoke-message-share', {
      method: 'POST',
      body: { shareId: crypto.randomUUID() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, rowsAffected: 0 });
  });
});

describe('GET /dev/emails', () => {
  interface EmailTemplatePreview {
    name: string;
    label: string;
    html: string;
  }

  it('404s in production (dev-only route class)', async () => {
    const productionEnv = { ...testEnv, NODE_ENV: 'production' };
    const res = await request('/dev/emails', {}, productionEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('returns every email template rendered to HTML', async () => {
    const res = await request('/dev/emails');
    expect(res.status).toBe(200);
    const { templates } = await readJson<{ templates: EmailTemplatePreview[] }>(res);
    const names = templates.map((t) => t.name);
    expect(names).toEqual([
      'verification',
      'password-changed',
      'password-reset',
      'two-factor-enabled',
      'two-factor-disabled',
      'account-locked',
      'two-factor-locked',
      'welcome',
      'account-deleted',
      'chargeback-lock',
      'admin-op-notification',
      'admin-daily-digest',
      'newsletter-confirmation',
      'newsletter-issue',
    ]);
    for (const template of templates) {
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.html).toContain('<');
      expect(template.html.length).toBeGreaterThan(0);
    }
  });

  it('covers every email template exported from the notifications barrel', async () => {
    // Barrel exports ending in `Email` that are not renderable templates.
    const nonTemplateExports = new Set(['findCapturedEmail', 'defineEmail', 'renderEmail']);
    const toGalleryName = (exportName: string): string =>
      exportName.slice(0, -'Email'.length).replaceAll(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
    const barrelExports = Object.keys(notificationsBarrel);
    const expectedNames = barrelExports
      .filter((name) => name.endsWith('Email') && !nonTemplateExports.has(name))
      .map((name) => toGalleryName(name));
    expect(expectedNames.length).toBeGreaterThan(0);
    const res = await request('/dev/emails');
    const { templates } = await readJson<{ templates: EmailTemplatePreview[] }>(res);
    const galleryNames = templates.map((t) => t.name);
    for (const expected of expectedNames) {
      expect(galleryNames).toContain(expected);
    }
    // A stale or template-naming exclusion would silently exempt a template.
    for (const excluded of nonTemplateExports) {
      expect(barrelExports).toContain(excluded);
      expect(galleryNames).not.toContain(toGalleryName(excluded));
    }
  });
});

describe('POST /dev/admin-targets', () => {
  interface MintedResponse {
    lockedUser?: { userId: string; email: string };
    deadJob?: { jobId: string };
    discardedJob?: { jobId: string };
    revokedShare?: { linkId: string; conversationId: string };
  }

  const targetUserIds: string[] = [];
  const targetJobIds: string[] = [];

  afterAll(async () => {
    if (targetJobIds.length > 0) {
      await db.delete(jobs).where(inArray(jobs.id, targetJobIds));
    }
    if (targetUserIds.length > 0) {
      // Both welcome-credit legs together (zero-sum ledger trigger), wallets,
      // then conversations (cascades the shares) before the users.
      const welcomeKeys = targetUserIds.flatMap((id) => [
        `welcome:${id}:user`,
        `welcome:${id}:house`,
      ]);
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.idempotencyKey, welcomeKeys));
      await db.delete(wallets).where(inArray(wallets.userId, targetUserIds));
      await db.delete(conversations).where(inArray(conversations.userId, targetUserIds));
      await db.delete(users).where(inArray(users.id, targetUserIds));
    }
  });

  async function trackMinted(minted: MintedResponse): Promise<void> {
    if (minted.lockedUser !== undefined) targetUserIds.push(minted.lockedUser.userId);
    if (minted.deadJob !== undefined) targetJobIds.push(minted.deadJob.jobId);
    if (minted.discardedJob !== undefined) targetJobIds.push(minted.discardedJob.jobId);
    if (minted.revokedShare !== undefined) {
      const [row] = await db
        .select({ userId: conversations.userId })
        .from(conversations)
        .where(eq(conversations.id, minted.revokedShare.conversationId));
      if (row?.userId != null) targetUserIds.push(row.userId);
    }
  }

  function requireTarget<T>(target: T | undefined, kind: string): T {
    if (target === undefined) throw new Error(`${kind} missing from response`);
    return target;
  }

  async function assertLockedUserRow(target: { userId: string; email: string }): Promise<void> {
    const [row] = await db.select().from(users).where(eq(users.id, target.userId));
    expect(row?.lockedAt).not.toBeNull();
    expect(row?.lockReason).toBe('chargeback');
    expect(row?.email).toBe(target.email);
  }

  async function assertJobRow(jobId: string, discarded: boolean): Promise<void> {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row?.status).toBe('dead');
    if (discarded) {
      expect(row?.discardedAt).not.toBeNull();
    } else {
      expect(row?.discardedAt).toBeNull();
    }
  }

  async function assertShareRow(target: { linkId: string; conversationId: string }): Promise<void> {
    const [row] = await db.select().from(sharedLinks).where(eq(sharedLinks.id, target.linkId));
    expect(row?.conversationId).toBe(target.conversationId);
    expect(row?.revokedAt).not.toBeNull();
  }

  it('mints every requested target kind in its admin-op state', async () => {
    const res = await request('/dev/admin-targets', {
      method: 'POST',
      body: { kinds: ['lockedUser', 'deadJob', 'discardedJob', 'revokedShare'] },
    });
    expect(res.status).toBe(201);
    const minted = await readJson<MintedResponse>(res);
    await trackMinted(minted);

    await assertLockedUserRow(requireTarget(minted.lockedUser, 'lockedUser'));
    await assertJobRow(requireTarget(minted.deadJob, 'deadJob').jobId, false);
    await assertJobRow(requireTarget(minted.discardedJob, 'discardedJob').jobId, true);
    await assertShareRow(requireTarget(minted.revokedShare, 'revokedShare'));
  });

  it('mints only the requested kinds with distinct ids per call', async () => {
    const first = await request('/dev/admin-targets', {
      method: 'POST',
      body: { kinds: ['deadJob'] },
    });
    const second = await request('/dev/admin-targets', {
      method: 'POST',
      body: { kinds: ['deadJob'] },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstMinted = await readJson<MintedResponse>(first);
    const secondMinted = await readJson<MintedResponse>(second);
    await trackMinted(firstMinted);
    await trackMinted(secondMinted);

    expect(firstMinted.lockedUser).toBeUndefined();
    expect(firstMinted.discardedJob).toBeUndefined();
    expect(firstMinted.revokedShare).toBeUndefined();
    expect(firstMinted.deadJob?.jobId).toBeDefined();
    expect(firstMinted.deadJob?.jobId).not.toBe(secondMinted.deadJob?.jobId);
  });

  it('rejects an unknown kind and an empty kinds list', async () => {
    const unknown = await request('/dev/admin-targets', {
      method: 'POST',
      body: { kinds: ['nope'] },
    });
    expect(unknown.status).toBe(400);
    expect(await readJson<{ code: string }>(unknown)).toEqual({ code: 'VALIDATION' });

    const empty = await request('/dev/admin-targets', {
      method: 'POST',
      body: { kinds: [] },
    });
    expect(empty.status).toBe(400);
  });

  it('404s in production (dev-only route class)', async () => {
    const res = await request(
      '/dev/admin-targets',
      { method: 'POST', body: { kinds: ['deadJob'] } },
      { ...testEnv, NODE_ENV: 'production' }
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /dev/feedback/by-email/:email', () => {
  it("returns the user's submitted feedback rows", async () => {
    const user = await seedUser();
    await db.insert(feedback).values({ userId: user.id, kind: 'bug', body: 'dev read-back' });
    const res = await request(`/dev/feedback/by-email/${encodeURIComponent(user.email)}`);
    expect(res.status).toBe(200);
    const { rows } = await readJson<{ rows: { body: string; kind: string; userId: string }[] }>(
      res
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('dev read-back');
    expect(rows[0]?.kind).toBe('bug');
    expect(rows[0]?.userId).toBe(user.id);
  });

  it('404s for an unknown email', async () => {
    const res = await request('/dev/feedback/by-email/nobody@platform-dev.test');
    expect(res.status).toBe(404);
    expect(await readJson<{ code: string }>(res)).toEqual({ code: 'NOT_FOUND' });
  });

  it('404s in production (dev-only route class)', async () => {
    const user = await seedUser();
    const res = await request(
      `/dev/feedback/by-email/${encodeURIComponent(user.email)}`,
      {},
      {
        ...testEnv,
        NODE_ENV: 'production',
      }
    );
    expect(res.status).toBe(404);
  });
});

/**
 * The hour this file's rollup case reduces: a fixture instant rather than the
 * real one, so nothing it writes lands on a real day and no other file's
 * writes reach it. The reference year rather than the reference day because
 * the growth rollup's own suite spreads its scenes forward from the reference
 * day and this hour sits behind all of them.
 */
const ROLLUP_FIXTURE_AT = TEST_YEAR_START + 3 * HOUR_MS;
const ROLLUP_FIXTURE_HOUR = growthHourBucket(new Date(ROLLUP_FIXTURE_AT));

describe('POST /dev/growth-rollup', () => {
  it('rolls the current hour when the body names none', async () => {
    // The route reads its own clock twice — for the hour it defaults to and for
    // the instant it judges that hour's age against — so the clock is pinned to
    // a fixture instant. Against the real clock the default is either side of
    // an hour boundary, and the hour it reduces is the live one of a counting
    // store every file in this suite shares, which makes the outcome another
    // file's side effect. Pinned, the hour is one value and its only content is
    // what this case put there.
    const started = await countRegistrationStarted(redis, {
      secret: 'a-growth-hash-secret-of-at-least-32-chars',
      address: uniqueIp(),
      at: new Date(ROLLUP_FIXTURE_AT),
      campaign: GROWTH_DIRECT_CAMPAIGN,
      decoy: false,
    });
    expect(started.isOk()).toBe(true);

    freezeClock(ROLLUP_FIXTURE_AT, { toFake: ['Date'] });
    try {
      const res = await request('/dev/growth-rollup', { method: 'POST', body: {} });

      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({
        hour: ROLLUP_FIXTURE_HOUR,
        outcome: {
          kind: 'rolled',
          rows: {
            visitors: 0,
            paths: 0,
            referrers: 0,
            campaignPaths: 0,
            geo: 0,
            events: 0,
            productEntry: 0,
            reach: 0,
            funnel: 1,
          },
          clamped: [],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an hour no clock can produce', async () => {
    const res = await request('/dev/growth-rollup', {
      method: 'POST',
      body: { hour: '2026-02-30T09' },
    });

    expect(res.status).toBe(400);
    expect(await readJson<{ code: string }>(res)).toEqual({ code: 'VALIDATION' });
  });

  it('404s in production (dev-only route class)', async () => {
    const res = await request(
      '/dev/growth-rollup',
      { method: 'POST', body: {} },
      { ...testEnv, NODE_ENV: 'production' }
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /dev/acquisition-source/:email', () => {
  it("returns the account's stored source row", async () => {
    const user = await seedUser();
    await db.insert(userAcquisition).values({
      userId: user.id,
      campaign: 'direct',
      platform: 'web',
      selfReportedChannel: 'podcast',
      selfReportedContext: 'first_payment',
      selfReportedAt: new Date(TEST_DAY_START),
      selfReportSkipped: 'post_signup',
    });

    const res = await request(`/dev/acquisition-source/${encodeURIComponent(user.email)}`);

    expect(res.status).toBe(200);
    expect(await readJson<unknown>(res)).toEqual({
      campaign: 'direct',
      platform: 'web',
      selfReportedChannel: 'podcast',
      selfReportedContext: 'first_payment',
      selfReportSkipped: 'post_signup',
    });
  });

  it('404s for an account that carries no source row', async () => {
    const user = await seedUser();
    const res = await request(`/dev/acquisition-source/${encodeURIComponent(user.email)}`);
    expect(res.status).toBe(404);
    expect(await readJson<{ code: string }>(res)).toEqual({ code: 'NOT_FOUND' });
  });

  it('404s for an unknown email', async () => {
    const res = await request('/dev/acquisition-source/nobody@platform-dev.test');
    expect(res.status).toBe(404);
    expect(await readJson<{ code: string }>(res)).toEqual({ code: 'NOT_FOUND' });
  });

  it('404s in production (dev-only route class)', async () => {
    const user = await seedUser();
    const res = await request(
      `/dev/acquisition-source/${encodeURIComponent(user.email)}`,
      {},
      { ...testEnv, NODE_ENV: 'production' }
    );
    expect(res.status).toBe(404);
  });
});

describe('newsletter dev routes', () => {
  const createdNewsletterEmails: string[] = [];

  afterAll(async () => {
    if (createdNewsletterEmails.length > 0) {
      await db
        .delete(newsletterSubscribers)
        .where(inArray(newsletterSubscribers.email, createdNewsletterEmails));
    }
  });

  async function mintSubscribers(body: {
    count: number;
    status?: string;
    emailPrefix?: string;
  }): Promise<{ subscribers: { id: string; email: string; unsubscribeToken: string }[] }> {
    const res = await request('/dev/newsletter/subscribers', { method: 'POST', body });
    expect(res.status).toBe(200);
    const parsed = await readJson<{
      subscribers: { id: string; email: string; unsubscribeToken: string }[];
    }>(res);
    createdNewsletterEmails.push(...parsed.subscribers.map((subscriber) => subscriber.email));
    return parsed;
  }

  describe('POST /dev/newsletter/subscribers', () => {
    it('mints confirmed subscribed rows with unique emails and tokens', async () => {
      const { subscribers } = await mintSubscribers({ count: 3 });

      expect(subscribers).toHaveLength(3);
      expect(new Set(subscribers.map((subscriber) => subscriber.email)).size).toBe(3);
      const rows = await db
        .select({
          status: newsletterSubscribers.status,
          confirmedAt: newsletterSubscribers.confirmedAt,
        })
        .from(newsletterSubscribers)
        .where(
          inArray(
            newsletterSubscribers.email,
            subscribers.map((subscriber) => subscriber.email)
          )
        );
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.status === 'subscribed' && row.confirmedAt !== null)).toBe(
        true
      );
    });

    it('honors a status override and an email prefix', async () => {
      const { subscribers } = await mintSubscribers({
        count: 1,
        status: 'unsubscribed',
        emailPrefix: 'goodbye',
      });

      expect(subscribers[0]?.email.startsWith('goodbye')).toBe(true);
      const rows = await db
        .select({ status: newsletterSubscribers.status })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.email, subscribers[0]?.email ?? ''));
      expect(rows[0]?.status).toBe('unsubscribed');
    });

    it('mints pending rows with a live confirm token', async () => {
      const res = await request('/dev/newsletter/subscribers', {
        method: 'POST',
        body: { count: 1, status: 'pending' },
      });
      expect(res.status).toBe(200);
      const { subscribers } = await readJson<{
        subscribers: { email: string; confirmToken: string | null }[];
      }>(res);
      createdNewsletterEmails.push(...subscribers.map((subscriber) => subscriber.email));
      expect(subscribers[0]?.confirmToken).not.toBeNull();
    });

    it('mints suppressed rows with a bounce reason', async () => {
      const { subscribers } = await mintSubscribers({ count: 1, status: 'suppressed' });
      const rows = await db
        .select({ suppressReason: newsletterSubscribers.suppressReason })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.email, subscribers[0]?.email ?? ''));
      expect(rows[0]?.suppressReason).toBe('bounce');
    });

    it('rejects an invalid count', async () => {
      const res = await request('/dev/newsletter/subscribers', {
        method: 'POST',
        body: { count: 0 },
      });
      expect(res.status).toBe(400);
    });

    it('404s in production (dev-only route class)', async () => {
      const res = await request(
        '/dev/newsletter/subscribers',
        { method: 'POST', body: { count: 1 } },
        { ...testEnv, NODE_ENV: 'production' }
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /dev/newsletter/tokens/:email', () => {
    it('reads live tokens and status straight from the row', async () => {
      const { subscribers } = await mintSubscribers({ count: 1 });
      const email = subscribers[0]?.email ?? '';

      const res = await request(`/dev/newsletter/tokens/${encodeURIComponent(email)}`);

      expect(res.status).toBe(200);
      const body = await readJson<{
        confirmToken: string | null;
        unsubscribeToken: string;
        status: string;
      }>(res);
      expect(body.status).toBe('subscribed');
      expect(body.unsubscribeToken).toBe(subscribers[0]?.unsubscribeToken);
    });

    it('404s for an unknown email', async () => {
      const res = await request('/dev/newsletter/tokens/nobody@platform-dev.test');
      expect(res.status).toBe(404);
    });

    it('404s in production (dev-only route class)', async () => {
      const res = await request(
        '/dev/newsletter/tokens/nobody@platform-dev.test',
        {},
        {
          ...testEnv,
          NODE_ENV: 'production',
        }
      );
      expect(res.status).toBe(404);
    });
  });
});

describe('dev mailbox routes', () => {
  it('lists captured mock emails and serves one as raw HTML', async () => {
    const subject = `Mailbox probe ${crypto.randomUUID().slice(0, 8)}`;
    const sender = createEmailSenderFromEnv({ NODE_ENV: 'development' });
    const sent = await sender.send({
      to: 'mailbox@platform-dev.test',
      subject,
      html: '<p>mailbox probe body</p>',
    });
    expect(sent.isOk()).toBe(true);

    const listRes = await request('/dev/mailbox');
    expect(listRes.status).toBe(200);
    const { emails } = await readJson<{ emails: { id: string; to: string; subject: string }[] }>(
      listRes
    );
    const captured = emails.find((email) => email.subject === subject);
    expect(captured?.to).toBe('mailbox@platform-dev.test');

    const htmlRes = await request(`/dev/mailbox/${captured?.id ?? ''}`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    expect(await htmlRes.text()).toBe('<p>mailbox probe body</p>');
  });

  it('404s for an unknown mailbox id', async () => {
    const res = await request('/dev/mailbox/no-such-id');
    expect(res.status).toBe(404);
  });

  it('404s in production (dev-only route class)', async () => {
    const res = await request('/dev/mailbox', {}, { ...testEnv, NODE_ENV: 'production' });
    expect(res.status).toBe(404);
  });
});
