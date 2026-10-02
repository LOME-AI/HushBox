import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, eq, inArray } from 'drizzle-orm';
import { MAX_MEDIA_OBJECT_BYTES, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { generateEpochKeyPair } from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  llmCompletions,
  modelCatalog,
  sharedMessages,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { createConversationsStores } from '../../../conversations/index.js';
import { getMessageHistory, readSharedMessage } from '../../../conversations/domain/index.js';
import { createR2Storage } from '../../../media/index.js';
import { createChatStores } from '../../adapters/stores.js';
import { CHAT_TURN_INPUT } from '../constants.js';
import { createConversationRuntime } from '../runtime.js';
import { buildTurnDefinition } from '../turn/definition.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { ReasoningEffortSelection, RunContext, RunIdentity } from '@hushbox/shared';
import type { Storage } from '../../../media/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

/**
 * A reply's reasoning time, end to end: a real turn on the dev mock provider,
 * whose reasoning deltas arrive at a typewriter cadence, settled by the real
 * fenced settlement, then read back through the member history read and the
 * public share read.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for reasoning-time integration tests'
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the runtime-driven reasoning-time cases`);
  }
  return value;
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([9, 9, 9]);
const PROMPT = 'escape:tell me about tides';
const MODEL = `chat-reasoning-time/${crypto.randomUUID().slice(0, 8)}`;
const WALLET_BALANCE = 1_000_000_000_000n;
/** The mock provider's wait between deltas: the reasoning time the run can observe. */
const TEXT_DELAY_MS = 20;
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

const storage: Storage = createR2Storage({
  endpoint: requireEnv('R2_S3_ENDPOINT'),
  bucket: requireEnv('R2_BUCKET_MEDIA'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
  defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  db,
  isCI: false,
});

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

function silentTelemetry(): Telemetry {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), captureError: vi.fn() };
}

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

beforeAll(async () => {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '3',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: {
          kind: 'tokens',
          anchor: { base: { input: '2500', output: '10000' }, tiers: [] },
        },
        zdrReachable: true,
        releasedAt: secondsAt(TEST_DAY_START),
        fetchedAt: 0,
        reasoning: { supportedEfforts: null },
      },
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(eq(modelCatalog.modelId, MODEL));
  await db.$client.end();
});

interface Fixture {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
}

/** A funded owner of a conversation at epoch 1, holding a key in its wrap set. */
async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@chat-reasoning-time.test`,
        username: `rt${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = first(userRows, 'user').id;
  createdUserIds.push(userId);
  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: WALLET_BALANCE })
    .returning({ id: wallets.id });
  const { conversationId, epochId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: generateEpochKeyPair().publicKey,
  });
  createdConversationIds.push(conversationId);
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey: BYTES, wrap: BYTES, visibleFromEpoch: 1 });
  await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1, privilege: 'owner' });
  return { userId, walletId: first(walletRows, 'wallet').id, conversationId };
}

interface SettledRun {
  readonly runId: string;
  readonly assistantMessageId: string;
}

