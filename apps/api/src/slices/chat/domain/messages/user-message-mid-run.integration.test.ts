import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, eq, inArray } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  modelCatalog,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { createChatStores } from '../../adapters/stores.js';
import { buildTurnDefinition } from '../turn/definition.js';
import { createConversationRuntime } from '../runtime.js';
import { CHAT_TURN_INPUT } from '../constants.js';
import { saveUserOnlyMessage } from './user-message.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { ChatHookBindings } from '../runtime.js';
import type { EpochPublicKeyReader } from '../settlement/settlement.js';
import type { FlowRunOutcome, RunContext, RunIdentity, WorkflowDefinition } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

/**
 * A runless user-only send that lands while a paid run streams, driven end to
 * end: the real runtime claims the run, the deterministic mock provider
 * answers, and the save runs between the answer and its settlement, which is
 * the moment a colliding message row would make settlement refuse an answer
 * already delivered.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for the mid-run user message integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([5, 5, 5]);
const MODEL = `chat-mid-run/${crypto.randomUUID().slice(0, 8)}`;
const BODY_HASH = 'mid-run-body-hash';
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

const rt = createConversationRuntime({
  db,
  redis,
  telemetry: silentTelemetry,
  apiKey: 'mock-key',
  searchApiKey: 'mock-key',
  isCI: false,
  // Only with this true does a run's `mockDirectives` select the deterministic mock.
  mockProviderEnabled: true,
  chatStores: createChatStores(),
  // A text turn never reaches storage; a throwing proxy proves it. Its empty
  // target holds none of the port's members, so it types only by assertion.
  storage: new Proxy(
    {},
    {
      get() {
        throw new Error('storage must not be touched by a text turn');
      },
    }
  ) as Parameters<typeof createConversationRuntime>[0]['storage'],
  readEpochPublicKey,
});

let definition: WorkflowDefinition;

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
      },
    })
    .onConflictDoNothing();
  const built = await buildTurnDefinition({ db, telemetry: silentTelemetry }, MODEL, {});
  definition = built._unsafeUnwrap();
});

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL]));
  await db.$client.end();
});

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

/** A conversation the user owns and is a member of, wrapped to a real epoch key. */
async function seedOwnedConversation(userId: string): Promise<string> {
  const { conversationId, epochId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: generateEpochKeyPair().publicKey,
  });
  createdConversationIds.push(conversationId);
  // Settlement's epoch-at-persist gate checks the sender's key against the
  // epoch's member wrap-set; the user's public key is BYTES.
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey: BYTES, wrap: BYTES, visibleFromEpoch: 1 });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return conversationId;
}

interface Fixture {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  /** A second conversation of the same sender, where the mid-run save lands. */
  readonly otherConversationId: string;
}

async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@mid-run.test`,
        username: `mr${suffix}`,
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
    .values({ userId, type: 'purchased', balanceNanoUsd: 1_000_000_000_000n })
    .returning({ id: wallets.id });
  return {
    userId,
    walletId: first(walletRows, 'wallet').id,
    conversationId: await seedOwnedConversation(userId),
    otherConversationId: await seedOwnedConversation(userId),
  };
}

/**
 * Drives one paid turn exactly as the room does, running `midRun` after the
 * answer streamed and before the settlement hook commits it.
 */
async function driveTurn(
  fixture: Fixture,
  userMessage: { readonly id: string; readonly content: string },
  midRun: () => Promise<void>
): Promise<{ readonly outcome: FlowRunOutcome; readonly runId: string }> {
  const runKey = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const identity: RunIdentity = {
    mode: 'paid',
    payerUserId: fixture.userId,
    sender: { kind: 'user', userId: fixture.userId },
    conversationId: fixture.conversationId,
    walletId: fixture.walletId,
    epochNumber: 1,
    userMessage,
  };
  const claim = await rt.claimRun({ runKey, runId, bodyHash: BODY_HASH, identity });
  if (claim.outcome !== 'executor')
    throw new Error(`expected an executor claim, got ${claim.outcome}`);
  const context: RunContext = { ...identity, runId, fence: claim.fence, mockDirectives: {} };
  const bound = rt.bindHooks(context, definition);
  const hooks: ChatHookBindings = {
    ...bound,
    settlement: async (request) => {
      await midRun();
      await bound.settlement(request);
    },
  };
  const handle = rt.executor.start({
    definition,
    inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: userMessage.content } },
    hooks,
    runKey,
    mockDirectives: {},
    emit: () => {},
  });
  const outcome = await handle.done;
  const admission = await handle.admitted;
  if (admission.admitted && admission.hold !== undefined) await rt.releaseHold(admission.hold);
  return { outcome, runId };
}

describe('a user-only message saved while a run streams', () => {
  it("does not fail that run's settlement, and the run is billed", async () => {
    const fixture = await seedFixture();
    // The id the route minted for the run and returned on its run-start response.
    const runUserMessageId = crypto.randomUUID();

    // The sender knows it, but the save takes no id: it mints its own.
    let savedId: string | undefined;
    const turn = await driveTurn(fixture, { id: runUserMessageId, content: 'hello' }, async () => {
      await db.transaction(async (tx) => {
        const saved = await saveUserOnlyMessage(
          { tx, stores: createChatStores(), readEpochPublicKey, newId: () => crypto.randomUUID() },
          {
            conversationId: fixture.otherConversationId,
            senderId: fixture.userId,
            content: 'posted into the other conversation mid-run',
          }
        );
        savedId = saved._unsafeUnwrap().messageId;
      });
    });

    expect(savedId).toEqual(expect.any(String));
    expect(savedId).not.toBe(runUserMessageId);
    expect(turn.outcome.outcome).toBe('succeeded');
    const charges = await db.select().from(usageRecords).where(eq(usageRecords.runId, turn.runId));
    expect(charges).toHaveLength(1);
  });
});