/** Drives one turn through the real runtime to its settlement. */
async function settleTurn(
  fixture: Fixture,
  reasoningEffort?: ReasoningEffortSelection
): Promise<SettledRun> {
  const built = await buildTurnDefinition({ db, telemetry: silentTelemetry() }, MODEL, {
    budget: {
      promptCharacterCount: PROMPT.length,
      inputCharacterCount: PROMPT.length,
      funding: { kind: 'purchased', spendableNanoUsd: WALLET_BALANCE },
    },
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
  const definition = built._unsafeUnwrap();
  const rt = createConversationRuntime({
    db,
    redis,
    telemetry: silentTelemetry(),
    apiKey: 'mock-key',
    searchApiKey: 'mock-key',
    isCI: false,
    mockProviderEnabled: true,
    chatStores: createChatStores(),
    storage,
    readEpochPublicKey,
  });
  const runKey = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const identity: RunIdentity = {
    mode: 'paid',
    payerUserId: fixture.userId,
    sender: { kind: 'user', userId: fixture.userId },
    conversationId: fixture.conversationId,
    walletId: fixture.walletId,
    epochNumber: 1,
    userMessage: { id: crypto.randomUUID(), content: PROMPT },
  };
  const claim = await rt.claimRun({ runKey, runId, bodyHash: 'reasoning-time', identity });
  if (claim.outcome !== 'executor') {
    throw new Error(`expected a fresh executor claim, got ${claim.outcome}`);
  }
  const mockDirectives = { textDelayMs: TEXT_DELAY_MS };
  const context: RunContext = { ...identity, runId, fence: claim.fence, mockDirectives };
  const hooks = rt.bindHooks(context, definition);
  const handle = rt.executor.start({
    definition,
    inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: PROMPT } },
    hooks,
    runKey,
    runId,
    mockDirectives,
    emit: () => undefined,
  });
  const outcome = await handle.done;
  const admission = await handle.admitted;
  if (admission.admitted && admission.hold !== undefined) await rt.releaseHold(admission.hold);
  expect(outcome).toEqual({ outcome: 'succeeded' });
  return { runId, assistantMessageId: first(hooks.assistantMessageIds, 'assistant message') };
}

/** The completion rows the run's settlement wrote, one per billed language generation. */
async function completionDurationsOf(runId: string): Promise<(number | null)[]> {
  const rows = await db
    .select({ reasoningDurationMs: llmCompletions.reasoningDurationMs })
    .from(usageRecords)
    .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
    .where(eq(usageRecords.runId, runId));
  return rows.map((row) => row.reasoningDurationMs);
}

/** The reasoning time the member history read and the public share read serve for the reply. */
async function servedDurations(
  fixture: Fixture,
  messageId: string
): Promise<{ readonly history: number | null; readonly shared: number | null }> {
  const stores = createConversationsStores(db);
  const historyRead = await getMessageHistory(stores, {
    conversationId: fixture.conversationId,
    caller: { kind: 'user', userId: fixture.userId },
  });
  const history = historyRead._unsafeUnwrap();
  if ('refusal' in history) throw new Error(`history refused: ${history.refusal}`);
  const historyItem = history.messages.find((message) => message.id === messageId)?.contentItems[0];
  const shareRows = await db
    .insert(sharedMessages)
    .values({ messageId, createdBy: fixture.userId, wrappedContentKey: BYTES })
    .returning({ id: sharedMessages.id });
  const sharedRead = await readSharedMessage(stores, { shareId: first(shareRows, 'share').id });
  const shared = sharedRead._unsafeUnwrap();
  if ('refusal' in shared) throw new Error(`share read refused: ${shared.refusal}`);
  if (historyItem === undefined) throw new Error('the reply is missing from the history read');
  return {
    history: historyItem.reasoningDurationMs,
    shared: first(shared.contentItems, 'shared content item').reasoningDurationMs,
  };
}

describe('a settled reply’s reasoning time', () => {
  it('stores a positive time on the completion row of a turn that streamed reasoning', async () => {
    const fixture = await seedFixture();
    const run = await settleTurn(fixture, 'low');

    const durations = await completionDurationsOf(run.runId);

    expect(durations).toHaveLength(1);
    expect(durations[0]).toBeGreaterThan(0);
  });

  it('serves the stored time on both the history read and the share read', async () => {
    const fixture = await seedFixture();
    const run = await settleTurn(fixture, 'low');
    const [stored] = await completionDurationsOf(run.runId);

    const served = await servedDurations(fixture, run.assistantMessageId);

    expect(served.history).toBe(stored);
    expect(served.shared).toBe(stored);
  });

  it('stores and serves null for a turn that streamed no reasoning', async () => {
    const fixture = await seedFixture();
    const run = await settleTurn(fixture);

    const durations = await completionDurationsOf(run.runId);
    const served = await servedDurations(fixture, run.assistantMessageId);

    expect(durations).toEqual([null]);
    expect(served).toEqual({ history: null, shared: null });
  });
});
