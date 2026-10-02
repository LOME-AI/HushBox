import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  ERROR_CODES,
  MAX_MEDIA_OBJECT_BYTES,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  toBase64,
} from '@hushbox/shared';
import {
  decryptContentEnvelope,
  generateContentKey,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  accountDeletionEvents,
  contentItems,
  conversationForks,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  epochMembers,
  epochs,
  idempotencyKeys,
  ledgerEntries,
  llmCompletions,
  memberBudgets,
  messages,
  modelCatalog,
  sharedLinks,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { applyMarkup } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import {
  InfrastructureUnavailableError,
  SettlementConflictError,
  createFencedSettlementHook,
  keyRowCompletion,
} from '../../../workflows/index.js';
import {
  admitRun,
  createBillingStores,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  resolveBudgetScopes,
  STORAGE_COST_PER_CHARACTER_NANO,
} from '../../../billing/index.js';
import { BILLING_KEYS } from '../../../billing/domain/keys.js';
import { claimKeyRow, runSettlement } from '../../../../lib/idempotency/index.js';
import { createConversationsStores } from '../../../conversations/index.js';
import {
  createSharedLink,
  deleteConversation,
  deleteFork,
  leaveConversation,
  removeMember,
  updateForkTip,
} from '../../../conversations/domain/index.js';
import {
  MEDIA_RECLAIM_USER_JOB_TYPE,
  createMediaReclaimUserJob,
  createR2Storage,
} from '../../../media/index.js';
import { executeAccountDeletion } from '../../../identity/domain/account/deletion.js';
import { createIdentityStores } from '../../../identity/adapters/stores.js';
import {
  createAppJobRegistry,
  createJobWakeCollector,
  enqueueWithinTx,
  grantJobWakes,
} from '../../../../lib/jobs/index.js';
import { createCatalogSightingRecorder, refreshCatalog } from '../../../models/index.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageEndpointsFixture,
  imageModelFixture,
} from '../../../models/domain/catalog/gateway-fixtures.js';
import { ResultAsync, errAsync, okAsync } from '../../../../lib/result/index.js';
import { conflictError, domainWireCode, unavailableError } from '../../../../lib/errors/index.js';
import {
  captureContentStorageKeysWithinTx,
  deleteForeignMessageContentWithinTx,
  detachMessageSendersWithinTx,
} from '../../index.js';
import { createChatStores } from '../../adapters/stores.js';
import { createForkMessageDeleter } from '../../adapters/fork-messages.js';
import { CHAT_TURN_INPUT, CHAT_TURN_ROUTE } from '../constants.js';
import { saveUserOnlyMessage } from '../messages/user-message.js';
import { createConversationRuntime } from '../runtime.js';
import { buildTurnDefinition } from '../turn/definition.js';
import { buildMediaTurnDefinition } from '../turn/media-turn.js';
import { createChatRefusalCommit } from './refusal.js';
import { ASSISTANT_SENDER_ID, createChatSettlementCommit } from './settlement.js';
import {
  seatCurrentEpochHolder,
  seedConversationWithEpoch,
} from '../../../../test-support/conversation-seed.js';
import { mintLinkCredential } from '../../../../test-support/link-credential.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type {
  ContentValue,
  FlowRunOutcome,
  FlowStreamEvent,
  MediaPersistPlan,
  RegenerateAction,
  RunContext,
  RunIdentity,
  SenderPrincipal,
  SettlementCharge,
  SettlementRequest,
  StreamChatRotation,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { SettlementTx } from '../../../../lib/idempotency/index.js';
import type { AccountDeletionPurge } from '../../../identity/ports/deletion.js';
import type { Storage } from '../../../media/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { ChatStores } from '../../ports/stores.js';
import type { ChatHookBindings } from '../runtime.js';

/**
 * Saved ⟺ billed, atomically. The chat settlement commit persists the linear
 * message tree — the initiator's user message chained onto the conversation
 * tip, then the assistant reply chained onto the user message, sharing one
 * batch id and a contiguous sequence block — plus every content item, and
 * charges every billable generation inside the ONE fenced settlement
 * transaction. A throw before commit leaves ZERO committed rows. The persisted
 * content is a real epoch-wrapped envelope that decrypts with the epoch key.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for chat settlement integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
// A second pool, because `createDb` caps each at one connection: the settlement
// transaction owns `db`'s only connection while it runs, so a write that must
// land mid-transaction has to arrive on a connection of its own.
const dbInterloper = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([9, 9, 9]);
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
const MODEL_ID = 'chat-settle/model';
const PROVIDER_NAME = 'chat-settle-provider';
const PROMPT = 'ask:hello world';
const ANSWER = 'echo:hello world';
const BASE_COST = 1000n;
/**
 * The additive (never-marked-up) storage fee for a standard PROMPT→ANSWER turn:
 * the new user prompt plus the single assistant response, at the per-char rate.
 * The usage record's charged cost is the marked-up model cost PLUS this.
 */
const PROMPT_ANSWER_STORAGE =
  BigInt(PROMPT.length + ANSWER.length) * STORAGE_COST_PER_CHARACTER_NANO;
/**
 * The storage fee for a turn that stores a reply but no new user message — a
 * retry, which re-runs against the anchor the original turn already paid to
 * store.
 */
const ANSWER_ONLY_STORAGE = BigInt(ANSWER.length) * STORAGE_COST_PER_CHARACTER_NANO;
const decoder = new TextDecoder();
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
  await dbInterloper.$client.end();
});

interface Fixture {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  readonly memberId: string;
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
  readonly epochPublicKey: ReturnType<typeof generateEpochKeyPair>['publicKey'];
}

async function insertTestUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@chat-settle.test`,
        username: `cs${suffix}`,
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
  return userId;
}

/**
 * Advances a conversation to epoch 2 the way a real rotation does — the epoch
 * row first, then the pointer. `current_epoch` is a foreign key into `epochs`,
 * so a pointer moved on its own is refused.
 */
async function rotateToEpochTwo(conversationId: string): Promise<void> {
  await db.insert(epochs).values({
    conversationId,
    epochNumber: 2,
    epochPublicKey: generateEpochKeyPair().publicKey,
    confirmationHash: BYTES,
  });
  await db
    .update(conversations)
    .set({ currentEpoch: 2 })
    .where(eq(conversations.id, conversationId));
}

/** An epoch a rotation minted: its number and the private key its wrap set unwraps to. */
interface RotatedEpoch {
  readonly epochNumber: number;
  readonly privateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
}

/**
 * Advances a conversation to epoch 2 with the sender's key (users.publicKey ===
 * BYTES) in the new wrap set: a rotation that removed someone else, or seated
 * a link without history, while the sender stayed.
 */
async function rotateKeepingSender(conversationId: string): Promise<RotatedEpoch> {
  const keyPair = generateEpochKeyPair();
  const epochRows = await db
    .insert(epochs)
    .values({
      conversationId,
      epochNumber: 2,
      epochPublicKey: keyPair.publicKey,
      confirmationHash: BYTES,
    })
    .returning({ id: epochs.id });
  await db.insert(epochMembers).values({
    epochId: first(epochRows, 'epoch').id,
    memberPublicKey: BYTES,
    wrap: BYTES,
    visibleFromEpoch: 1,
  });
  await db
    .update(conversations)
    .set({ currentEpoch: 2 })
    .where(eq(conversations.id, conversationId));
  return { epochNumber: 2, privateKey: keyPair.privateKey };
}

async function seedFixture(options: { readonly seedWrapSet?: boolean } = {}): Promise<Fixture> {
  const userId = await insertTestUser();

  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000n })
    .returning({ id: wallets.id });
  const walletId = first(walletRows, 'wallet').id;

  const keyPair = generateEpochKeyPair();
  const { conversationId, epochId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: keyPair.publicKey,
  });
  createdConversationIds.push(conversationId);

  if (options.seedWrapSet !== false) {
    // The member-keyed epoch-at-persist gate verifies the sender's public key
    // against the authoritative `epoch_members` wrap-set; the initiator's key
    // (users.publicKey === BYTES) is a member of epoch 1.
    await db.insert(epochMembers).values({
      epochId,
      memberPublicKey: BYTES,
      wrap: BYTES,
      visibleFromEpoch: 1,
    });
  }
  // The epoch-at-persist gate reads active membership; the initiator is a
  // member of epoch 1 (the conversation's default current epoch).
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = first(memberRows, 'member').id;
  return {
    userId,
    walletId,
    conversationId,
    memberId,
    epochPrivateKey: keyPair.privateKey,
    epochPublicKey: keyPair.publicKey,
  };
}

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

function charge(): SettlementCharge {
  return {
    key: 'answer',
    modelId: MODEL_ID,
    providerName: PROVIDER_NAME,
    modality: 'text',
    generationId: 'gen-1',
    billableCostNanoUsd: applyMarkup(BASE_COST),
    isEstimated: false,
  };
}

function request(runKey: string): SettlementRequest {
  return {
    runKey,
    outputs: { answer: { kind: 'text', text: ANSWER } },
    charges: [charge()],
  };
}

/** A multi-model turn: two selected models, two sibling generations. */
function multiModelRequest(runKey: string, baseA: bigint, baseB: bigint): SettlementRequest {
  return {
    runKey,
    outputs: {
      'model-a': { kind: 'text', text: `${ANSWER} a` },
      'model-b': { kind: 'text', text: `${ANSWER} b` },
    },
    charges: [
      {
        key: 'model-a',
        modelId: MODEL_ID,
        providerName: PROVIDER_NAME,
        modality: 'text',
        generationId: 'gen-a',
        billableCostNanoUsd: applyMarkup(baseA),
        isEstimated: false,
      },
      {
        key: 'model-b',
        modelId: MODEL_ID,
        providerName: PROVIDER_NAME,
        modality: 'text',
        generationId: 'gen-b',
        billableCostNanoUsd: applyMarkup(baseB),
        isEstimated: false,
      },
    ],
  };
}

async function claimFence(
  userId: string,
  runKey: string,
  runId: string
): Promise<{ id: string; executorId: string; claims: number }> {
  const executorId = crypto.randomUUID();
  const claimed = await claimKeyRow(db, {
    scope: { userId, route: CHAT_TURN_ROUTE, key: runKey },
    kind: 'run',
    bodyHash: 'body-hash',
    executorId,
    leaseSeconds: 90,
    runId,
  });
  const claim = claimed._unsafeUnwrap();
  if (claim.outcome !== 'executor') throw new Error('expected a fresh executor claim');
  return { id: claim.row.id, executorId, claims: claim.row.claims };
}

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

/**
 * Runs a settlement expected to terminal-fail on an ordinary concurrency race
 * and asserts it threw the typed `SettlementConflictError` sentinel projecting
 * to the given client wire code — so the engine reroutes it to a friendly
 * `{code}` outcome with no Sentry event, never `INTERNAL` + a defect capture.
 */
async function expectSettlementConflict(
  run: Promise<unknown>,
  expectedCode: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
): Promise<void> {
  const thrown = await run.then(
    () => {
      throw new Error('expected the settlement to reject');
    },
    (error: unknown) => error
  );
  expect(thrown).toBeInstanceOf(SettlementConflictError);
  expect(domainWireCode((thrown as SettlementConflictError).domainError)).toBe(expectedCode);
}

/**
 * Runs a settlement expected to terminal-fail because a precondition read did
 * not complete, and asserts it threw the infrastructure sentinel rather than
 * the refusal one — so the engine reroutes it to UNAVAILABLE and raises it for
 * an operator, never telling the user their state conflicts over a store that
 * never answered.
 */
async function expectSettlementUnavailable(run: Promise<unknown>): Promise<void> {
  const thrown = await run.then(
    () => {
      throw new Error('expected the settlement to reject');
    },
    (error: unknown) => error
  );
  expect(thrown).toBeInstanceOf(InfrastructureUnavailableError);
  expect(thrown).not.toBeInstanceOf(SettlementConflictError);
}

interface StoredMessage {
  readonly id: string;
  readonly wrappedContentKey: Uint8Array | null;
}

interface StoredContent {
  readonly id: string;
  readonly encryptedBlob: Uint8Array | null;
}

function decryptItem(
  fixture: Fixture,
  message: StoredMessage,
  content: StoredContent,
  senderId: string
): string {
  return decryptAtEpoch(
    { epochNumber: 1, privateKey: fixture.epochPrivateKey },
    { conversationId: fixture.conversationId, senderId },
    message,
    content
  );
}

/** Decrypts a stored item with one epoch's private key, as a holder of that key would. */
function decryptAtEpoch(
  epoch: RotatedEpoch,
  location: { readonly conversationId: string; readonly senderId: string },
  message: StoredMessage,
  content: StoredContent
): string {
  if (!message.wrappedContentKey || !content.encryptedBlob) throw new Error('ciphertext missing');
  const wrapped = message.wrappedContentKey as WrappedSecret;
  const contentKey = unwrapContentKeyFromEpoch(epoch.privateKey, wrapped);
  const plaintext = decryptContentEnvelope(
    contentKey,
    wrapped,
    {
      conversationId: location.conversationId,
      messageId: message.id,
      contentItemId: content.id,
      position: 0,
      epochNumber: epoch.epochNumber,
      senderId: location.senderId,
    },
    content.encryptedBlob
  );
  return decoder.decode(plaintext);
}

/** Every text answer's charge key this file settles. */
const TEXT_ANSWER_KEYS = [
  'answer',
  'answer0',
  'answer1',
  'answer2',
  'model-a',
  'model-b',
  'sibling-b',
];

/** A fresh answer id for every text answer key, as a run start mints them. */
function mintedAnswerIds(): ReadonlyMap<string, string> {
  return new Map(TEXT_ANSWER_KEYS.map((key) => [key, crypto.randomUUID()]));
}

function commitFor(
  fixture: Fixture,
  runId: string,
  stores: ChatStores,
  options: {
    readonly userMessage?: { readonly id: string; readonly content: string };
    readonly forkId?: string;
    readonly regenerate?: RegenerateAction;
    /** The pre-minted media persistence identities, keyed by charge key. */
    readonly mediaPlans?: ReadonlyMap<string, MediaPersistPlan>;
    /**
     * The answer ids minted when the run started, keyed by charge key. Defaults
     * to a fresh id for every text answer key this file settles.
     */
    readonly answerMessageIds?: ReadonlyMap<string, string>;
    /** The derived funding decision; defaults to personal (no group accrual). */
    readonly ownerFunded?: boolean;
    /**
     * The resolved sender principal. Defaults to the fixture's own member —
     * the solo turn, where the sender IS the payer — so a case that names a
     * different sender (a link guest, or a member ≠ the payer) says so.
     */
    readonly sender?: SenderPrincipal;
    readonly conversationsStores?: (
      tx: SettlementTx
    ) => ReturnType<typeof createConversationsStores>;
  } = {}
): ReturnType<typeof createChatSettlementCommit> {
  return createChatSettlementCommit({
    identity: {
      conversationId: fixture.conversationId,
      epochNumber: 1,
      walletId: fixture.walletId,
      payerUserId: fixture.userId,
      sender: options.sender ?? { kind: 'user', userId: fixture.userId },
      runId,
      userMessage: options.userMessage ?? { id: crypto.randomUUID(), content: PROMPT },
      answerMessageIds: options.answerMessageIds ?? mintedAnswerIds(),
      ...(options.forkId === undefined ? {} : { forkId: options.forkId }),
      ...(options.regenerate === undefined ? {} : { regenerate: options.regenerate }),
      ...(options.mediaPlans === undefined ? {} : { mediaPlans: options.mediaPlans }),
    },
    stores,
    billingStores: createBillingStores(),
    ownerFunded: options.ownerFunded ?? false,
    readEpochPublicKey,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
    ...(options.conversationsStores === undefined
      ? {}
      : { conversationsStores: options.conversationsStores }),
  });
}

async function seedFork(
  conversationId: string,
  tipMessageId: string | null,
  name = 'Main'
): Promise<string> {
  const rows = await db
    .insert(conversationForks)
    .values({ conversationId, name, tipMessageId })
    .returning({ id: conversationForks.id });
  const forkId = rows[0]?.id;
  if (forkId === undefined) throw new Error('fork seed failed');
  return forkId;
}

async function forkTip(forkId: string): Promise<string | null> {
  const rows = await db
    .select({ tip: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));
  return rows[0]?.tip ?? null;
}

async function messagesInOrder(conversationId: string): Promise<(typeof messages.$inferSelect)[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sequenceNumber));
}

describe('chat settlement commit (saved ⟺ billed, linear tree)', () => {
  it('persists the user + assistant messages, chained and batched, and charges once', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const userMessageId = crypto.randomUUID();

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      }),
    });
    await hook(request(runKey));

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    const [userMessage, assistantMessage] = rows;
    if (!userMessage || !assistantMessage) throw new Error('expected two messages');

    // The user message: the id the run identity carries, sender = initiator,
    // root parent (empty conversation), lowest sequence in the reserved block.
    expect(userMessage.id).toBe(userMessageId);
    expect(userMessage.senderType).toBe('user');
    expect(userMessage.senderId).toBe(fixture.userId);
    expect(userMessage.parentMessageId).toBeNull();

    // The assistant message: reserved sentinel sender, chained onto the user
    // message, next sequence in the block, and sharing the turn's batch id.
    expect(assistantMessage.senderType).toBe('assistant');
    expect(assistantMessage.senderId).toBe(ASSISTANT_SENDER_ID);
    expect(assistantMessage.parentMessageId).toBe(userMessage.id);
    expect(assistantMessage.sequenceNumber).toBe(userMessage.sequenceNumber + 1);
    expect(assistantMessage.batchId).toBe(userMessage.batchId);

    // The user content carries no model/cost; the assistant content mirrors the
    // charged (post-markup) cost.
    const userContent = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, userMessage.id)),
      'user content'
    );
    expect(userContent.modelId).toBeNull();
    expect(userContent.costNanoUsd).toBeNull();

    const assistantContent = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistantMessage.id)),
      'assistant content'
    );
    expect(assistantContent.modelId).toBe(MODEL_ID);
    // Displayed cost EQUALS the wallet debit: marked-up model cost PLUS the
    // additive prompt+response storage fee (the same value the charge debits).
    expect(assistantContent.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);

    // Exactly one charge, keyed to the run.
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    // Marked-up model cost PLUS the additive prompt+response storage fee.
    expect(usage.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
    // Display equals debit: the persisted content cost is exactly what the wallet paid.
    expect(assistantContent.costNanoUsd).toBe(usage.costNanoUsd);
    // The run's conversation is stamped onto the usage record (per-conversation
    // spend analytics), even for this solo turn where the charge path itself
    // never carries a conversationId.
    expect(usage.conversationId).toBe(fixture.conversationId);

    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, usage.id));
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);

    const keyRow = first(
      await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id)),
      'key'
    );
    expect(keyRow.status).toBe('succeeded');

    // Both persisted envelopes decrypt: the user's prompt under the initiator's
    // AAD sender, the assistant's answer under the sentinel.
    expect(decryptItem(fixture, userMessage, userContent, fixture.userId)).toBe(PROMPT);
    expect(decryptItem(fixture, assistantMessage, assistantContent, ASSISTANT_SENDER_ID)).toBe(
      ANSWER
    );
  });

  it('stores the text answer under the id minted when the run started', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const answerId = crypto.randomUUID();

    await createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        answerMessageIds: new Map([['answer', answerId]]),
      }),
    })(request(runKey));

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows.find((row) => row.senderType === 'assistant')?.id).toBe(answerId);
  });

  it('stores each sibling of a multi-model turn under its own minted id', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const ids = new Map([
      ['model-a', crypto.randomUUID()],
      ['model-b', crypto.randomUUID()],
    ]);

    await createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), { answerMessageIds: ids }),
    })(multiModelRequest(runKey, BASE_COST, BASE_COST));

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows.filter((row) => row.senderType === 'assistant').map((row) => row.id)).toEqual([
      ids.get('model-a'),
      ids.get('model-b'),
    ]);
  });

  it('refuses to settle a text answer with no minted id, as a defect that saves nothing', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);

    const settle = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), { answerMessageIds: new Map() }),
    });

    await expect(settle(request(runKey))).rejects.toThrow(/no minted message id/);
    expect(await messagesInOrder(fixture.conversationId)).toEqual([]);
  });

  it('settles a Smart Model turn: one assistant message, classifier + answer both billed against it', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const classifierBase = 40n;

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores()),
    });
    // The interpreter's smartModel charge shape: the answer under the node key
    // (flagged `smartModelRan` — the routing pipeline ran), the classifier
    // generation under the suffixed key with no output and no chip flag of its own.
    await hook({
      runKey,
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [
        { ...charge(), smartModelRan: true },
        {
          key: 'answer#classifier',
          modelId: 'chat-settle/classifier',
          providerName: PROVIDER_NAME,
          modality: 'text',
          generationId: 'gen-cls',
          billableCostNanoUsd: applyMarkup(classifierBase),
          isEstimated: false,
        },
      ],
    });

    // ONE assistant message whose content carries the RESOLVED answer model —
    // the classifier persisted no content of its own.
    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    const assistantMessage = rows[1];
    if (!assistantMessage) throw new Error('expected an assistant message');
    const assistantContents = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMessage.id));
    expect(assistantContents).toHaveLength(1);
    const answerContent = first(assistantContents, 'assistant content');
    expect(answerContent.modelId).toBe(MODEL_ID);
    // Display equals the FULL debit: the answer content mirrors its own charge
    // (marked-up model cost + prompt+response storage) PLUS the classifier charge
    // anchored to the same content item, and the item is flagged a Smart Model turn.
    expect(answerContent.costNanoUsd).toBe(
      applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE + applyMarkup(classifierBase)
    );
    expect(answerContent.isSmartModel).toBe(true);

    // TWO usage records — classifier + answer — both FK'd to the one persisted
    // answer content item (saved ⟺ billed), each with its own generation.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(2);
    for (const record of usage) {
      expect(record.contentItemId).toBe(answerContent.id);
    }
    const byModel = new Map(usage.map((record) => [record.modelId, record]));
    // The answer (primary charge) carries the prompt+response storage; the
    // classifier persists no content of its own, so it carries no storage.
    expect(byModel.get(MODEL_ID)?.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
    // Display equals debit: the answer content's stored cost is exactly the SUM of
    // both usage records (answer + classifier) FK'd to it.
    expect(answerContent.costNanoUsd).toBe(
      usage.reduce((sum, record) => sum + record.costNanoUsd, 0n)
    );
    expect(byModel.get(MODEL_ID)?.generationId).toBe('gen-1');
    expect(byModel.get('chat-settle/classifier')?.costNanoUsd).toBe(applyMarkup(classifierBase));
    expect(byModel.get('chat-settle/classifier')?.generationId).toBe('gen-cls');

    // Every charge's ledger legs sum to zero, and the fence flipped once.
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(
        inArray(
          ledgerEntries.usageRecordId,
          usage.map((record) => record.id)
        )
      );
    expect(legs).toHaveLength(4);
    for (const record of usage) {
      const recordLegs = legs.filter((leg) => leg.usageRecordId === record.id);
      expect(recordLegs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    }
    const keyRow = first(
      await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id)),
      'key'
    );
    expect(keyRow.status).toBe('succeeded');
  });

  it('badges a smartModel answer whose classifier failed — smartModelRan, no classifier charge', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores()),
    });
    // A classifier that failed and fell back produces NO classifier charge, only
    // the answer charge flagged `smartModelRan`. The chip must still badge — it
    // reads "the pipeline ran", not "the classifier billed".
    await hook({
      runKey,
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [{ ...charge(), smartModelRan: true }],
    });

    const rows = await messagesInOrder(fixture.conversationId);
    const assistant = rows.find((row) => row.senderType === 'assistant');
    if (!assistant) throw new Error('expected an assistant message');
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistant.id)),
      'assistant content'
    );
    expect(content.isSmartModel).toBe(true);
    // Only the answer billed — the failed classifier charged nothing.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(1);
    expect(content.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
  });

  it("lands a turn-level classifier charge on the run's content when the first sibling failed", async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const classifierBase = 40n;

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores()),
    });
    // The shape that has no per-generation anchor: the turn-level classifier
    // charges first and persists nothing, sibling A fails (producing no charge
    // at all), and sibling B is the only generation that persisted. Naming a
    // sibling would have lost the classifier's spend here.
    await hook({
      runKey,
      outputs: { 'sibling-b': { kind: 'text', text: ANSWER } },
      charges: [
        {
          key: 'classify',
          modelId: 'chat-settle/classifier',
          providerName: PROVIDER_NAME,
          modality: 'text',
          generationId: 'gen-cls',
          billableCostNanoUsd: applyMarkup(classifierBase),
          isEstimated: false,
        },
        { ...charge(), key: 'sibling-b' },
      ],
    });

    const rows = await messagesInOrder(fixture.conversationId);
    const assistant = rows.find((row) => row.senderType === 'assistant');
    if (!assistant) throw new Error('expected an assistant message');
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistant.id)),
      'assistant content'
    );
    // Display equals debit on the SAME item: sibling B's own marked-up cost plus
    // the whole turn's storage plus the classifier's marked-up cost.
    expect(content.costNanoUsd).toBe(
      applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE + applyMarkup(classifierBase)
    );
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(2);
    for (const record of usage) expect(record.contentItemId).toBe(content.id);
    const byModel = new Map(usage.map((record) => [record.modelId, record]));
    expect(byModel.get('chat-settle/classifier')?.costNanoUsd).toBe(applyMarkup(classifierBase));
  });

  it('chains a second turn onto the prior assistant tip with a fresh batch id', async () => {
    const fixture = await seedFixture();
    const firstRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, firstRunId, createChatStores())(tx, request('k1'))
    );
    const secondRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, secondRunId, createChatStores())(tx, request('k2'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(4);
    const [turn1User, turn1Assistant, turn2User, turn2Assistant] = rows;
    if (!turn1User || !turn1Assistant || !turn2User || !turn2Assistant) {
      throw new Error('expected four messages');
    }
    // Turn 2's user message chains onto turn 1's assistant tip; turn 2's
    // assistant onto turn 2's user.
    expect(turn2User.parentMessageId).toBe(turn1Assistant.id);
    expect(turn2Assistant.parentMessageId).toBe(turn2User.id);
    // Sequences are monotonic and never reused across turns.
    expect(rows.map((r) => r.sequenceNumber)).toEqual([
      turn1User.sequenceNumber,
      turn1User.sequenceNumber + 1,
      turn1User.sequenceNumber + 2,
      turn1User.sequenceNumber + 3,
    ]);
    // Each turn carries its own batch id.
    expect(turn1User.batchId).toBe(turn1Assistant.batchId);
    expect(turn2User.batchId).toBe(turn2Assistant.batchId);
    expect(turn1User.batchId).not.toBe(turn2User.batchId);
  });

  it('terminal-fails and persists nothing when no generation produced a charge', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // No persistable content is the all-failed signal. The commit throws to roll
    // the settlement back — nothing saved, nothing billed, and the client is
    // told the turn failed.
    const emptyRequest: SettlementRequest = { runKey: 'k', outputs: {}, charges: [] };
    await expect(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, emptyRequest))
    ).rejects.toThrow(/no model produced content/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('terminal-fails a run whose only charge carries no persistable content', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const mediaRequest: SettlementRequest = {
      runKey: 'k',
      outputs: {
        answer: {
          kind: 'media',
          value: {
            ref: 'r',
            mimeType: 'image/png',
            modality: 'image',
            byteLength: 1,
            metadata: {},
          },
        },
      },
      charges: [charge()],
    };
    // A media output under a non-media charge persists nothing, so the run
    // reached settlement having produced no content at all — the same outcome as
    // every branch failing, and it must raise rather than commit an empty
    // success.
    await expect(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, mediaRequest))
    ).rejects.toThrow(/no model produced content/);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('terminal-fails a run whose only charge is a generation that persisted nothing', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // The shape a turn-level generation creates: one charge arrives, but the run
    // surfaced no output for it. "A charge exists" is not evidence any branch
    // succeeded, so the all-failed signal reads content, not charge count.
    const classifierOnly: SettlementRequest = { runKey: 'k', outputs: {}, charges: [charge()] };
    await expect(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, classifierOnly))
    ).rejects.toThrow(/no model produced content/);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('saves a text turn into the current epoch when the epoch rotated and the sender holds a key in it', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // The turn was authorized against epoch 1; a rotation that kept the sender
    // moved the conversation to epoch 2 before settlement.
    const rotated = await rotateKeepingSender(fixture.conversationId);
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores())(tx, request('k'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows.map((row) => row.epochNumber)).toEqual([2, 2]);
    const assistantMessage = first(rows.slice(1), 'assistant message');
    const assistantContent = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistantMessage.id)),
      'assistant content'
    );
    expect(
      decryptAtEpoch(
        rotated,
        { conversationId: fixture.conversationId, senderId: ASSISTANT_SENDER_ID },
        assistantMessage,
        assistantContent
      )
    ).toBe(ANSWER);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      1
    );
  });

  it('persists ZERO rows when the epoch rotated to a wrap set without the sender', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // A rotation advanced currentEpoch after send, and the new epoch's wrap set
    // holds no key of the sender's: a text turn cannot move into an epoch its
    // sender does not belong to, so the gate refuses.
    await rotateToEpochTwo(fixture.conversationId);
    // An ordinary rotation race → friendly CONFLICT, never INTERNAL + Sentry.
    await expectSettlementConflict(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, request('k'))),
      ERROR_CODES.CONFLICT
    );
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('throws when the wrap-target epoch has no wrap-set (inconsistent state)', async () => {
    // currentEpoch points at epoch 1 and the member is active, but that epoch
    // carries no `epoch_members` wrap-set — the member-keyed epoch gate finds
    // the sender's key in no epoch and fails closed (rolls back). The epoch row
    // itself cannot be missing: `current_epoch` is a foreign key into `epochs`.
    const fixture = await seedFixture({ seedWrapSet: false });
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k'))
      )
    ).rejects.toThrow(/wrap-epoch/);
  });

  it('persists ZERO rows when the initiator is no longer an epoch member', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // The initiator left/was removed without a rotation reaching settlement:
    // currentEpoch still matches, but they are no longer an active member.
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(eq(conversationMembers.conversationId, fixture.conversationId));
    await expect(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, request('k')))
    ).rejects.toThrow(/wrap-epoch/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('saves nothing to the pending epoch and bills the refusal when another member left before settlement', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const walletBefore = await walletBalance(fixture.walletId);
    // The run was admitted while the member sat. They left before it settled,
    // and no rotation has yet dropped their key from the current epoch.
    await seatCurrentEpochHolder(db, {
      conversationId: fixture.conversationId,
      userId: await insertTestUser(),
      departed: true,
    });
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores()),
      refusalCommit: refusalCommitFor(fixture, runId),
    });

    await expect(hook(request(runKey))).rejects.toBeInstanceOf(SettlementConflictError);

    // No message, so no content key wrapped to the pending epoch.
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    // The refusal commit's disposition, and nothing else: the streamed model
    // cost billed against no content, with no storage fee.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage.map((row) => row.contentItemId)).toEqual([null]);
    expect(usage.map((row) => row.costNanoUsd)).toEqual([applyMarkup(BASE_COST)]);
    expect(await ledgerNet(usage.map((row) => row.id))).toBe(0n);
    expect(await walletBalance(fixture.walletId)).toBe(walletBefore - applyMarkup(BASE_COST));
    expect(await keyRowStatus(fence.id)).toBe('succeeded');
  });

  it('settles and charges when the other member is still seated', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    await seatCurrentEpochHolder(db, {
      conversationId: fixture.conversationId,
      userId: await insertTestUser(),
    });

    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores())(tx, request('k'))
    );

    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(2);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      1
    );
    expect(await walletBalance(fixture.walletId)).toBeLessThan(10_000_000n);
  });

  it('commits nothing when the persist throws before settlement completes', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);

    const throwingStores: ChatStores = {
      ...createChatStores(),
      insertContentItemWithinTx: () => {
        throw new Error('persist boom before settlement completes');
      },
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, throwingStores),
    });
    await expect(hook(request(runKey))).rejects.toThrow(/persist boom/);

    // Zero committed rows: no message (user or assistant), no content, no usage.
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    // The key row was never flipped — a retry can still re-execute.
    const keyRows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id));
    expect(keyRows[0]?.status).toBe('claimed');
  });

  it('rejects a re-executed commit of one run on its fixed user-message id (no duplicate persist or charge)', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const userMessageId = crypto.randomUUID();

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      }),
    });
    await hook(request(runKey));

    // The run identity fixes the user-message id for the whole run, so re-running
    // its commit re-inserts that id and the primary key rejects it: one run can
    // persist its user message and land its charge only once.
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          userMessage: { id: userMessageId, content: PROMPT },
        })(tx, request(runKey))
      )
    ).rejects.toThrow();

    expect(
      await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.conversationId, fixture.conversationId), eq(messages.senderType, 'user'))
        )
    ).toHaveLength(1);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      1
    );
  });
});

describe('chat settlement commit (fresh-send onto a fork)', () => {
  it('chains onto the fork tip and advances the tip to the new assistant reply', async () => {
    const fixture = await seedFixture();
    // A prior linear turn establishes a message the fork tips at.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k-seed'))
    );
    const seeded = await messagesInOrder(fixture.conversationId);
    const priorAssistant = seeded.at(-1);
    if (!priorAssistant) throw new Error('expected a seeded assistant tip');
    const forkId = await seedFork(fixture.conversationId, priorAssistant.id, 'Branch');

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { forkId })(tx, request('k-fork'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const forkUser = rows[2];
    const forkAssistant = rows[3];
    if (!forkUser || !forkAssistant) throw new Error('expected the fork turn messages');
    // The fork turn's user message chains onto the fork's prior tip; the
    // assistant onto the user message.
    expect(forkUser.parentMessageId).toBe(priorAssistant.id);
    expect(forkAssistant.parentMessageId).toBe(forkUser.id);
    // The fork tip advanced to the new assistant reply inside the settlement tx.
    expect(await forkTip(forkId)).toBe(forkAssistant.id);
  });

  it('resolves a null-tipped fork to a root-parented user message and advances the tip', async () => {
    const fixture = await seedFixture();
    const forkId = await seedFork(fixture.conversationId, null, 'Empty branch');
    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { forkId })(tx, request('k-empty-fork'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const [user, assistant] = rows;
    if (!user || !assistant) throw new Error('expected two messages');
    expect(user.parentMessageId).toBeNull();
    expect(await forkTip(forkId)).toBe(assistant.id);
  });

  it('terminal-fails and persists nothing when the fork vanished mid-run', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const missingForkId = crypto.randomUUID();
    // A fork deleted mid-run is an expected race → friendly FORK_TIP_CONFLICT,
    // never INTERNAL + Sentry.
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), { forkId: missingForkId })(tx, request('k'))
      ),
      ERROR_CODES.FORK_TIP_CONFLICT
    );
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('terminal-fails and persists nothing when the fork-tip advance does not complete', async () => {
    // Catches a future change that swallows a failed tip CAS: the turn would
    // commit its messages and its charge while the fork tip stayed on the reply
    // they were chained past.
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const forkId = await seedFork(fixture.conversationId, null, 'Faulted branch');
    const faultingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return {
        ...real,
        forks: {
          ...real.forks,
          updateTip: () => errAsync(unavailableError('fork tip write boom')),
        },
      };
    };

    const thrown = await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        forkId,
        conversationsStores: faultingConversationsStores,
      })(tx, request('k-fork-tip-write-fault'))
    ).then(
      () => {
        throw new Error('expected the settlement to reject');
      },
      (error: unknown) => error
    );
    // A defect, deliberately: neither sentinel, so the engine routes it to
    // INTERNAL + Sentry rather than telling the user their state conflicts.
    // Not-unavailable is also what separates this from the fork-tip READ site,
    // which throws the same message through the infrastructure sentinel.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(InfrastructureUnavailableError);
    expect(thrown).not.toBeInstanceOf(SettlementConflictError);
    expect((thrown as Error).message).toMatch(/fork-tip advancement failed/);

    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await forkTip(forkId)).toBeNull();
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });
});

/** Runs `count` fresh-send turns, returning the persisted messages in order. */
async function seedTurns(
  fixture: Fixture,
  count: number
): Promise<Awaited<ReturnType<typeof messagesInOrder>>> {
  for (let index = 0; index < count; index += 1) {
    await runSettlement(db, (tx) =>
      commitFor(
        fixture,
        crypto.randomUUID(),
        createChatStores()
      )(tx, request(`k-seed-${String(index)}`))
    );
  }
  return messagesInOrder(fixture.conversationId);
}

/**
 * Manually grafts a message under `parentId` — an assistant sibling
 * (multi-model peer) by default, or a named sender's user message when a
 * co-member's reply is what the case needs.
 */
async function insertGraftedMessage(
  fixture: Fixture,
  parentId: string | null,
  sequenceNumber: number,
  sender?: { readonly senderType: 'user' | 'assistant'; readonly senderId: string }
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId: fixture.conversationId,
      senderType: sender?.senderType ?? 'assistant',
      senderId: sender?.senderId ?? ASSISTANT_SENDER_ID,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber,
      parentMessageId: parentId,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('grafted message seed failed');
  return id;
}

function ids(rows: readonly { readonly id: string }[]): string[] {
  return rows.map((row) => row.id);
}

describe('chat settlement commit (a precondition read that did not complete)', () => {
  /** Replaces one store method with a failed read, leaving every other real. */
  const faulting = (
    override: (
      real: ReturnType<typeof createConversationsStores>
    ) => Partial<ReturnType<typeof createConversationsStores>>
  ): ((tx: SettlementTx) => ReturnType<typeof createConversationsStores>) => {
    return (tx) => {
      const real = createConversationsStores(tx);
      return { ...real, ...override(real) };
    };
  };

  /** No message, usage or ledger row moved: the rollback left nothing behind. */
  const expectNothingSettled = async (fixture: Fixture, runId: string): Promise<void> => {
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, fixture.walletId))
    ).toHaveLength(0);
  };

  it('rejects as unavailable when the account lock fails, never as a conflict', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    await expectSettlementUnavailable(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          conversationsStores: faulting((real) => ({
            users: {
              ...real.users,
              lockForKeyShare: () => errAsync(unavailableError('account lock boom')),
            },
          })),
        })(tx, request('k-account-lock-fault'))
      )
    );
    await expectNothingSettled(fixture, runId);
  });

  it('rejects as unavailable when the sender-key read fails, never as a conflict', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    await expectSettlementUnavailable(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          conversationsStores: faulting((real) => ({
            members: {
              ...real.members,
              activeByUser: () => errAsync(unavailableError('member read boom')),
            },
          })),
        })(tx, request('k-sender-key-fault'))
      )
    );
    await expectNothingSettled(fixture, runId);
  });

  it('rejects as unavailable when the wrap-epoch read fails, never as a conflict', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    await expectSettlementUnavailable(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          conversationsStores: faulting((real) => ({
            conversations: {
              ...real.conversations,
              lockForShare: () => errAsync(unavailableError('conversation lock boom')),
            },
          })),
        })(tx, request('k-wrap-epoch-fault'))
      )
    );
    await expectNothingSettled(fixture, runId);
  });

  it('rejects as unavailable when the wrap-set membership read fails, never as a conflict', async () => {
    // Catches a future change that lets settlement continue past an unanswered
    // `epoch_members` read — the turn would then persist and bill content
    // wrapped to an epoch whose membership was never verified.
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    await expectSettlementUnavailable(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          conversationsStores: faulting((real) => ({
            epochs: {
              ...real.epochs,
              memberInEpoch: () => errAsync(unavailableError('wrap-set membership boom')),
            },
          })),
        })(tx, request('k-wrap-member-fault'))
      )
    );
    await expectNothingSettled(fixture, runId);
  });

  it('rejects as unavailable when the fork-tip read fails, never as a conflict', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const forkId = await seedFork(fixture.conversationId, null);
    await expectSettlementUnavailable(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          forkId,
          conversationsStores: faulting((real) => ({
            forks: { ...real.forks, lockById: () => errAsync(unavailableError('fork lock boom')) },
          })),
        })(tx, request('k-fork-tip-fault'))
      )
    );
    await expectNothingSettled(fixture, runId);
  });
});

describe('chat settlement commit (regenerate / edit — linear)', () => {
  it('retry-all deletes every reply below the anchor and re-parents a fresh reply', async () => {
    const fixture = await seedFixture();
    const seeded = await seedTurns(fixture, 2);
    const [u1, a1, u2, a2] = seeded;
    if (!u1 || !a1 || !u2 || !a2) throw new Error('expected four seeded messages');

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id },
      })(tx, request('k-retry-all'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    // The anchor user message survives; a1, u2, a2 are gone; one fresh reply
    // re-parents onto the anchor with a strictly higher sequence.
    expect(ids(rows)).toEqual([u1.id, expect.any(String)]);
    const reply = rows[1];
    if (!reply) throw new Error('expected a fresh reply');
    expect(reply.senderType).toBe('assistant');
    expect(reply.parentMessageId).toBe(u1.id);
    expect(reply.sequenceNumber).toBeGreaterThan(a2.sequenceNumber);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      1
    );
  });

  it('retry-one deletes only the named reply and keeps its siblings', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    // Far above the monotonic counter, so the manual sequence never collides
    // with a counter-reserved one.
    const sibling = await insertGraftedMessage(fixture, u1.id, a1.sequenceNumber + 100_000);

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id, replaceAssistantId: a1.id },
      })(tx, request('k-retry-one'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).toContain(u1.id);
    expect(surviving).toContain(sibling); // untouched sibling survives
    expect(surviving).not.toContain(a1.id); // only the named reply is gone
    const fresh = rows.find((row) => row.id !== u1.id && row.id !== sibling);
    expect(fresh?.parentMessageId).toBe(u1.id);
  });

  // A retry-one may name a reply that is NOT the last message on its branch —
  // the guard requires only that it is a direct assistant reply of the anchor.
  // The FK nulls its children's parent pointer on delete, so without an explicit
  // re-parent the whole subtree beneath it becomes a parentless root: severed
  // from the anchor, invisible to every tip→root walk, and unprotected by the
  // cross-member guard that walks the same links.
  it('retry-one re-parents the messages beneath the replaced reply onto the fresh reply', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    const coMemberId = crypto.randomUUID();
    // Far above the monotonic counter, so the manual sequence never collides
    // with a counter-reserved one.
    const follower = await insertGraftedMessage(fixture, a1.id, a1.sequenceNumber + 100_000, {
      senderType: 'user',
      senderId: coMemberId,
    });
    const followerReply = await insertGraftedMessage(
      fixture,
      follower,
      a1.sequenceNumber + 100_001
    );

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id, replaceAssistantId: a1.id },
      })(tx, request('k-retry-one-reparent'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const fresh = rows.find((row) => row.senderType === 'assistant' && row.id !== followerReply);
    expect(fresh).toBeDefined();
    // The direct child moves onto the reply that took the deleted one's place;
    // the grandchild's own link never moved.
    expect(rows.find((row) => row.id === follower)?.parentMessageId).toBe(fresh?.id);
    expect(rows.find((row) => row.id === followerReply)?.parentMessageId).toBe(follower);
    // Only the conversation's first message is a root.
    expect(rows.filter((row) => row.parentMessageId === null).map((row) => row.id)).toEqual([
      u1.id,
    ]);
    // And the walk from the deepest message still reaches the retried anchor.
    const byId = new Map(rows.map((row) => [row.id, row.parentMessageId]));
    const ancestry: string[] = [];
    for (let at = followerReply as string | null; at !== null; at = byId.get(at) ?? null) {
      ancestry.push(at);
    }
    expect(ancestry).toEqual([followerReply, follower, fresh?.id, u1.id]);
  });

  it('edit deletes from the anchor down and inserts a re-parented user message', async () => {
    const fixture = await seedFixture();
    const seeded = await seedTurns(fixture, 2);
    const [u1, a1, u2, a2] = seeded;
    if (!u1 || !a1 || !u2 || !a2) throw new Error('expected four seeded messages');
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: editedId, content: 'edited prompt' },
        regenerate: { action: 'edit', targetMessageId: u2.id },
      })(tx, request('k-edit'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).toContain(u1.id);
    expect(surviving).toContain(a1.id);
    expect(surviving).not.toContain(u2.id); // the edited user message is replaced
    expect(surviving).not.toContain(a2.id);
    const editedUser = rows.find((row) => row.id === editedId);
    // The new user message re-parents onto the anchor's parent (a1), not the anchor.
    expect(editedUser?.parentMessageId).toBe(a1.id);
    expect(editedUser?.senderType).toBe('user');
  });

  it('edit of a root anchor deletes the anchor and roots the replacement', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    expect(u1.parentMessageId).toBeNull();
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: editedId, content: 'edited root' },
        regenerate: { action: 'edit', targetMessageId: u1.id },
      })(tx, request('k-edit-root'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).not.toContain(u1.id);
    expect(surviving).not.toContain(a1.id);
    const editedUser = rows.find((row) => row.id === editedId);
    expect(editedUser?.parentMessageId).toBeNull(); // re-rooted
  });

  it('retains the original charge (content FK nulled) while charging the new generation', async () => {
    const fixture = await seedFixture();
    const seedRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, seedRunId, createChatStores())(tx, request('k-money-seed'))
    );
    const [u1] = await messagesInOrder(fixture.conversationId);
    if (!u1) throw new Error('expected the seeded user message');

    const retryRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, retryRunId, createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id },
      })(tx, request('k-money-retry'))
    );

    // The original charge row is retained (financial retention), only its
    // content FK is nulled by the cascade — the ledger legs stand.
    const oldUsage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, seedRunId)),
      'original usage'
    );
    expect(oldUsage.contentItemId).toBeNull();
    const oldLegs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, oldUsage.id));
    expect(oldLegs).toHaveLength(2);
    // The new generation is charged in full.
    const newUsage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, retryRunId)),
      'new usage'
    );
    expect(newUsage.costNanoUsd).toBe(applyMarkup(BASE_COST) + ANSWER_ONLY_STORAGE);
    expect(newUsage.contentItemId).not.toBeNull();
  });

  it('charges a retry no prompt storage, because it stores no user message', async () => {
    const fixture = await seedFixture();
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k-retry-store-seed'))
    );
    const [u1] = await messagesInOrder(fixture.conversationId);
    if (!u1) throw new Error('expected the seeded user message');

    const retryRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, retryRunId, createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id },
      })(tx, request('k-retry-store'))
    );

    // The anchor is the conversation's only user message — the retry inserted none.
    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows.filter((row) => row.senderType === 'user').map((row) => row.id)).toEqual([u1.id]);
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, retryRunId)),
      'retry usage'
    );
    expect(usage.costNanoUsd).toBe(applyMarkup(BASE_COST) + ANSWER_ONLY_STORAGE);
  });

  it('charges an edit the storage of the user message it does store', async () => {
    const fixture = await seedFixture();
    const [u1] = await seedTurns(fixture, 1);
    if (!u1) throw new Error('expected the seeded turn');
    const edited = 'edited prompt';

    const editRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, editRunId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: edited },
        regenerate: { action: 'edit', targetMessageId: u1.id },
      })(tx, request('k-edit-store'))
    );

    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, editRunId)),
      'edit usage'
    );
    expect(usage.costNanoUsd).toBe(
      applyMarkup(BASE_COST) +
        BigInt(edited.length + ANSWER.length) * STORAGE_COST_PER_CHARACTER_NANO
    );
  });

  it('terminal-fails a retry whose linear anchor vanished before settlement', async () => {
    const fixture = await seedFixture();
    // A retry-all against a target that no longer exists finds no reply to
    // delete, then FK-fails when the new reply tries to chain onto the missing
    // anchor — nothing persists (saved ⟺ billed).
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores(), {
          regenerate: { action: 'retry', targetMessageId: crypto.randomUUID() },
        })(tx, request('k-retry-missing'))
      )
    ).rejects.toThrow();
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('terminal-fails an edit whose target vanished before settlement', async () => {
    const fixture = await seedFixture();
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores(), {
          userMessage: { id: crypto.randomUUID(), content: 'edited' },
          regenerate: { action: 'edit', targetMessageId: crypto.randomUUID() },
        })(tx, request('k-edit-missing'))
      )
    ).rejects.toThrow(/edit target message not found/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('deletes every sibling tile of a solo multi-model turn on a retry-all', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    // Two more siblings of the same turn, as a multi-model fan-out persists them.
    const tileB = await insertGraftedMessage(fixture, u1.id, a1.sequenceNumber + 100_000);
    const tileC = await insertGraftedMessage(fixture, u1.id, a1.sequenceNumber + 100_001);

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id },
      })(tx, request('k-retry-all-multi'))
    );

    // ALL of the caller's own tiles go, not just the last one: the anchor and a
    // single fresh reply are what remain.
    const rows = await messagesInOrder(fixture.conversationId);
    expect(ids(rows)).toEqual([u1.id, expect.any(String)]);
    expect(ids(rows)).not.toContain(a1.id);
    expect(ids(rows)).not.toContain(tileB);
    expect(ids(rows)).not.toContain(tileC);
  });

  it('refuses a retry-all whose delete set holds a co-member message, rolling the settlement back', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    const coMemberId = crypto.randomUUID();
    // The re-parented shape: the co-member's reply keeps the lower sequence and
    // hangs below the fresh reply, so no ancestry walk from the highest-sequence
    // row ever reaches it. The route-time guard is bypassed entirely here — this
    // is the settlement's own re-assertion over the rows it is about to delete.
    const fresh = await insertGraftedMessage(fixture, u1.id, a1.sequenceNumber + 100_001);
    const victim = await insertGraftedMessage(fixture, fresh, a1.sequenceNumber + 100_000, {
      senderType: 'user',
      senderId: coMemberId,
    });

    const runId = crypto.randomUUID();
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          regenerate: { action: 'retry', targetMessageId: u1.id },
        })(tx, request('k-retry-all-cross-member'))
      ),
      ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER
    );

    const surviving = ids(await messagesInOrder(fixture.conversationId));
    expect(surviving).toEqual([u1.id, a1.id, victim, fresh]);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('refuses the edit variant of that same delete set', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    const coMemberId = crypto.randomUUID();
    const fresh = await insertGraftedMessage(fixture, u1.id, a1.sequenceNumber + 100_001);
    const victim = await insertGraftedMessage(fixture, fresh, a1.sequenceNumber + 100_000, {
      senderType: 'user',
      senderId: coMemberId,
    });

    const runId = crypto.randomUUID();
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          userMessage: { id: crypto.randomUUID(), content: 'edited' },
          regenerate: { action: 'edit', targetMessageId: u1.id },
        })(tx, request('k-edit-cross-member'))
      ),
      ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER
    );

    const surviving = ids(await messagesInOrder(fixture.conversationId));
    expect(surviving).toEqual([u1.id, a1.id, victim, fresh]);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('refuses a root-anchor edit whose anchor belongs to another member', async () => {
    const fixture = await seedFixture();
    const coMemberId = crypto.randomUUID();
    // A root anchor sits AT the deletion boundary, not above it, so it reaches
    // the delete as an appended id rather than through the sequence range. It is
    // judged all the same: the doomed set is derived once and nothing is added
    // to it afterwards.
    const foreignAnchor = await insertGraftedMessage(fixture, null, 100_000, {
      senderType: 'user',
      senderId: coMemberId,
    });

    const runId = crypto.randomUUID();
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          userMessage: { id: crypto.randomUUID(), content: 'edited' },
          regenerate: { action: 'edit', targetMessageId: foreignAnchor },
        })(tx, request('k-edit-foreign-root'))
      ),
      ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER
    );

    expect(ids(await messagesInOrder(fixture.conversationId))).toEqual([foreignAnchor]);
  });

  it("does not sweep a co-member message committed between the fence's read and its delete", async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    const anchor = u1;
    const doomedReply = a1;
    // Warmed here so the interloping write is contention by design rather than
    // a cold connection arriving late.
    await dbInterloper.execute(sql`select 1`);
    const coMemberId = crypto.randomUUID();
    let interloper: string | null = null;

    async function commitCoMemberMessage(): Promise<string> {
      const rows = await dbInterloper
        .insert(messages)
        .values({
          conversationId: fixture.conversationId,
          senderType: 'user',
          senderId: coMemberId,
          wrappedContentKey: BYTES,
          epochNumber: 1,
          sequenceNumber: doomedReply.sequenceNumber + 100_000,
          parentMessageId: anchor.id,
        })
        .returning({ id: messages.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('interloping message insert failed');
      return id;
    }

    // The co-member's message commits on another connection AFTER the fence has
    // read the rows it will judge, and above the deletion boundary. It is in no
    // version of the judged set — and it survives, which holds only because the
    // delete names the ids that read produced. A `DELETE … WHERE
    // sequence_number > $1` re-derived at this point would destroy it, unjudged.
    const interleavingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return {
        ...real,
        messages: {
          ...real.messages,
          // One interloping write, on the first read only: a case that read the
          // rows twice would otherwise seed a fresh row for the second read.
          senderChainRows: (conversationId: string) =>
            real.messages.senderChainRows(conversationId).andThen((rows) =>
              ResultAsync.fromSafePromise(
                (async () => {
                  interloper ??= await commitCoMemberMessage();
                  return rows;
                })()
              )
            ),
        },
      };
    };

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id },
        conversationsStores: interleavingConversationsStores,
      })(tx, request('k-retry-all-interleaved'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    expect(interloper).not.toBeNull();
    expect(ids(rows)).toContain(interloper);
    expect(rows.find((row) => row.id === interloper)?.parentMessageId).toBe(u1.id);
    // The caller's own reply, which WAS in the judged set, is gone.
    expect(ids(rows)).not.toContain(a1.id);
  });

  it('rolls the settlement back when the delete-set read fails', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');

    const faultingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return {
        ...real,
        messages: {
          ...real.messages,
          senderChainRows: () => errAsync(unavailableError('sender-chain read boom')),
        },
      };
    };

    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores(), {
          regenerate: { action: 'retry', targetMessageId: u1.id },
          conversationsStores: faultingConversationsStores,
        })(tx, request('k-sender-chain-fault'))
      )
    ).rejects.toThrow(/sender-chain read failed/);

    expect(ids(await messagesInOrder(fixture.conversationId))).toEqual([u1.id, a1.id]);
  });

  it('rolls back the delete when the regenerate persist throws (saved ⟺ billed)', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');

    const throwingStores: ChatStores = {
      ...createChatStores(),
      insertContentItemWithinTx: () => {
        throw new Error('regenerate persist boom');
      },
    };
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), throwingStores, {
          regenerate: { action: 'retry', targetMessageId: u1.id },
        })(tx, request('k-rollback'))
      )
    ).rejects.toThrow(/boom/);

    // The delete rolled back with the failed persist: the original reply survives.
    const surviving = ids(await messagesInOrder(fixture.conversationId));
    expect(surviving).toEqual([u1.id, a1.id]);
  });
});

describe('chat settlement commit (regenerate / edit — fork, cascade-aware tip)', () => {
  async function seedForkTip(
    fixture: Fixture
  ): Promise<{ forkId: string; forkUser: string; forkAssistant: string }> {
    const [, a1] = await seedTurns(fixture, 1);
    if (!a1) throw new Error('expected a seeded assistant');
    const forkId = await seedFork(fixture.conversationId, a1.id, 'Branch');
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), { forkId })(tx, request('k-fork'))
    );
    const rows = await messagesInOrder(fixture.conversationId);
    const forkAssistant = rows.at(-1);
    const forkUser = rows.at(-2);
    if (!forkAssistant || !forkUser) throw new Error('expected the fork turn messages');
    return { forkId, forkUser: forkUser.id, forkAssistant: forkAssistant.id };
  }

  it('rolls the whole settlement back when the fork parent-chain read fails (saved ⟺ billed)', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    const before = ids(await messagesInOrder(fixture.conversationId));

    // A fork retry-all computes its deletable tail from the parent chain; an
    // infra read failure there throws inside the settlement transaction, which
    // must roll the whole commit back — nothing deleted, nothing persisted.
    const faultingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return {
        ...real,
        messages: {
          ...real.messages,
          parentChainRows: () => errAsync(unavailableError('parent-chain read boom')),
        },
      };
    };

    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores(), {
          forkId,
          regenerate: {
            action: 'retry',
            targetMessageId: forkUser,
            observedForkTipId: forkAssistant,
          },
          conversationsStores: faultingConversationsStores,
        })(tx, request('k-fork-chain-fault'))
      )
    ).rejects.toThrow(/parent-chain read failed/);

    // The delete never committed: the exact prior message set survives.
    const after = ids(await messagesInOrder(fixture.conversationId));
    expect(after).toEqual(before);
    expect(after).toContain(forkAssistant);
  });

  it('retry-all deletes the fork tail and advances the tip off the nulled tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: {
          action: 'retry',
          targetMessageId: forkUser,
          observedForkTipId: forkAssistant,
        },
      })(tx, request('k-fork-retry'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).toContain(forkUser);
    expect(surviving).not.toContain(forkAssistant); // the old tip reply is gone
    const reply = rows.find((row) => row.parentMessageId === forkUser);
    // The cascade nulled the tip; the CAS advanced it to the fresh reply.
    expect(await forkTip(forkId)).toBe(reply?.id);
  });

  // The fork tail is cut from the tip-to-anchor chain the route-time guard
  // walked — but it is cut here, inside the transaction, from rows that guard
  // never saw. So the tail is judged by the delete's own predicate over the
  // exact ids about to go, and the guard is bypassed entirely in this case to
  // prove the settlement refuses on its own.
  it("refuses a fork retry-all whose tail holds a co-member's message", async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    const coMemberId = crypto.randomUUID();
    const victim = await insertGraftedMessage(fixture, forkAssistant, 100_000, {
      senderType: 'user',
      senderId: coMemberId,
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: victim })
      .where(eq(conversationForks.id, forkId));
    const before = ids(await messagesInOrder(fixture.conversationId));

    const runId = crypto.randomUUID();
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          forkId,
          regenerate: {
            action: 'retry',
            targetMessageId: forkUser,
            observedForkTipId: victim,
          },
        })(tx, request('k-fork-retry-cross-member'))
      ),
      ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER
    );

    expect(ids(await messagesInOrder(fixture.conversationId))).toEqual(before);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('retry-one advances the tip only when the replaced reply WAS the tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: {
          action: 'retry',
          targetMessageId: forkUser,
          replaceAssistantId: forkAssistant,
        },
      })(tx, request('k-fork-retry-one'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const reply = rows.find((row) => row.parentMessageId === forkUser && row.id !== forkAssistant);
    expect(reply).toBeDefined();
    expect(await forkTip(forkId)).toBe(reply?.id); // advanced (replaced WAS the tip)
    expect(ids(rows)).not.toContain(forkAssistant);
  });

  it('retry-one keeps the tip when the replaced reply was NOT the tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    // Graft a sibling reply and point the fork at it: the tip is now the sibling,
    // so replacing the ORIGINAL reply must not move the tip.
    const rowsBefore = await messagesInOrder(fixture.conversationId);
    const maxSeq = Math.max(...rowsBefore.map((row) => row.sequenceNumber));
    const sibling = await insertGraftedMessage(fixture, forkUser, maxSeq + 100_000);
    await db
      .update(conversationForks)
      .set({ tipMessageId: sibling })
      .where(eq(conversationForks.id, forkId));

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: {
          action: 'retry',
          targetMessageId: forkUser,
          replaceAssistantId: forkAssistant,
        },
      })(tx, request('k-fork-retry-one-nontip'))
    );

    // The tip stayed on the surviving sibling; the replaced reply is gone.
    expect(await forkTip(forkId)).toBe(sibling);
    expect(ids(await messagesInOrder(fixture.conversationId))).not.toContain(forkAssistant);
  });

  it('retry-one keeps the branch below the replaced reply reachable from the fork tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    // A co-member continued the branch under the reply about to be retried, so
    // the fork now tips below it. The branch view walks tip→root, so the
    // continuation is only visible while that walk still reaches the anchor.
    const rowsBefore = await messagesInOrder(fixture.conversationId);
    const maxSeq = Math.max(...rowsBefore.map((row) => row.sequenceNumber));
    const follower = await insertGraftedMessage(fixture, forkAssistant, maxSeq + 100_000, {
      senderType: 'user',
      senderId: crypto.randomUUID(),
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: follower })
      .where(eq(conversationForks.id, forkId));

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: {
          action: 'retry',
          targetMessageId: forkUser,
          replaceAssistantId: forkAssistant,
        },
      })(tx, request('k-fork-retry-one-reparent'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    expect(ids(rows)).not.toContain(forkAssistant);
    expect(await forkTip(forkId)).toBe(follower); // the replaced reply was not the tip
    const fresh = rows.find((row) => row.parentMessageId === forkUser);
    expect(rows.find((row) => row.id === follower)?.parentMessageId).toBe(fresh?.id);
  });

  it('retry-all on a bare fork tip (no reply to delete) advances the tip from the anchor', async () => {
    const fixture = await seedFixture();
    // A fork whose tip IS a user message with no reply below it: the tail is
    // empty, so the CAS expects the unchanged tip, not the cascade-null.
    const [, a1] = await seedTurns(fixture, 1);
    if (!a1) throw new Error('expected a seeded assistant');
    const forkId = await seedFork(fixture.conversationId, a1.id, 'Bare');
    // The fork tips at a1 (an assistant with no fork reply); regenerate-all from
    // a1 finds no tail below it.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: { action: 'retry', targetMessageId: a1.id, observedForkTipId: a1.id },
      })(tx, request('k-fork-bare'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const reply = rows.find((row) => row.parentMessageId === a1.id);
    expect(reply).toBeDefined();
    expect(await forkTip(forkId)).toBe(reply?.id);
  });

  it('edit of a root anchor on a fork deletes the anchor and re-roots the reply', async () => {
    const fixture = await seedFixture();
    // A fork tipping at the reply below a ROOT user message; editing that root
    // deletes the whole branch (tail + the root anchor) and re-roots the edit.
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    expect(u1.parentMessageId).toBeNull();
    const forkId = await seedFork(fixture.conversationId, a1.id, 'RootBranch');
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        userMessage: { id: editedId, content: 'edited root on fork' },
        regenerate: { action: 'edit', targetMessageId: u1.id, observedForkTipId: a1.id },
      })(tx, request('k-fork-edit-root'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).not.toContain(u1.id);
    expect(surviving).not.toContain(a1.id);
    const editedUser = rows.find((row) => row.id === editedId);
    expect(editedUser?.parentMessageId).toBeNull();
    expect(await forkTip(forkId)).toBe(rows.find((row) => row.parentMessageId === editedId)?.id);
  });

  it('edit on a fork deletes the tail and re-parents the new user message', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    const rowsBefore = await messagesInOrder(fixture.conversationId);
    const forkUserParent = rowsBefore.find((row) => row.id === forkUser)?.parentMessageId ?? null;
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        userMessage: { id: editedId, content: 'edited on fork' },
        regenerate: { action: 'edit', targetMessageId: forkUser, observedForkTipId: forkAssistant },
      })(tx, request('k-fork-edit'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).not.toContain(forkUser);
    expect(surviving).not.toContain(forkAssistant);
    const editedUser = rows.find((row) => row.id === editedId);
    expect(editedUser?.parentMessageId).toBe(forkUserParent);
    expect(await forkTip(forkId)).toBe(rows.find((row) => row.parentMessageId === editedId)?.id);
  });

  /** Seeds a message row with one content item under `parentId`; returns both ids. */
  async function seedBranchMessage(
    fixture: Fixture,
    parentId: string,
    sequenceNumber: number,
    sender: { readonly senderType: 'user' | 'assistant'; readonly senderId: string | null }
  ): Promise<{ readonly messageId: string; readonly contentItemId: string }> {
    const messageRows = await db
      .insert(messages)
      .values({
        conversationId: fixture.conversationId,
        senderType: sender.senderType,
        senderId: sender.senderId,
        wrappedContentKey: BYTES,
        epochNumber: 1,
        sequenceNumber,
        parentMessageId: parentId,
      })
      .returning({ id: messages.id });
    const messageId = messageRows[0]?.id;
    if (messageId === undefined) throw new Error('branch message seed failed');
    const contentRows = await db
      .insert(contentItems)
      .values({ messageId, contentType: 'text', position: 0, encryptedBlob: BYTES })
      .returning({ id: contentItems.id });
    const contentItemId = contentRows[0]?.id;
    if (contentItemId === undefined) throw new Error('branch content seed failed');
    return { messageId, contentItemId };
  }

  it('terminal-fails and deletes nothing when the live fork tip moved off the guard-observed tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    // A co-member appends a branch onto the fork's tip; the attacker then
    // repoints the fork tip onto that victim branch. The guard validated the
    // deletable tail against the OLD tip (`forkAssistant`); the delete would now
    // be computed from the MOVED tip and sweep the victim's messages.
    const rowsBefore = await messagesInOrder(fixture.conversationId);
    const maxSeq = Math.max(...rowsBefore.map((row) => row.sequenceNumber));
    const victimUser = await seedBranchMessage(fixture, forkAssistant, maxSeq + 1, {
      senderType: 'user',
      senderId: ASSISTANT_SENDER_ID,
    });
    const victimAssistant = await seedBranchMessage(fixture, victimUser.messageId, maxSeq + 2, {
      senderType: 'assistant',
      senderId: ASSISTANT_SENDER_ID,
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: victimAssistant.messageId })
      .where(eq(conversationForks.id, forkId));
    const ledgerBefore = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, fixture.walletId));

    const runId = crypto.randomUUID();
    // A co-member spliced the tip after the regenerate guard validated its tail
    // — an ordinary TOCTOU race → friendly FORK_TIP_CONFLICT, never INTERNAL.
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          forkId,
          regenerate: {
            action: 'retry',
            targetMessageId: forkUser,
            observedForkTipId: forkAssistant,
          },
        })(tx, request('k-fork-tip-moved'))
      ),
      ERROR_CODES.FORK_TIP_CONFLICT
    );

    // The victim's messages and content items survive; nothing new persisted.
    const surviving = ids(await messagesInOrder(fixture.conversationId));
    expect(surviving).toContain(victimUser.messageId);
    expect(surviving).toContain(victimAssistant.messageId);
    const survivingContent = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(inArray(contentItems.id, [victimUser.contentItemId, victimAssistant.contentItemId]));
    expect(survivingContent).toHaveLength(2);
    // No charge landed, no ledger legs, and the moved tip was NOT advanced.
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    const ledgerAfter = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, fixture.walletId));
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    expect(await forkTip(forkId)).toBe(victimAssistant.messageId);
  });

  it('terminal-fails when the observed tip is null but the live tip is a real message', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser } = await seedForkTip(fixture);

    const runId = crypto.randomUUID();
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          forkId,
          regenerate: { action: 'retry', targetMessageId: forkUser, observedForkTipId: null },
        })(tx, request('k-fork-observed-null'))
      )
    ).rejects.toThrow(/fork tip/i);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('settles a null-tipped fork retry-all when the observed tip is also null', async () => {
    const fixture = await seedFixture();
    const [, a1] = await seedTurns(fixture, 1);
    if (!a1) throw new Error('expected a seeded assistant');
    // A fresh fork with no tip yet: the guard observed a null tip, and the live
    // locked tip is null too — the null-safe assertion passes and it settles.
    const forkId = await seedFork(fixture.conversationId, null, 'FreshNull');

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        forkId,
        regenerate: { action: 'retry', targetMessageId: a1.id, observedForkTipId: null },
      })(tx, request('k-fork-both-null'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const reply = rows.find((row) => row.parentMessageId === a1.id);
    expect(reply).toBeDefined();
    expect(await forkTip(forkId)).toBe(reply?.id);
  });
});

function multiCharge(key: string, cost: bigint): SettlementCharge {
  return {
    key,
    modelId: `${key}-model`,
    providerName: PROVIDER_NAME,
    modality: 'text',
    generationId: `gen-${key}`,
    // Entries carry provider-scale figures; the port made them billable
    // upstream, so the charge carries the converted amount.
    billableCostNanoUsd: applyMarkup(cost),
    isEstimated: false,
  };
}

/**
 * A multi-model settlement request: one charge + one text output per selected
 * model that produced content. The interpreter surfaces each sibling node's
 * output keyed by its node id (the charge key), which the settlement pairs to
 * the assistant message it mints for that node.
 */
function multiRequest(
  runKey: string,
  entries: readonly { readonly key: string; readonly text: string; readonly cost: bigint }[]
): SettlementRequest {
  const outputs: Record<string, { readonly kind: 'text'; readonly text: string }> = {};
  for (const entry of entries) outputs[entry.key] = { kind: 'text', text: entry.text };
  return { runKey, outputs, charges: entries.map((entry) => multiCharge(entry.key, entry.cost)) };
}

/**
 * The same request with its `outputs` record re-keyed in the REVERSE of the
 * `charges` array order. A settlement request carries two orderings and no
 * completion signal at all, and in production both orderings are declaration
 * order — the interpreter applies concurrently-streamed siblings in declaration
 * order and builds `outputs` from the compiled node order. Aligned, they cannot
 * tell which one a persist path read; reversing one is what makes an assertion
 * over sibling order falsifiable.
 */
function withReversedOutputKeys(base: SettlementRequest): SettlementRequest {
  const outputs: Record<string, ContentValue> = {};
  for (const charge of base.charges.toReversed()) {
    const output = base.outputs[charge.key];
    if (output === undefined) throw new Error(`expected an output for charge ${charge.key}`);
    outputs[charge.key] = output;
  }
  return { ...base, outputs };
}

/**
 * The reasoning level persisted per content item, read the way the history join
 * reads it: usage records anchored to the item, joined to their completion rows.
 */
async function reasoningEffortsByContentItem(
  contentItemIds: readonly string[]
): Promise<Map<string, (string | null)[]>> {
  const rows = await db
    .select({
      contentItemId: usageRecords.contentItemId,
      reasoningEffort: llmCompletions.reasoningEffort,
    })
    .from(usageRecords)
    .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
    .where(inArray(usageRecords.contentItemId, [...contentItemIds]));
  const byItem = new Map<string, (string | null)[]>();
  for (const row of rows) {
    if (row.contentItemId === null) continue;
    byItem.set(row.contentItemId, [...(byItem.get(row.contentItemId) ?? []), row.reasoningEffort]);
  }
  return byItem;
}

describe('chat settlement commit (the level each generation ran at)', () => {
  it("records each sibling's own resolved level against its own persisted answer", async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const entries = [
      { key: 'answer0', text: 'from-model-a', cost: 100n },
      { key: 'answer1', text: 'from-model-b', cost: 200n },
    ] as const;
    const base = multiRequest('effort-siblings', entries);
    // One turn-level choice, two ladders: the second sibling could not reach
    // High and runs at Low, and its own answer is what says so.
    const levels = ['high', 'low'] as const;
    const request: SettlementRequest = {
      ...base,
      charges: base.charges.map((charge, index) => ({
        ...charge,
        tokens: { inputTokens: 1, outputTokens: 1, reasoningTokens: 9, cachedInputTokens: 0 },
        ...(levels[index] === undefined ? {} : { reasoningEffort: levels[index] }),
      })),
    };

    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(tx, request)
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const siblings = rows.filter((row) => row.senderType === 'assistant');
    const siblingIds = siblings.map((row) => row.id);
    const items = await db
      .select({ id: contentItems.id, messageId: contentItems.messageId })
      .from(contentItems)
      .where(inArray(contentItems.messageId, siblingIds))
      .orderBy(asc(contentItems.id));
    const byItem = await reasoningEffortsByContentItem(items.map((item) => item.id));
    const persisted = siblings.map(
      (sibling) =>
        byItem.get(items.find((item) => item.messageId === sibling.id)?.id ?? '')?.[0] ?? null
    );
    expect(persisted).toEqual(['high', 'low']);
  });

  it('gives every persisted assistant text answer a completion row to read', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const entries = [
      { key: 'answer0', text: 'from-model-a', cost: 100n },
      { key: 'answer1', text: 'from-model-b', cost: 200n },
    ] as const;
    const base = multiRequest('effort-totality', entries);
    // Neither sibling reported usage and neither reasoned — the weakest case
    // for the record existing at all.
    const request: SettlementRequest = { ...base, charges: base.charges };

    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(tx, request)
    );

    const settled = await messagesInOrder(fixture.conversationId);
    const assistantIds = settled
      .filter((row) => row.senderType === 'assistant')
      .map((row) => row.id);
    const items = await db
      .select({ id: contentItems.id, contentType: contentItems.contentType })
      .from(contentItems)
      .where(inArray(contentItems.messageId, assistantIds));
    const textItems = items.filter((item) => item.contentType === 'text');
    expect(textItems.length).toBe(2);
    const byItem = await reasoningEffortsByContentItem(textItems.map((item) => item.id));
    for (const item of textItems) {
      expect(byItem.get(item.id)).toEqual([null]);
    }
  });
});

describe('chat settlement commit (multi-model siblings)', () => {
  it('persists one assistant sibling per charge under one user message, batched and consecutive', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const entries = [
      { key: 'answer0', text: 'from-model-a', cost: 100n },
      { key: 'answer1', text: 'from-model-b', cost: 200n },
      { key: 'answer2', text: 'from-model-c', cost: 300n },
    ] as const;

    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      })(tx, multiRequest('mk', entries))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    // One user message + one assistant sibling per model.
    expect(rows).toHaveLength(4);
    const [user, ...siblings] = rows;
    if (!user || siblings.length !== 3)
      throw new Error('expected a user message and three siblings');
    expect(user.id).toBe(userMessageId);
    expect(user.senderType).toBe('user');

    for (const [index, sibling] of siblings.entries()) {
      // Every sibling is an assistant reply chained onto the ONE user message,
      // sharing the turn's batch id, at the next consecutive sequence.
      expect(sibling.senderType).toBe('assistant');
      expect(sibling.senderId).toBe(ASSISTANT_SENDER_ID);
      expect(sibling.parentMessageId).toBe(user.id);
      expect(sibling.batchId).toBe(user.batchId);
      expect(sibling.sequenceNumber).toBe(user.sequenceNumber + 1 + index);
    }
    // Distinct message ids — each model's answer is independently addressable.
    expect(new Set(ids(siblings)).size).toBe(3);

    // One usage record per successful model, summing the three charged costs.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(3);
    const debitByModel = new Map(usage.map((row) => [row.modelId, row.costNanoUsd]));

    // Each sibling carries exactly its own model's content, and its displayed cost
    // EQUALS the wallet debit that generation posted (marked-up model cost plus its
    // own storage fee — the primary sibling additionally bears the shared prompt).
    for (const [index, sibling] of siblings.entries()) {
      const entry = entries[index];
      if (entry === undefined) throw new Error('missing entry');
      const content = first(
        await db.select().from(contentItems).where(eq(contentItems.messageId, sibling.id)),
        'sibling content'
      );
      expect(content.modelId).toBe(`${entry.key}-model`);
      expect(content.costNanoUsd).toBe(debitByModel.get(`${entry.key}-model`));
    }
    const totalBilled = usage.reduce((sum, row) => sum + row.costNanoUsd, 0n);
    // Storage fee: the shared prompt is stored once (on the primary charge) plus
    // each surviving sibling's own response text — never marked up.
    const multiStorageFee =
      BigInt(
        PROMPT.length + 'from-model-a'.length + 'from-model-b'.length + 'from-model-c'.length
      ) * STORAGE_COST_PER_CHARACTER_NANO;
    expect(totalBilled).toBe(
      applyMarkup(100n) + applyMarkup(200n) + applyMarkup(300n) + multiStorageFee
    );

    // Every charge's ledger legs are double-entry and sum to zero.
    for (const record of usage) {
      const legs = await db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.usageRecordId, record.id));
      expect(legs).toHaveLength(2);
      expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    }
  });

  it('persists and bills only the successful subset when a model produced no charge', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // Model B failed: it surfaced no charge (and no output), so only two of the
    // three selected models appear in the settlement request.
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(
        tx,
        multiRequest('mk', [
          { key: 'answer0', text: 'from-model-a', cost: 100n },
          { key: 'answer2', text: 'from-model-c', cost: 300n },
        ])
      )
    );

    const rows = await messagesInOrder(fixture.conversationId);
    // Only the two successful models produced a message; the failed one did not.
    expect(rows.filter((row) => row.senderType === 'assistant')).toHaveLength(2);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(2);
    // Storage fee: shared prompt once plus the two surviving siblings' responses.
    const survivingStorageFee =
      BigInt(PROMPT.length + 'from-model-a'.length + 'from-model-c'.length) *
      STORAGE_COST_PER_CHARACTER_NANO;
    expect(usage.reduce((sum, row) => sum + row.costNanoUsd, 0n)).toBe(
      applyMarkup(100n) + applyMarkup(300n) + survivingStorageFee
    );
  });

  it('advances a fork tip to the last-declared sibling, output-record order aside', async () => {
    const fixture = await seedFixture();
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k-seed'))
    );
    const seeded = await messagesInOrder(fixture.conversationId);
    const priorAssistant = seeded.at(-1);
    if (!priorAssistant) throw new Error('expected a seeded assistant tip');
    const forkId = await seedFork(fixture.conversationId, priorAssistant.id, 'Branch');

    const entries = [
      { key: 'answer0', text: 'a0', cost: 100n },
      { key: 'answer1', text: 'a1', cost: 200n },
    ] as const;
    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { forkId })(
        tx,
        // `outputs` is keyed last-declared-first, so the two orderings the
        // request carries disagree: a tip read off output-record order would be
        // the FIRST-declared sibling, and this test would go red.
        withReversedOutputKeys(multiRequest('mk-fork', entries))
      )
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const siblings = rows.filter(
      (row) => row.senderType === 'assistant' && row.id !== priorAssistant.id
    );
    expect(siblings).toHaveLength(2);

    // Name the expected tip by CHARGE KEY rather than by position: each sibling's
    // content item records the model its charge key minted, so the last-declared
    // charge identifies its message without restating the order under test.
    const lastDeclared = entries.at(-1);
    if (!lastDeclared) throw new Error('expected a last-declared entry');
    const lastDeclaredContent = first(
      await db
        .select()
        .from(contentItems)
        .where(
          and(
            inArray(contentItems.messageId, ids(siblings)),
            eq(contentItems.modelId, `${lastDeclared.key}-model`)
          )
        ),
      'last-declared sibling content'
    );
    // Siblings persist in charge-array order, so the last-declared sibling is
    // also the last-persisted row — the batch's own tail.
    expect(lastDeclaredContent.messageId).toBe(siblings.at(-1)?.id);
    // The whole batch is the new tip, and it is the last-DECLARED sibling that
    // carries it, so a subsequent send chains onto that reply.
    expect(await forkTip(forkId)).toBe(lastDeclaredContent.messageId);
  });

  it('regenerates one sibling of a multi-model batch, leaving the others intact', async () => {
    const fixture = await seedFixture();
    const userMessageId = crypto.randomUUID();
    // Persist a 3-model batch: one user message, three sibling replies chained
    // onto it, each with a distinct id.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      })(
        tx,
        multiRequest('batch', [
          { key: 'answer0', text: 'a0', cost: 100n },
          { key: 'answer1', text: 'a1', cost: 200n },
          { key: 'answer2', text: 'a2', cost: 300n },
        ])
      )
    );
    const batch = await messagesInOrder(fixture.conversationId);
    const siblings = batch.filter((row) => row.senderType === 'assistant');
    const [first, target, last] = siblings;
    if (!first || !target || !last) throw new Error('expected three siblings');

    // Retry-one targets exactly that sibling: it keeps the user message anchor,
    // deletes only the named sibling, and persists a fresh single reply onto it.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
        regenerate: {
          action: 'retry',
          targetMessageId: userMessageId,
          replaceAssistantId: target.id,
        },
      })(tx, request('regen'))
    );

    const after = await messagesInOrder(fixture.conversationId);
    const afterIds = new Set(ids(after));
    // The targeted sibling is gone; the other two are untouched.
    expect(afterIds.has(target.id)).toBe(false);
    expect(afterIds.has(first.id)).toBe(true);
    expect(afterIds.has(last.id)).toBe(true);
    // A fresh reply took its place, chained onto the same user message — so the
    // batch still has three sibling replies under the one user message.
    const replies = after.filter(
      (row) => row.senderType === 'assistant' && row.parentMessageId === userMessageId
    );
    expect(replies).toHaveLength(3);
    expect(replies.some((reply) => reply.id === target.id)).toBe(false);
  });
});

/**
 * A fixture whose payer and sender are different people: the owner pays, the
 * member sends, and `sender` carries the member the way a run identity does.
 */
type GroupFixture = Fixture & { readonly sender: SenderPrincipal };

/** A fixture that may or may not split payer from sender (a solo turn does not). */
type MaybeGroupFixture = Fixture & { readonly sender?: SenderPrincipal };

describe('group-budget accrual (owner-funded, cumulative)', () => {
  const stores = createBillingStores();
  // The full charged amount for a single-model turn (marked-up model cost + the
  // additive prompt+answer storage fee) — the exact value both the member and
  // conversation spend rows accrue.
  const perTurnCharge = applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE;

  /**
   * A GROUP turn fixture: a distinct owner (the payer, with the wallet) and a
   * distinct member who sends, whom the owner funds. The returned fixture binds
   * `userId` AND `walletId` to the OWNER — the payer is by definition the owner
   * of the wallet the turn debits — while the sending member rides `sender`.
   * That is the shape the route freezes onto an owner-funded run; a payer who is
   * not the debited wallet's owner is not a state the system can reach.
   */
  async function seedGroupFixture(options: {
    readonly conversationBudgetNanoUsd: bigint;
    readonly memberBudgetNanoUsd?: bigint;
  }): Promise<GroupFixture> {
    const owner = await seedFixture();
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: options.conversationBudgetNanoUsd })
      .where(eq(conversations.id, owner.conversationId));
    const senderId = await insertTestUser();
    const memberRows = await db
      .insert(conversationMembers)
      .values({ conversationId: owner.conversationId, userId: senderId, visibleFromEpoch: 1 })
      .returning({ id: conversationMembers.id });
    const memberId = first(memberRows, 'member').id;
    if (options.memberBudgetNanoUsd !== undefined) {
      await db.insert(memberBudgets).values({
        memberId,
        budgetNanoUsd: options.memberBudgetNanoUsd,
        spentNanoUsd: 0n,
      });
    }
    return {
      userId: owner.userId,
      walletId: owner.walletId,
      conversationId: owner.conversationId,
      memberId,
      epochPrivateKey: owner.epochPrivateKey,
      epochPublicKey: owner.epochPublicKey,
      sender: { kind: 'user', userId: senderId },
    };
  }

  async function memberBudgetRow(
    memberId: string
  ): Promise<Pick<typeof memberBudgets.$inferSelect, 'budgetNanoUsd' | 'spentNanoUsd'> | null> {
    const rows = await db
      .select({
        budgetNanoUsd: memberBudgets.budgetNanoUsd,
        spentNanoUsd: memberBudgets.spentNanoUsd,
      })
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, memberId));
    return rows[0] ?? null;
  }

  async function conversationSpendingRow(
    conversationId: string
  ): Promise<Pick<typeof conversationSpending.$inferSelect, 'spentNanoUsd'> | null> {
    const rows = await db
      .select({ spentNanoUsd: conversationSpending.spentNanoUsd })
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, conversationId));
    return rows[0] ?? null;
  }

  /** The payer/sender identity triple every charge of a run recorded. */
  async function runUsageSenders(
    runId: string
  ): Promise<
    Pick<typeof usageRecords.$inferSelect, 'payerUserId' | 'senderUserId' | 'senderLinkId'>[]
  > {
    return db
      .select({
        payerUserId: usageRecords.payerUserId,
        senderUserId: usageRecords.senderUserId,
        senderLinkId: usageRecords.senderLinkId,
      })
      .from(usageRecords)
      .where(eq(usageRecords.runId, runId));
  }

  async function runUsageTotal(runId: string): Promise<bigint> {
    const rows = await db
      .select({ cost: usageRecords.costNanoUsd })
      .from(usageRecords)
      .where(eq(usageRecords.runId, runId));
    return rows.reduce((sum, row) => sum + row.cost, 0n);
  }

  async function settleTurn(
    fixture: MaybeGroupFixture,
    req: SettlementRequest,
    ownerFunded = true
  ): Promise<string> {
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, req.runKey, runId);
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
        ownerFunded,
        ...(fixture.sender === undefined ? {} : { sender: fixture.sender }),
      }),
    });
    await hook(req);
    return runId;
  }

  it('accrues the charge cumulatively to the member and conversation rows (no period) and preserves the owner-set cap', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 5_000_000n,
      memberBudgetNanoUsd: 1_000_000n,
    });
    await settleTurn(fixture, request(crypto.randomUUID()));

    const member = await memberBudgetRow(fixture.memberId);
    // A spend never clobbers the owner-set cap — the ON CONFLICT path touches
    // only spent.
    expect(member?.budgetNanoUsd).toBe(1_000_000n);
    expect(member?.spentNanoUsd).toBe(perTurnCharge);
    const conversation = await conversationSpendingRow(fixture.conversationId);
    expect(conversation?.spentNanoUsd).toBe(perTurnCharge);
  });

  it('creates the member row with the zero insert-default cap when none was pre-configured (insert path)', async () => {
    const fixture = await seedGroupFixture({ conversationBudgetNanoUsd: 5_000_000n });
    await settleTurn(fixture, request(crypto.randomUUID()));

    const member = await memberBudgetRow(fixture.memberId);
    // The insert-path cap is the zero insert-default 0 — never the permissive
    // conversation budget.
    expect(member?.budgetNanoUsd).toBe(0n);
    expect(member?.spentNanoUsd).toBe(perTurnCharge);
  });

  it('accumulates across successive turns so the admission read refuses once the per-member cap is reached', async () => {
    // Cap = two turns' charge + 700n headroom; two turns consume it down to 700n,
    // so a third turn estimated above 700n is refused by the per-member scope
    // (owner balance and conversation cap are both ample).
    const cap = perTurnCharge * 2n + 700n;
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: perTurnCharge * 10n,
      memberBudgetNanoUsd: cap,
    });
    await settleTurn(fixture, request(crypto.randomUUID()));
    await settleTurn(fixture, request(crypto.randomUUID()));

    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(perTurnCharge * 2n);
    // The cap is unchanged after the accruals — read back from the durable row,
    // never re-derived from the conversation budget.
    expect(member?.budgetNanoUsd).toBe(cap);

    // The production admission read: BOTH group scopes, cap read from the durable
    // member row (no cap argument), then gate the next run.
    const scopesResult = await resolveBudgetScopes(stores, db, {
      now: NOW,
      memberBudget: { memberId: fixture.memberId },
      conversationBudget: {
        conversationId: fixture.conversationId,
        capNanoUsd: perTurnCharge * 10n,
      },
    });
    const scopes = scopesResult._unsafeUnwrap();
    const memberScope = scopes.find((scope) => scope.kind === 'member');
    expect(memberScope?.remainingNanoUsd).toBe(700n);

    const admissionDeps = { redis, db, stores };
    const overResult = await admitRun(admissionDeps, {
      walletId: fixture.walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: 1000n,
      deadlineClass: 'text',
      concurrentRunCap: 10,
      budgets: scopes,
      now: NOW,
    });
    expect(overResult._unsafeUnwrap()).toEqual({
      admitted: false,
      reason: 'member-budget-exceeded',
    });

    const withinResult = await admitRun(admissionDeps, {
      walletId: fixture.walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: 500n,
      deadlineClass: 'text',
      concurrentRunCap: 10,
      budgets: scopes,
      now: NOW,
    });
    expect(withinResult._unsafeUnwrap().admitted).toBe(true);
  });

  it('writes no member or conversation spend for an owner-initiated (solo) turn', async () => {
    // Owner == sender: the owner funds and is not member-capped, so no group
    // spend is written (the owner path is personal).
    const fixture = await seedFixture();
    await settleTurn(fixture, request(crypto.randomUUID()));
    expect(await memberBudgetRow(fixture.memberId)).toBeNull();
    expect(await conversationSpendingRow(fixture.conversationId)).toBeNull();
  });

  it("never moves an owner's own member budget spend on an owner-initiated (solo) turn", async () => {
    // An owner holds a membership row like anyone else, so a cap row CAN exist
    // against it: the solo skip has to hold on the accrual (UPDATE) path, not
    // only by leaving a row uncreated. Drifted, the owner would spend down their
    // own cap — here one turn's charge — and admission would then refuse them
    // from their own conversation.
    const fixture = await seedFixture();
    await db
      .insert(memberBudgets)
      .values({ memberId: fixture.memberId, budgetNanoUsd: perTurnCharge, spentNanoUsd: 0n });

    await settleTurn(fixture, request(crypto.randomUUID()));

    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(0n);
  });

  /**
   * A PERSONAL fall-through group fixture: a distinct owner (conversation +
   * epoch) and a distinct member SENDER who has their OWN purchased wallet and
   * pays for themselves. `walletId` binds to the SENDER's wallet (not the
   * owner's) — exactly the payer the route freezes when the group headroom fell
   * to ≤ 0, so settlement is told "personal" and accrues no group spend.
   */
  async function seedPersonalGroupFixture(): Promise<Fixture> {
    const owner = await seedFixture();
    const senderId = await insertTestUser();
    const senderWalletRows = await db
      .insert(wallets)
      .values({ userId: senderId, type: 'purchased', balanceNanoUsd: 10_000_000n })
      .returning({ id: wallets.id });
    const senderWalletId = first(senderWalletRows, 'sender wallet').id;
    const memberRows = await db
      .insert(conversationMembers)
      .values({ conversationId: owner.conversationId, userId: senderId, visibleFromEpoch: 1 })
      .returning({ id: conversationMembers.id });
    const memberId = first(memberRows, 'member').id;
    return {
      userId: senderId,
      walletId: senderWalletId,
      conversationId: owner.conversationId,
      memberId,
      epochPrivateKey: owner.epochPrivateKey,
      epochPublicKey: owner.epochPublicKey,
    };
  }

  it('self-funds a group turn on the sender own wallet and writes NO group spend (personal fall-through)', async () => {
    // The payer is the SENDER's own wallet (route fell through: group headroom
    // ≤ 0). Settlement is told "personal", so the charge hits the sender's
    // wallet and neither the member nor the conversation spend row moves.
    const fixture = await seedPersonalGroupFixture();
    const runId = await settleTurn(fixture, request(crypto.randomUUID()), false);

    expect(await runUsageTotal(runId)).toBe(perTurnCharge);
    // No group attribution: the (absent) member row stays absent and the
    // conversation spend row is never written.
    expect(await memberBudgetRow(fixture.memberId)).toBeNull();
    expect(await conversationSpendingRow(fixture.conversationId)).toBeNull();
    // The charge landed on the sender's OWN wallet (the personal payer).
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, fixture.walletId));
    expect(legs.length).toBeGreaterThan(0);
  });

  it('attributes a multi-model turn as the sum of its siblings under one member row and one conversation row', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 10_000_000n,
      memberBudgetNanoUsd: 10_000_000n,
    });
    const runId = await settleTurn(fixture, multiModelRequest(crypto.randomUUID(), 1000n, 2000n));
    const total = await runUsageTotal(runId);

    // Attributed once per generation, never double-counted: the durable member
    // and conversation rows each hold the run's full charged sum.
    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(total);
    const conversation = await conversationSpendingRow(fixture.conversationId);
    expect(conversation?.spentNanoUsd).toBe(total);
    // The sum exceeds the bare marked-up model costs (storage rides along).
    expect(total).toBeGreaterThan(applyMarkup(1000n) + applyMarkup(2000n));
  });

  it('writes no member spend when the settlement transaction rolls back (saved ⟺ billed)', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 5_000_000n,
      memberBudgetNanoUsd: 1_000_000n,
    });
    const runId = crypto.randomUUID();
    const runKey = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    // A persist failure throws inside the settlement transaction, rolling the
    // whole commit back — no message, no charge, and no member spend accrual.
    const boomStores: ChatStores = {
      ...createChatStores(),
      insertMessageWithinTx: () => Promise.reject(new Error('persist boom')),
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, boomStores, {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
        ownerFunded: true,
        sender: fixture.sender,
      }),
    });
    await expect(hook(request(runKey))).rejects.toThrow(/persist boom/);
    // The pre-seeded row still exists but its spend never moved off zero.
    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(0n);
    expect(await conversationSpendingRow(fixture.conversationId)).toBeNull();
  });

  it('rolls the whole settlement back when the group-attribution read fails', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 5_000_000n,
      memberBudgetNanoUsd: 1_000_000n,
    });
    const runId = crypto.randomUUID();
    const runKey = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    // The conversation read for group attribution runs inside the settlement
    // transaction; an infra failure there throws and rolls the whole commit back
    // — nothing persisted, nothing charged, no spend moved.
    const faultingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return {
        ...real,
        conversations: {
          ...real.conversations,
          get: () => errAsync(unavailableError('member-budget read boom')),
        },
      };
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
        ownerFunded: true,
        sender: fixture.sender,
        conversationsStores: faultingConversationsStores,
      }),
    });
    await expect(hook(request(runKey))).rejects.toThrow(/member-budget read failed/);
    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(0n);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('owner-funds a link-guest turn: charges the OWNER, records the guest as sender, accrues member spend', async () => {
    const owner = await seedFixture();
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 5_000_000n })
      .where(eq(conversations.id, owner.conversationId));
    // The shared link, its WRITE guest member, and the guest key in epoch 1's
    // authoritative wrap-set (what the member-keyed epoch gate verifies).
    const { linkPublicKey: linkKey, linkAuthHash } = mintLinkCredential();
    const linkRows = await db
      .insert(sharedLinks)
      .values({
        conversationId: owner.conversationId,
        linkPublicKey: linkKey,
        linkAuthHash,
        displayName: 'Guest',
      })
      .returning({ id: sharedLinks.id });
    const linkId = first(linkRows, 'shared link').id;
    const guestMemberRows = await db
      .insert(conversationMembers)
      .values({
        conversationId: owner.conversationId,
        linkId,
        privilege: 'write',
        visibleFromEpoch: 1,
      })
      .returning({ id: conversationMembers.id });
    const guestMemberId = first(guestMemberRows, 'guest member').id;
    await db
      .insert(memberBudgets)
      .values({ memberId: guestMemberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });
    const epochRows = await db
      .select({ id: epochs.id })
      .from(epochs)
      .where(and(eq(epochs.conversationId, owner.conversationId), eq(epochs.epochNumber, 1)));
    await db.insert(epochMembers).values({
      epochId: first(epochRows, 'epoch').id,
      memberPublicKey: linkKey,
      wrap: BYTES,
      visibleFromEpoch: 1,
    });

    const runId = crypto.randomUUID();
    const fence = await claimFence(owner.userId, 'guest-run', runId);
    const userMessageId = crypto.randomUUID();
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      // The OWNER pays (identity.payerUserId + walletId), the guest is the sender.
      commit: commitFor(owner, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
        sender: { kind: 'linkGuest', linkId },
        ownerFunded: true,
      }),
    });
    await hook(request('guest-run'));

    // The user message records the GUEST (linkId) as sender, and its content
    // decrypts with the guest bound as the AAD sender.
    const userRows = await db
      .select({
        id: messages.id,
        senderId: messages.senderId,
        wrappedContentKey: messages.wrappedContentKey,
      })
      .from(messages)
      .where(
        and(eq(messages.conversationId, owner.conversationId), eq(messages.senderType, 'user'))
      );
    const userMsg = first(userRows, 'user message');
    expect(userMsg.senderId).toBe(linkId);
    const userContentRows = await db
      .select({ id: contentItems.id, encryptedBlob: contentItems.encryptedBlob })
      .from(contentItems)
      .where(eq(contentItems.messageId, userMsg.id));
    expect(decryptItem(owner, userMsg, first(userContentRows, 'user content'), linkId)).toBe(
      PROMPT
    );

    // The OWNER's wallet is charged (the guest holds none).
    const ownerWalletRows = await db
      .select({ balance: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.id, owner.walletId));
    expect(first(ownerWalletRows, 'owner wallet').balance).toBe(10_000_000n - perTurnCharge);
    // Per-member and per-conversation spend accrue to the GUEST's member row.
    const guestMember = await memberBudgetRow(guestMemberId);
    expect(guestMember?.spentNanoUsd).toBe(perTurnCharge);
    const conversationSpend = await conversationSpendingRow(owner.conversationId);
    expect(conversationSpend?.spentNanoUsd).toBe(perTurnCharge);

    // Payer and sender are first-class and independent on the billed row: the
    // guest rides the link column (it has no users row), the owner the payer
    // column — recoverable without the batchId → messages join.
    const usage = await runUsageSenders(runId);
    expect(usage).toEqual([
      { payerUserId: owner.userId, senderUserId: null, senderLinkId: linkId },
    ]);
  });

  it('stamps the sender from identity.sender even when it differs from the attributed userId', async () => {
    const owner = await seedFixture();
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 5_000_000n })
      .where(eq(conversations.id, owner.conversationId));
    const memberUserId = await insertTestUser();
    // The member's own key is the one wrapped: a wrap no live seat holds would
    // leave the epoch pending, and settlement would refuse the turn.
    await seatCurrentEpochHolder(db, {
      conversationId: owner.conversationId,
      userId: memberUserId,
    });

    const runId = crypto.randomUUID();
    const fence = await claimFence(owner.userId, 'member-run', runId);
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      // Deliberately column-independent: identity.payerUserId is the OWNER
      // while the member sends, so senderUserId cannot be a copy of the payer —
      // it has to be threaded from identity.sender.
      commit: commitFor(owner, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
        sender: { kind: 'user', userId: memberUserId },
        ownerFunded: true,
      }),
    });
    await hook(request('member-run'));

    expect(await runUsageSenders(runId)).toEqual([
      { payerUserId: owner.userId, senderUserId: memberUserId, senderLinkId: null },
    ]);
  });

  it('self-funds a solo turn: records the same principal as both payer and sender', async () => {
    const fixture = await seedFixture();
    const runId = await settleTurn(fixture, request(crypto.randomUUID()), false);

    expect(await runUsageSenders(runId)).toEqual([
      { payerUserId: fixture.userId, senderUserId: fixture.userId, senderLinkId: null },
    ]);
  });
});

describe('chat settlement commit (display-cost mirror invariant)', () => {
  // The denormalized display column (`content_items.cost_nano_usd`) must, per
  // run, sum to the exact total the debit path posts (`usage_records`), for every
  // turn shape. This closes the sole weakness of a denormalized mirror — drift:
  // a forgotten or mis-anchored charge type would break this invariant.
  async function sumAssistantDisplayCost(conversationId: string): Promise<bigint> {
    const rows = await db
      .select({ cost: contentItems.costNanoUsd })
      .from(contentItems)
      .innerJoin(messages, eq(contentItems.messageId, messages.id))
      .where(eq(messages.conversationId, conversationId));
    return rows.reduce((sum, row) => sum + (row.cost ?? 0n), 0n);
  }

  async function sumRunDebit(runId: string): Promise<bigint> {
    const rows = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    return rows.reduce((sum, row) => sum + row.costNanoUsd, 0n);
  }

  async function settleAndAssertInvariant(req: SettlementRequest): Promise<void> {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(tx, req)
    );
    expect(await sumAssistantDisplayCost(fixture.conversationId)).toBe(await sumRunDebit(runId));
  }

  it('mirrors the debit total for a single-model turn', async () => {
    await settleAndAssertInvariant(request('inv-single'));
  });

  it('mirrors the debit total for an agentic pre-summed turn', async () => {
    // Agentic multi-step / web search settles as ONE pre-summed charge — the same
    // settlement shape as a single-model turn, at a distinct cost.
    await settleAndAssertInvariant({
      runKey: 'inv-agentic',
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [{ ...charge(), billableCostNanoUsd: applyMarkup(4242n) }],
    });
  });

  it('mirrors the debit total for a multi-model fan-out turn', async () => {
    await settleAndAssertInvariant(multiModelRequest('inv-multi', 111n, 222n));
  });

  it('mirrors the debit total for a Smart Model turn', async () => {
    await settleAndAssertInvariant({
      runKey: 'inv-smart',
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [
        charge(),
        {
          key: 'answer#classifier',
          modelId: 'chat-settle/classifier',
          providerName: PROVIDER_NAME,
          modality: 'text',
          generationId: 'gen-inv-cls',
          billableCostNanoUsd: applyMarkup(77n),
          isEstimated: false,
        },
      ],
    });
  });

  it("anchors a consumed generation's charge to the run's content, display and debit together", async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // A text answer plus a charge whose generation surfaced no run output of its
    // own, because its value was CONSUMED by a later node rather than being a
    // sink — the turn's classifier is the same class. Settlement anchors it to
    // the run's content, moving display and debit by the same amount.
    //
    // What makes that safe is NOT anything settlement can see: a charge reaching
    // here always names a generation whose value COMMITTED, because the
    // interpreter charges after the commit and only on success. A generation
    // whose output failed validation therefore never arrives, and its spend is
    // absorbed — pinned in `interpreter.test.ts` ("bills nothing for a sibling
    // whose value failed output validation"). The answer item is still not a
    // Smart Model turn.
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(tx, {
        runKey: 'inv-orphan',
        outputs: {
          answer: { kind: 'text', text: ANSWER },
        },
        charges: [
          charge(),
          {
            key: 'media',
            modelId: 'chat-settle/media',
            providerName: PROVIDER_NAME,
            modality: 'image',
            generationId: 'gen-media',
            billableCostNanoUsd: applyMarkup(500n),
            isEstimated: false,
          },
        ],
      })
    );
    const rows = await messagesInOrder(fixture.conversationId);
    const assistant = rows.find((row) => row.senderType === 'assistant');
    if (!assistant) throw new Error('expected an assistant message');
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistant.id)),
      'assistant content'
    );
    // Both charges land on the one persisted item, so display equals debit.
    const total = applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE + applyMarkup(500n);
    expect(content.costNanoUsd).toBe(total);
    expect(content.isSmartModel).toBe(false);
    expect(await sumRunDebit(runId)).toBe(total);
  });
});

const MEDIA_MODEL_ID = 'chat-settle/media-model';
const MEDIA_BYTES = 4096;
/** The additive storage fee for a single-charge media turn: prompt chars + ciphertext bytes. */
const MEDIA_TURN_STORAGE = (byteLength: number): bigint =>
  BigInt(PROMPT.length) * STORAGE_COST_PER_CHARACTER_NANO +
  BigInt(byteLength) * MEDIA_STORAGE_COST_PER_BYTE_NANO;

/** One media generation's settlement triple: pre-minted plan, charge, and final output. */
interface MediaTurnPiece {
  readonly plan: MediaPersistPlan;
  readonly charge: SettlementCharge;
  readonly output: Extract<ContentValue, { kind: 'media' }>;
}

function mediaTurn(
  fixture: Fixture,
  key: string,
  options: {
    readonly modality?: 'image' | 'video';
    /** The MediaValue's own modality when it must diverge from the charge's. */
    readonly valueModality?: 'image' | 'video' | 'audio';
    readonly isEstimated?: boolean;
    readonly billableCostNanoUsd?: bigint;
    readonly byteLength?: number;
    readonly metadata?: Record<string, unknown>;
  } = {}
): MediaTurnPiece {
  const assistantMessageId = crypto.randomUUID();
  const contentItemId = crypto.randomUUID();
  // The plan's key was wrapped to epoch 1 at run start, exactly as the media
  // mint does — settlement persists it verbatim, never re-wrapping.
  const wrappedContentKey = wrapContentKeyToEpoch(fixture.epochPublicKey, generateContentKey());
  const modality = options.modality ?? 'image';
  const valueModality = options.valueModality ?? modality;
  return {
    plan: { assistantMessageId, contentItemId, epochNumber: 1, wrappedContentKey },
    charge: {
      key,
      modelId: MEDIA_MODEL_ID,
      providerName: PROVIDER_NAME,
      modality,
      generationId: `gen-${key}`,
      billableCostNanoUsd: options.billableCostNanoUsd ?? applyMarkup(BASE_COST),
      isEstimated: options.isEstimated ?? true,
    },
    output: {
      kind: 'media',
      value: {
        // The strict full-key equality the persist primitive enforces.
        ref: `media/${fixture.conversationId}/${assistantMessageId}/${contentItemId}`,
        mimeType: modality === 'video' ? 'video/mp4' : 'image/png',
        modality: valueModality,
        byteLength: options.byteLength ?? MEDIA_BYTES,
        metadata: options.metadata ?? {},
      },
    },
  };
}

function mediaRequest(runKey: string, pieces: readonly MediaTurnPiece[]): SettlementRequest {
  return {
    runKey,
    outputs: Object.fromEntries(pieces.map((piece) => [piece.charge.key, piece.output])),
    charges: pieces.map((piece) => piece.charge),
  };
}

function plansOf(pieces: readonly MediaTurnPiece[]): ReadonlyMap<string, MediaPersistPlan> {
  return new Map(pieces.map((piece) => [piece.charge.key, piece.plan]));
}

function bytesOf(value: Uint8Array | null): number[] {
  if (value === null) throw new Error('expected bytes');
  return [...value];
}

describe('chat settlement commit (media persistence)', () => {
  it('persists a media content item under the pre-minted plan and bills its charge', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const piece = mediaTurn(fixture, 'image-node');

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) }),
    });
    await hook(mediaRequest(runKey, [piece]));

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    const [userMessage, assistantMessage] = rows;
    if (!userMessage || !assistantMessage) throw new Error('expected two messages');

    // The assistant sibling rides the PRE-MINTED message id and the pre-supplied
    // run-start wrapped content key, batched with the user message it chains onto.
    expect(assistantMessage.id).toBe(piece.plan.assistantMessageId);
    expect(assistantMessage.senderType).toBe('assistant');
    expect(assistantMessage.senderId).toBe(ASSISTANT_SENDER_ID);
    expect(assistantMessage.parentMessageId).toBe(userMessage.id);
    expect(assistantMessage.batchId).toBe(userMessage.batchId);
    expect(bytesOf(assistantMessage.wrappedContentKey)).toEqual([...piece.plan.wrappedContentKey]);

    // The content item: pre-minted id, R2 facts straight from the MediaValue,
    // dims null (empty metadata), no encrypted blob (ciphertext lives in R2).
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistantMessage.id)),
      'media content'
    );
    expect(content.id).toBe(piece.plan.contentItemId);
    expect(content.contentType).toBe('image');
    expect(content.storageKey).toBe(piece.output.value.ref);
    expect(content.mimeType).toBe('image/png');
    expect(content.sizeBytes).toBe(MEDIA_BYTES);
    expect(content.width).toBeNull();
    expect(content.height).toBeNull();
    expect(content.durationMs).toBeNull();
    expect(content.encryptedBlob).toBeNull();
    expect(content.modelId).toBe(MEDIA_MODEL_ID);
    expect(content.providerName).toBe(PROVIDER_NAME);
    expect(content.isSmartModel).toBe(false);

    // BILLED: the charge anchored to the pre-minted item (the pairing), at the
    // deterministic image estimate — marked-up base plus prompt + byte storage.
    const expectedCost = applyMarkup(BASE_COST) + MEDIA_TURN_STORAGE(MEDIA_BYTES);
    expect(content.costNanoUsd).toBe(expectedCost);
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    expect(usage.contentItemId).toBe(piece.plan.contentItemId);
    expect(usage.isEstimated).toBe(true);
    expect(usage.costNanoUsd).toBe(expectedCost);

    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, usage.id));
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    const keyRow = first(
      await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id)),
      'key'
    );
    expect(keyRow.status).toBe('succeeded');
  });

  it('persists a video item with metadata dims and bills its inline (non-estimated) cost', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'video-node', {
      modality: 'video',
      isEstimated: false,
      byteLength: 9999,
      metadata: { width: 1280, height: 720, durationMs: 5000 },
    });
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) })(
        tx,
        mediaRequest('k-video', [piece])
      )
    );
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.id, piece.plan.contentItemId)),
      'video content'
    );
    expect(content.contentType).toBe('video');
    expect(content.mimeType).toBe('video/mp4');
    expect(content.sizeBytes).toBe(9999);
    expect(content.width).toBe(1280);
    expect(content.height).toBe(720);
    expect(content.durationMs).toBe(5000);
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    expect(usage.isEstimated).toBe(false);
    expect(usage.costNanoUsd).toBe(applyMarkup(BASE_COST) + MEDIA_TURN_STORAGE(9999));
    expect(content.costNanoUsd).toBe(usage.costNanoUsd);
  });

  it('persists sibling media messages sharing one batch and bills each against its own item', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const firstPiece = mediaTurn(fixture, 'node-a');
    const secondPiece = mediaTurn(fixture, 'node-b', { billableCostNanoUsd: applyMarkup(700n) });
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        mediaPlans: plansOf([firstPiece, secondPiece]),
      })(tx, mediaRequest('k-multi', [firstPiece, secondPiece]))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(3);
    const [userMessage, siblingA, siblingB] = rows;
    if (!userMessage || !siblingA || !siblingB) throw new Error('expected three messages');
    // Charge-order siblings under the pre-minted ids, all sharing the turn's batch.
    expect(siblingA.id).toBe(firstPiece.plan.assistantMessageId);
    expect(siblingB.id).toBe(secondPiece.plan.assistantMessageId);
    expect(siblingA.parentMessageId).toBe(userMessage.id);
    expect(siblingB.parentMessageId).toBe(userMessage.id);
    expect(siblingA.batchId).toBe(userMessage.batchId);
    expect(siblingB.batchId).toBe(userMessage.batchId);

    // Each charge billed against its own pre-minted content item.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(2);
    expect(new Set(usage.map((record) => record.contentItemId))).toEqual(
      new Set([firstPiece.plan.contentItemId, secondPiece.plan.contentItemId])
    );
  });

  it('persists and bills only the successful subset when a media sibling failed', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const succeeded = mediaTurn(fixture, 'node-ok');
    const failed = mediaTurn(fixture, 'node-dead');
    // Both nodes were planned at run start, but only one produced a charge +
    // output (the other's provider call failed) — the successful subset settles.
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        mediaPlans: plansOf([succeeded, failed]),
      })(tx, mediaRequest('k-subset', [succeeded]))
    );
    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.id).toBe(succeeded.plan.assistantMessageId);
    const items = await db
      .select()
      .from(contentItems)
      .where(inArray(contentItems.id, [succeeded.plan.contentItemId, failed.plan.contentItemId]));
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(succeeded.plan.contentItemId);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(1);
  });

  it('terminal-fails a media charge with no persist plan and commits nothing', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'unplanned-node');
    // A media charge whose node was never minted a plan is a defect — the whole
    // settlement rolls back: no message, no content, no charge, no ledger legs.
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores())(tx, mediaRequest('k-noplan', [piece]))
      )
    ).rejects.toThrow(/no media persist plan/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, fixture.walletId))
    ).toHaveLength(0);
  });

  it('terminal-fails a media plan carrying an empty wrapped content key', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'empty-key-node');
    // A mint-side bug handing settlement an empty wrapped key would persist a
    // permanently undecryptable message — the plan boundary rejects it instead.
    const emptyKeyPlan: MediaPersistPlan = { ...piece.plan, wrappedContentKey: new Uint8Array(0) };
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          mediaPlans: new Map([[piece.charge.key, emptyKeyPlan]]),
        })(tx, mediaRequest('k-emptykey', [piece]))
      )
    ).rejects.toThrow(/empty wrapped content key/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, fixture.walletId))
    ).toHaveLength(0);
  });

  it('terminal-fails a media output carrying an unsupported modality', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'audio-node', { valueModality: 'audio' });
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) })(
          tx,
          mediaRequest('k-audio', [piece])
        )
      )
    ).rejects.toThrow(/media modality/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('persists ZERO media rows when the epoch rotated between mint and settlement', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'rotated-node');
    // The plan's key was wrapped to epoch 1 at run start; a rotation before
    // settlement must terminal-fail the run — the pre-wrapped key never bypasses
    // the member-keyed epoch-at-persist gate.
    await rotateToEpochTwo(fixture.conversationId);
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) })(
          tx,
          mediaRequest('k-rotated', [piece])
        )
      )
    ).rejects.toThrow(/wrap-epoch/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, fixture.walletId))
    ).toHaveLength(0);
  });
});

describe('chat settlement commit (a refused turn is billed and saves nothing)', () => {
  it('rolls the refused commit back to its savepoint while the bill and the key-row flip commit', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const walletBefore = await walletBalance(fixture.walletId);
    const refusal = new SettlementConflictError(
      conflictError('refused after persisting'),
      'chat settlement: refused after persisting'
    );
    // The real chat commit persists the whole turn and charges it, and only
    // then refuses: every row it wrote must roll back with its savepoint.
    const chatCommit = commitFor(fixture, runId, createChatStores());
    const persistThenRefuse = async (
      tx: SettlementTx,
      settling: SettlementRequest
    ): Promise<void> => {
      await chatCommit(tx, settling);
      throw refusal;
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: persistThenRefuse,
      refusalCommit: refusalCommitFor(fixture, runId),
    });

    await expect(hook(request(runKey))).rejects.toBe(refusal);

    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage.map((row) => row.contentItemId)).toEqual([null]);
    // The model cost alone: the refusal stored nothing, so it owes no storage.
    expect(usage.map((row) => row.costNanoUsd)).toEqual([applyMarkup(BASE_COST)]);
    expect(await ledgerNet(usage.map((row) => row.id))).toBe(0n);
    expect(await walletBalance(fixture.walletId)).toBe(walletBefore - applyMarkup(BASE_COST));
    expect(await keyRowStatus(fence.id)).toBe('succeeded');
  });

  /**
   * Refuses the turn, then runs a refusal bill one of whose reads fails: the
   * whole settlement must roll back, nothing billed and the key row unflipped.
   */
  async function expectRefusalBillRolledBack(
    override: (
      real: ReturnType<typeof createConversationsStores>
    ) => Partial<ReturnType<typeof createConversationsStores>>
  ): Promise<void> {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const refusing = (): Promise<void> =>
      Promise.reject(
        new SettlementConflictError(conflictError('refused'), 'chat settlement: refused')
      );
    const faultingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return { ...real, ...override(real) };
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: refusing,
      refusalCommit: refusalCommitFor(fixture, runId, faultingConversationsStores),
    });

    await expectSettlementUnavailable(hook(request(runKey)));
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(await keyRowStatus(fence.id)).toBe('claimed');
  }

  it('rolls the whole settlement back, unbilled and unflipped, when the refusal bill cannot read the conversation', async () => {
    await expectRefusalBillRolledBack((real) => ({
      conversations: {
        ...real.conversations,
        lockForShare: () => errAsync(unavailableError('conversation lock boom')),
      },
    }));
  });

  it('rolls the whole settlement back, unbilled and unflipped, when the refusal bill cannot lock the accounts', async () => {
    await expectRefusalBillRolledBack((real) => ({
      users: {
        ...real.users,
        lockForKeyShare: () => errAsync(unavailableError('account lock boom')),
      },
    }));
  });
});

function refusalCommitFor(
  fixture: Fixture,
  runId: string,
  conversationsStores?: (tx: SettlementTx) => ReturnType<typeof createConversationsStores>
): ReturnType<typeof createChatRefusalCommit> {
  return createChatRefusalCommit({
    identity: {
      conversationId: fixture.conversationId,
      epochNumber: 1,
      walletId: fixture.walletId,
      payerUserId: fixture.userId,
      sender: { kind: 'user', userId: fixture.userId },
      runId,
      userMessage: { id: crypto.randomUUID(), content: PROMPT },
      answerMessageIds: mintedAnswerIds(),
    },
    stores: createChatStores(),
    billingStores: createBillingStores(),
    ownerFunded: false,
    readEpochPublicKey,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
    ...(conversationsStores === undefined ? {} : { conversationsStores }),
  });
}

async function walletBalance(walletId: string): Promise<bigint> {
  const rows = await db
    .select({ balance: wallets.balanceNanoUsd })
    .from(wallets)
    .where(eq(wallets.id, walletId));
  return first(rows, 'wallet').balance;
}

/** The sum of every ledger leg the given usage records posted: zero when they net out. */
async function ledgerNet(usageRecordIds: readonly string[]): Promise<bigint> {
  if (usageRecordIds.length === 0) return 0n;
  const legs = await db
    .select({ amount: ledgerEntries.amountNanoUsd })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.usageRecordId, [...usageRecordIds]));
  expect(legs.length).toBe(usageRecordIds.length * 2);
  return legs.reduce((sum, leg) => sum + leg.amount, 0n);
}

/** The key row's status, or null once the row is gone (its account was deleted). */
async function keyRowStatus(keyRowId: string): Promise<string | null> {
  const rows = await db
    .select({ status: idempotencyKeys.status })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.id, keyRowId));
  return rows[0]?.status ?? null;
}

/**
 * Each user action that could make settlement refuse an answer already
 * streamed, driven through the real conversation runtime: the run referee's
 * claim, the definition's bound hooks, the real executor on the deterministic
 * mock provider, and the real fenced settlement. Each run is held at the one
 * point between its stream and its settlement: the bound settlement hook is
 * wrapped so a user action commits through its owning writer after the answer
 * has streamed and before settlement opens its transaction. The emit spy is
 * the evidence the answer reached the client.
 */
describe('a user action mid-run against the real runtime', () => {
  const RUN_PROMPT = 'escape:tell me about tides';
  const TEXT_MODEL = `chat-settle-run/${crypto.randomUUID().slice(0, 8)}`;
  const IMAGE_MODEL = `google/test-image-${crypto.randomUUID().slice(0, 8)}`;
  const RUN_BODY_HASH = 'escape-body-hash';
  const RUN_WALLET_BALANCE = 1_000_000_000_000n;

  function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`${name} is required for the runtime-driven settlement cases`);
    }
    return value;
  }

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

  function spyTelemetry(): Telemetry {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      captureError: vi.fn(),
    };
  }

  let textDefinition: WorkflowDefinition;
  let imageDefinition: WorkflowDefinition;

  beforeAll(async () => {
    const refreshed = await refreshCatalog({
      db,
      fetch: catalogFetch({
        images: [imageModelFixture({ id: IMAGE_MODEL })],
        zdrModelIds: [IMAGE_MODEL],
        imageEndpoints: () => imageEndpointsFixture(),
      }),
      gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
      telemetry: spyTelemetry(),
      // The ambient clock: it becomes the row's `last_seen_at`, and the media
      // turn resolves the model through the catalog read, which delists a row
      // it has not sighted for a day.
      now: () => new Date(),
      recordSighting: createCatalogSightingRecorder(db),
    });
    refreshed._unsafeUnwrap();
    await db
      .insert(modelCatalog)
      .values({
        modelId: TEXT_MODEL,
        descriptor: {
          id: TEXT_MODEL,
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
    const silent = spyTelemetry();
    const builtText = await buildTurnDefinition({ db, telemetry: silent }, TEXT_MODEL, {});
    textDefinition = builtText._unsafeUnwrap();
    const builtImage = await buildMediaTurnDefinition(
      { db, telemetry: silent },
      [IMAGE_MODEL],
      'image',
      {
        params: { aspectRatio: '1:1' },
        budget: {
          promptCharacterCount: RUN_PROMPT.length,
          inputCharacterCount: RUN_PROMPT.length,
          funding: { kind: 'purchased', spendableNanoUsd: 1n },
        },
      }
    );
    imageDefinition = builtImage._unsafeUnwrap();
  });

  afterAll(async () => {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [TEXT_MODEL, IMAGE_MODEL]));
  });

  /** A second member, with a decryption key, a wallet and a member budget of its own. */
  interface SecondMember {
    readonly userId: string;
    readonly walletId: string;
    readonly memberId: string;
    readonly publicKey: Uint8Array;
  }

  interface RunFixture extends Fixture {
    readonly member: SecondMember;
  }

  /**
   * An owner who may manage links and members, funded for the mock model's
   * ceiling, and a second member whose key sits in epoch 1's wrap set beside
   * the owner's.
   */
  async function seedRunFixture(): Promise<RunFixture> {
    const owner = await seedFixture();
    await db
      .update(conversationMembers)
      .set({ privilege: 'owner' })
      .where(eq(conversationMembers.id, owner.memberId));
    await db
      .update(wallets)
      .set({ balanceNanoUsd: RUN_WALLET_BALANCE })
      .where(eq(wallets.id, owner.walletId));
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: RUN_WALLET_BALANCE })
      .where(eq(conversations.id, owner.conversationId));

    const publicKey = crypto.getRandomValues(new Uint8Array(32));
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const userRows = await db
      .insert(users)
      .values(
        userFactory.build({
          email: `${suffix}@chat-settle-run.test`,
          username: `cr${suffix}`,
          opaqueRegistration: BYTES,
          publicKey,
          passwordWrappedPrivateKey: BYTES,
          recoveryWrappedPrivateKey: BYTES,
          recoveryPublicKey: BYTES,
        })
      )
      .returning({ id: users.id });
    const userId = first(userRows, 'member user').id;
    createdUserIds.push(userId);
    const walletRows = await db
      .insert(wallets)
      .values({ userId, type: 'purchased', balanceNanoUsd: RUN_WALLET_BALANCE })
      .returning({ id: wallets.id });
    const memberRows = await db
      .insert(conversationMembers)
      .values({ conversationId: owner.conversationId, userId, visibleFromEpoch: 1 })
      .returning({ id: conversationMembers.id });
    const memberId = first(memberRows, 'member').id;
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: RUN_WALLET_BALANCE, spentNanoUsd: 0n });
    const epochRows = await db
      .select({ id: epochs.id })
      .from(epochs)
      .where(and(eq(epochs.conversationId, owner.conversationId), eq(epochs.epochNumber, 1)));
    await db.insert(epochMembers).values({
      epochId: first(epochRows, 'epoch 1').id,
      memberPublicKey: publicKey,
      wrap: BYTES,
      visibleFromEpoch: 1,
    });
    return {
      ...owner,
      member: { userId, walletId: first(walletRows, 'member wallet').id, memberId, publicKey },
    };
  }

  interface RunSpec {
    readonly fixture: Fixture;
    readonly definition?: WorkflowDefinition;
    /** The account that pays; the fixture's owner unless the run says otherwise. */
    readonly payer?: { readonly userId: string; readonly walletId: string };
    readonly sender?: SenderPrincipal;
    readonly userMessageId?: string;
    readonly forkId?: string;
    readonly regenerate?: RegenerateAction;
    /** The user action committed after the stream finished and before settlement. */
    readonly midRun?: () => Promise<void>;
  }

  interface DrivenRun {
    readonly outcome: FlowRunOutcome;
    readonly runId: string;
    readonly runKey: string;
    readonly keyRowId: string;
    readonly identity: RunIdentity;
    readonly userMessageId: string;
    readonly assistantMessageIds: readonly string[];
    readonly events: readonly FlowStreamEvent[];
    /** The charges the engine handed settlement: the basis of a refusal's bill. */
    readonly charges: readonly SettlementCharge[];
    readonly telemetry: Telemetry;
  }

  async function driveRun(spec: RunSpec): Promise<DrivenRun> {
    const telemetry = spyTelemetry();
    const rt = createConversationRuntime({
      db,
      redis,
      telemetry,
      apiKey: 'mock-key',
      searchApiKey: 'mock-key',
      isCI: false,
      mockProviderEnabled: true,
      chatStores: createChatStores(),
      storage,
      readEpochPublicKey,
    });
    const definition = spec.definition ?? textDefinition;
    const payer = spec.payer ?? { userId: spec.fixture.userId, walletId: spec.fixture.walletId };
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const userMessageId = spec.userMessageId ?? crypto.randomUUID();
    const identity: RunIdentity = {
      mode: 'paid',
      payerUserId: payer.userId,
      sender: spec.sender ?? { kind: 'user', userId: spec.fixture.userId },
      conversationId: spec.fixture.conversationId,
      walletId: payer.walletId,
      epochNumber: 1,
      userMessage: { id: userMessageId, content: RUN_PROMPT },
      ...(spec.forkId === undefined ? {} : { forkId: spec.forkId }),
      ...(spec.regenerate === undefined ? {} : { regenerate: spec.regenerate }),
    };
    const claim = await rt.claimRun({ runKey, runId, bodyHash: RUN_BODY_HASH, identity });
    if (claim.outcome !== 'executor') {
      throw new Error(`expected a fresh executor claim, got ${claim.outcome}`);
    }
    const context: RunContext = { ...identity, runId, fence: claim.fence, mockDirectives: {} };
    const bound = rt.bindHooks(context, definition);
    let charges: readonly SettlementCharge[] = [];
    const hooks: ChatHookBindings = {
      ...bound,
      settlement: async (settling) => {
        charges = settling.charges;
        await spec.midRun?.();
        await bound.settlement(settling);
      },
    };
    const events: FlowStreamEvent[] = [];
    const handle = rt.executor.start({
      definition,
      inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: RUN_PROMPT } },
      hooks,
      runKey,
      // The room hands the executor the run id it minted, as here.
      runId,
      mockDirectives: {},
      emit: (event) => {
        events.push(event);
      },
    });
    const outcome = await handle.done;
    const admission = await handle.admitted;
    if (admission.admitted && admission.hold !== undefined) await rt.releaseHold(admission.hold);
    return {
      outcome,
      runId,
      runKey,
      keyRowId: claim.fence.id,
      identity,
      userMessageId,
      assistantMessageIds: bound.assistantMessageIds,
      events,
      charges,
      telemetry,
    };
  }

  function streamedText(run: DrivenRun): string {
    return run.events
      .map(({ event }) => (event.kind === 'text-delta' ? event.content : ''))
      .join('');
  }

  async function usageOf(runId: string): Promise<(typeof usageRecords.$inferSelect)[]> {
    return db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
  }

  /** Commits one user action through its owning writer, in a transaction of its own. */
  async function commitAction<T>(
    write: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => ResultAsync<T, DomainError>
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const written = await write(tx);
      const outcome = written._unsafeUnwrap();
      expect(outcome).not.toHaveProperty('refusal');
      return outcome;
    });
  }

  /** A rotation from epoch 1 whose new wrap set is exactly the given keys. */
  function rotationTo(
    epochPublicKey: Uint8Array,
    memberKeys: readonly Uint8Array[]
  ): StreamChatRotation {
    return {
      expectedEpoch: 1,
      epochPublicKey: toBase64(epochPublicKey),
      confirmationHash: toBase64(BYTES),
      chainLink: toBase64(BYTES),
      memberWraps: memberKeys.map((key) => ({
        memberPublicKey: toBase64(key),
        wrap: toBase64(BYTES),
      })),
      encryptedTitle: toBase64(BYTES),
    };
  }

  /** The owner seats a link without history: a rotation that keeps every member. */
  function mintLinkWithoutHistory(
    fixture: RunFixture,
    epochPublicKey: Uint8Array
  ): () => Promise<void> {
    return async () => {
      const { linkPublicKey: linkKey, linkAuthHash } = mintLinkCredential();
      await commitAction((tx) =>
        createSharedLink(createConversationsStores(tx), {
          conversationId: fixture.conversationId,
          callerUserId: fixture.userId,
          linkPublicKey: toBase64(linkKey),
          linkAuthHash: toBase64(linkAuthHash),
          displayName: null,
          expiresAt: null,
          privilege: 'read',
          giveFullHistory: false,
          rotation: rotationTo(epochPublicKey, [BYTES, fixture.member.publicKey, linkKey]),
        })
      );
    };
  }

  /** The owner removes the second member, rotating to a wrap set without it. */
  function removeSecondMember(
    fixture: RunFixture,
    epochPublicKey: Uint8Array
  ): () => Promise<void> {
    return async () => {
      await commitAction((tx) =>
        removeMember(
          createConversationsStores(tx),
          (memberId) => createBillingStores().deleteMemberBudgetWithinTx(tx, memberId),
          {
            conversationId: fixture.conversationId,
            memberId: fixture.member.memberId,
            callerUserId: fixture.userId,
            rotation: rotationTo(epochPublicKey, [BYTES]),
          }
        )
      );
    };
  }

  /** Every expectation a billed refusal meets: streamed, refused, billed once, saved nothing. */
  async function expectBilledRefusal(
    run: DrivenRun,
    expected: {
      readonly code: string;
      readonly payerWalletId: string;
      readonly walletBefore: bigint;
      /** The sender's account was deleted mid-run, taking the run's key row with it. */
      readonly keyRowGone?: true;
    }
  ): Promise<(typeof usageRecords.$inferSelect)[]> {
    expect(run.outcome).toEqual({ outcome: 'failed', code: expected.code });
    const usage = await usageOf(run.runId);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.contentItemId === null)).toBe(true);
    // No storage fee: each record carries exactly the billable cost the engine
    // collected for its generation.
    const billable = run.charges.reduce((sum, charge) => sum + charge.billableCostNanoUsd, 0n);
    const billed = usage.reduce((sum, row) => sum + row.costNanoUsd, 0n);
    expect(billed).toBe(billable);
    expect(await ledgerNet(usage.map((row) => row.id))).toBe(0n);
    expect(await walletBalance(expected.payerWalletId)).toBe(expected.walletBefore - billed);
    expect(await keyRowStatus(run.keyRowId)).toBe(expected.keyRowGone ? null : 'succeeded');
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
    return usage;
  }

  it('saves into the current epoch a text turn whose epoch a link seated without history rotated', async () => {
    const fixture = await seedRunFixture();
    const epochTwo = generateEpochKeyPair();
    const run = await driveRun({
      fixture,
      midRun: mintLinkWithoutHistory(fixture, epochTwo.publicKey),
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    expect(run.outcome).toEqual({ outcome: 'succeeded' });
    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows.map((row) => row.epochNumber)).toEqual([2, 2]);
    const usage = await usageOf(run.runId);
    expect(usage).toHaveLength(1);
    expect(first(usage, 'usage').contentItemId).not.toBeNull();
  });

  it('saves into the current epoch a text turn whose epoch rotated when another member was removed', async () => {
    const fixture = await seedRunFixture();
    const epochTwo = generateEpochKeyPair();
    const run = await driveRun({
      fixture,
      midRun: removeSecondMember(fixture, epochTwo.publicKey),
    });

    const answer = streamedText(run);
    expect(answer).toContain(RUN_PROMPT);
    expect(run.outcome).toEqual({ outcome: 'succeeded' });
    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows.map((row) => row.epochNumber)).toEqual([2, 2]);
    const usage = first(await usageOf(run.runId), 'usage');
    const billable = run.charges.reduce((sum, charge) => sum + charge.billableCostNanoUsd, 0n);
    expect(usage.costNanoUsd).toBe(
      billable + BigInt(RUN_PROMPT.length + answer.length) * STORAGE_COST_PER_CHARACTER_NANO
    );
  });

  it('keeps a re-saved turn readable to a remaining member and unreadable to the removed one', async () => {
    const fixture = await seedRunFixture();
    const epochTwo = generateEpochKeyPair();
    const run = await driveRun({
      fixture,
      midRun: removeSecondMember(fixture, epochTwo.publicKey),
    });
    expect(run.outcome).toEqual({ outcome: 'succeeded' });

    const stored = await messagesInOrder(fixture.conversationId);
    const assistantMessage = first(
      stored.filter((row) => row.senderType === 'assistant'),
      'assistant message'
    );
    const assistantContent = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistantMessage.id)),
      'assistant content'
    );
    const location = { conversationId: fixture.conversationId, senderId: ASSISTANT_SENDER_ID };
    // The owner stayed in the new epoch and unwraps its key.
    expect(
      decryptAtEpoch(
        { epochNumber: 2, privateKey: epochTwo.privateKey },
        location,
        assistantMessage,
        assistantContent
      )
    ).toBe(streamedText(run));
    // The removed member holds only epoch 1's key, which the turn was not
    // wrapped to, and the new epoch's wrap set holds no key of theirs.
    expect(() =>
      decryptAtEpoch(
        { epochNumber: 2, privateKey: fixture.epochPrivateKey },
        location,
        assistantMessage,
        assistantContent
      )
    ).toThrow();
    const epochTwoRow = first(
      await db
        .select({ id: epochs.id })
        .from(epochs)
        .where(and(eq(epochs.conversationId, fixture.conversationId), eq(epochs.epochNumber, 2))),
      'epoch 2'
    );
    const removedWraps = await db
      .select()
      .from(epochMembers)
      .where(
        and(
          eq(epochMembers.epochId, epochTwoRow.id),
          eq(epochMembers.memberPublicKey, fixture.member.publicKey)
        )
      );
    expect(removedWraps).toHaveLength(0);
  });

  it('bills a media turn across the same rotation and saves nothing', async () => {
    const fixture = await seedRunFixture();
    const epochTwo = generateEpochKeyPair();
    const walletBefore = await walletBalance(fixture.walletId);
    const run = await driveRun({
      fixture,
      definition: imageDefinition,
      midRun: mintLinkWithoutHistory(fixture, epochTwo.publicKey),
    });

    expect(run.events.some(({ event }) => event.kind === 'media-done')).toBe(true);
    await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  }, 30_000);

  it("bills an owner-funded turn whose sender was removed to the owner's wallet and saves nothing", async () => {
    const fixture = await seedRunFixture();
    const epochTwo = generateEpochKeyPair();
    const walletBefore = await walletBalance(fixture.walletId);
    const run = await driveRun({
      fixture,
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: removeSecondMember(fixture, epochTwo.publicKey),
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    const usage = await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    expect(usage.map((row) => [row.payerUserId, row.senderUserId])).toEqual([
      [fixture.userId, fixture.member.userId],
    ]);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('bills a self-funded turn whose sender left to their own wallet and saves nothing', async () => {
    const fixture = await seedRunFixture();
    const walletBefore = await walletBalance(fixture.member.walletId);
    const run = await driveRun({
      fixture,
      payer: { userId: fixture.member.userId, walletId: fixture.member.walletId },
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: async () => {
        await commitAction((tx) =>
          leaveConversation(
            createConversationsStores(tx),
            (memberId) => createBillingStores().deleteMemberBudgetWithinTx(tx, memberId),
            {
              conversationId: fixture.conversationId,
              callerUserId: fixture.member.userId,
            }
          )
        );
      },
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.member.walletId,
      walletBefore,
    });
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  /** One settled turn, and a fork tipped at its reply: what a fork refusal must leave alone. */
  async function seedForkedTurn(fixture: RunFixture): Promise<{
    readonly userMessageId: string;
    readonly assistantMessageId: string;
    readonly forkId: string;
  }> {
    const seeded = await driveRun({ fixture });
    expect(seeded.outcome).toEqual({ outcome: 'succeeded' });
    const rows = await messagesInOrder(fixture.conversationId);
    const userMessageId = first(rows, 'seed user message').id;
    const assistantMessageId = first(rows.slice(1), 'seed assistant message').id;
    await seedFork(fixture.conversationId, assistantMessageId, 'Main');
    const forkId = await seedFork(fixture.conversationId, assistantMessageId, 'Branch');
    return { userMessageId, assistantMessageId, forkId };
  }

  it('bills a fork retry-all whose tip was moved and leaves the fork tree untouched', async () => {
    const fixture = await seedRunFixture();
    const seed = await seedForkedTurn(fixture);
    const before = await messagesInOrder(fixture.conversationId);
    const walletBefore = await walletBalance(fixture.walletId);
    const run = await driveRun({
      fixture,
      userMessageId: seed.userMessageId,
      forkId: seed.forkId,
      regenerate: {
        action: 'retry',
        targetMessageId: seed.userMessageId,
        observedForkTipId: seed.assistantMessageId,
      },
      midRun: async () => {
        await commitAction((tx) =>
          updateForkTip(createConversationsStores(tx), {
            conversationId: fixture.conversationId,
            forkId: seed.forkId,
            callerUserId: fixture.userId,
            tipMessageId: seed.userMessageId,
            expectedTipMessageId: seed.assistantMessageId,
          })
        );
      },
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    await expectBilledRefusal(run, {
      code: ERROR_CODES.FORK_TIP_CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    expect(await messagesInOrder(fixture.conversationId)).toEqual(before);
    expect(await forkTip(seed.forkId)).toBe(seed.userMessageId);
  });

  it('bills a fork retry-all whose tip a user-only post advanced and leaves the fork tree untouched', async () => {
    const fixture = await seedRunFixture();
    const seed = await seedForkedTurn(fixture);
    const walletBefore = await walletBalance(fixture.walletId);
    let postedId = '';
    const run = await driveRun({
      fixture,
      userMessageId: seed.userMessageId,
      forkId: seed.forkId,
      regenerate: {
        action: 'retry',
        targetMessageId: seed.userMessageId,
        observedForkTipId: seed.assistantMessageId,
      },
      midRun: async () => {
        const posted = await commitAction((tx) =>
          saveUserOnlyMessage(
            {
              tx,
              stores: createChatStores(),
              readEpochPublicKey,
              newId: () => crypto.randomUUID(),
            },
            {
              conversationId: fixture.conversationId,
              senderId: fixture.userId,
              content: 'a note while the answer streams',
              forkId: seed.forkId,
            }
          )
        );
        postedId = posted.messageId;
      },
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    await expectBilledRefusal(run, {
      code: ERROR_CODES.FORK_TIP_CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    const after = await messagesInOrder(fixture.conversationId);
    expect(after.map((row) => row.id)).toEqual([
      seed.userMessageId,
      seed.assistantMessageId,
      postedId,
    ]);
    expect(await forkTip(seed.forkId)).toBe(postedId);
  });

  it('bills a fork turn whose fork was deleted', async () => {
    const fixture = await seedRunFixture();
    const seed = await seedForkedTurn(fixture);
    const walletBefore = await walletBalance(fixture.walletId);
    const run = await driveRun({
      fixture,
      forkId: seed.forkId,
      midRun: async () => {
        await commitAction((tx) =>
          deleteFork(
            createConversationsStores(tx),
            {
              conversationId: fixture.conversationId,
              forkId: seed.forkId,
              callerUserId: fixture.userId,
            },
            createForkMessageDeleter(tx)
          )
        );
      },
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    await expectBilledRefusal(run, {
      code: ERROR_CODES.FORK_TIP_CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    const after = await messagesInOrder(fixture.conversationId);
    expect(after.map((row) => row.id)).toEqual([seed.userMessageId, seed.assistantMessageId]);
  });

  it("bills a regenerate whose delete set a co-member's post joined", async () => {
    const fixture = await seedRunFixture();
    const seeded = await driveRun({ fixture });
    expect(seeded.outcome).toEqual({ outcome: 'succeeded' });
    const seedRows = await messagesInOrder(fixture.conversationId);
    const anchorId = first(seedRows, 'seed user message').id;
    const walletBefore = await walletBalance(fixture.walletId);
    const run = await driveRun({
      fixture,
      userMessageId: anchorId,
      regenerate: { action: 'retry', targetMessageId: anchorId },
      midRun: async () => {
        await commitAction((tx) =>
          saveUserOnlyMessage(
            {
              tx,
              stores: createChatStores(),
              readEpochPublicKey,
              newId: () => crypto.randomUUID(),
            },
            {
              conversationId: fixture.conversationId,
              senderId: fixture.member.userId,
              content: 'a co-member note after the anchor',
            }
          )
        );
      },
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    await expectBilledRefusal(run, {
      code: ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    const after = await messagesInOrder(fixture.conversationId);
    expect(after.slice(0, seedRows.length).map((row) => row.id)).toEqual(
      seedRows.map((row) => row.id)
    );
    expect(after).toHaveLength(seedRows.length + 1);
  });

  it('bills a turn whose conversation was deleted', async () => {
    const fixture = await seedRunFixture();
    const walletBefore = await walletBalance(fixture.walletId);
    const run = await driveRun({
      fixture,
      midRun: async () => {
        await commitAction((tx) =>
          deleteConversation(createConversationsStores(tx), {
            conversationId: fixture.conversationId,
            callerUserId: fixture.userId,
          })
        );
      },
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    const usage = await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    expect(usage.map((row) => row.conversationId)).toEqual([null]);
    // The refusal's bill moved the balance, so the admission snapshot was
    // written through from it, as after a settled run.
    const snapshot = await redis.get<{ balanceNanoUsd: string }>(
      BILLING_KEYS.walletSnapshot.buildKey(fixture.walletId)
    );
    expect(snapshot?.balanceNanoUsd).toBe(String(await walletBalance(fixture.walletId)));
  });

  it('bills a retried refusal once: the same key replays the run-start body', async () => {
    const fixture = await seedRunFixture();
    const walletBefore = await walletBalance(fixture.walletId);
    const run = await driveRun({
      fixture,
      midRun: async () => {
        await commitAction((tx) =>
          deleteConversation(createConversationsStores(tx), {
            conversationId: fixture.conversationId,
            callerUserId: fixture.userId,
          })
        );
      },
    });
    await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore,
    });
    const billedAfterRefusal = await walletBalance(fixture.walletId);

    const retry = createConversationRuntime({
      db,
      redis,
      telemetry: spyTelemetry(),
      apiKey: 'mock-key',
      searchApiKey: 'mock-key',
      isCI: false,
      mockProviderEnabled: true,
      chatStores: createChatStores(),
      storage,
      readEpochPublicKey,
    });
    const retryRunId = crypto.randomUUID();
    const claim = await retry.claimRun({
      runKey: run.runKey,
      runId: retryRunId,
      bodyHash: RUN_BODY_HASH,
      identity: run.identity,
    });

    expect(claim).toEqual({
      outcome: 'replay',
      response: {
        runId: run.runId,
        userMessageId: run.userMessageId,
        assistantMessageIds: run.assistantMessageIds,
      },
    });
    expect(await usageOf(retryRunId)).toHaveLength(0);
    expect(await walletBalance(fixture.walletId)).toBe(billedAfterRefusal);
  });

  async function conversationSpent(conversationId: string): Promise<bigint> {
    const rows = await db
      .select({ spent: conversationSpending.spentNanoUsd })
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, conversationId));
    return rows[0]?.spent ?? 0n;
  }

  it("raises the conversation's spend by the bill of an owner-funded turn refused because its sender was removed", async () => {
    const fixture = await seedRunFixture();
    const epochTwo = generateEpochKeyPair();
    const spentBefore = await conversationSpent(fixture.conversationId);
    const run = await driveRun({
      fixture,
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: removeSecondMember(fixture, epochTwo.publicKey),
    });

    const usage = await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore: RUN_WALLET_BALANCE,
    });
    const billed = usage.reduce((sum, row) => sum + row.costNanoUsd, 0n);
    expect(await conversationSpent(fixture.conversationId)).toBe(spentBefore + billed);
  });

  /** Seats a link guest with full history, funded by the owner through a member budget. */
  async function seatLinkGuest(fixture: RunFixture): Promise<string> {
    const { linkPublicKey, linkAuthHash } = mintLinkCredential();
    const minted = await commitAction((tx) =>
      createSharedLink(createConversationsStores(tx), {
        conversationId: fixture.conversationId,
        callerUserId: fixture.userId,
        linkPublicKey: toBase64(linkPublicKey),
        linkAuthHash: toBase64(linkAuthHash),
        displayName: null,
        expiresAt: null,
        privilege: 'write',
        giveFullHistory: true,
        memberWrap: toBase64(BYTES),
        expectedEpoch: 1,
      })
    );
    if (!('memberId' in minted)) throw new Error('expected a freshly seated link guest');
    await db
      .insert(memberBudgets)
      .values({ memberId: minted.memberId, budgetNanoUsd: RUN_WALLET_BALANCE, spentNanoUsd: 0n });
    return minted.link.id;
  }

  it("bills a link guest's turn to the owner with a null sender when the owner deletes the conversation", async () => {
    const fixture = await seedRunFixture();
    const linkId = await seatLinkGuest(fixture);
    const run = await driveRun({
      fixture,
      sender: { kind: 'linkGuest', linkId },
      midRun: async () => {
        await commitAction((tx) =>
          deleteConversation(createConversationsStores(tx), {
            conversationId: fixture.conversationId,
            callerUserId: fixture.userId,
          })
        );
      },
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    const usage = await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore: RUN_WALLET_BALANCE,
    });
    // The conversation's deletion took the link with it, so the bill names no
    // sender: the pseudonymized state a hard deletion leaves on every other row.
    expect(usage.map((row) => [row.payerUserId, row.senderUserId, row.senderLinkId])).toEqual([
      [fixture.userId, null, null],
    ]);
  });

  /** A unique marker per module load, so this file can remove the anonymous events it wrote. */
  const DELETION_AGENT = `chat-settle-run-${crypto.randomUUID()}`;
  const deletionDb = grantJobWakes(
    createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG }),
    createJobWakeCollector()
  );
  const reclaimRegistry = createAppJobRegistry([
    createMediaReclaimUserJob({ resolveStorage: () => storage }),
  ]);
  // Watches for lock waits on a connection no transaction under test holds.
  const lockObserverDb = createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

  afterAll(async () => {
    await db
      .delete(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, DELETION_AGENT));
    await deletionDb.$client.end();
    await lockObserverDb.$client.end();
  });

  const deletionPurge: AccountDeletionPurge = {
    captureContentStorageKeysWithinTx,
    deleteForeignMessageContentWithinTx,
    detachMessageSendersWithinTx,
    enqueueMediaReclaimWithinTx: async (tx, args) => {
      await enqueueWithinTx(tx, reclaimRegistry, {
        type: MEDIA_RECLAIM_USER_JOB_TYPE,
        payload: args,
      });
    },
  };

  /** The identity slice's own hard-deletion executor, run for one account. */
  function executeDeletion(
    userId: string,
    purge: AccountDeletionPurge = deletionPurge
  ): ReturnType<typeof executeAccountDeletion> {
    return executeAccountDeletion({
      redis,
      store: createIdentityStores(deletionDb).users,
      db: deletionDb,
      purge,
      accountDeletedEmail: { sendAccountDeletedEmail: () => okAsync() },
      userId,
      ipAddress: null,
      userAgent: DELETION_AGENT,
      now: NOW,
    });
  }

  async function deleteAccount(userId: string): Promise<void> {
    const deleted = await executeDeletion(userId);
    expect(deleted._unsafeUnwrap()).toEqual({ kind: 'deleted' });
  }

  /** An account deletion that pauses once it holds its users-row lock, until told to finish. */
  interface HeldDeletion {
    /** Settles once the deletion holds its lock on the users row. */
    readonly locked: Promise<void>;
    readonly finish: () => Promise<Awaited<ReturnType<typeof executeAccountDeletion>>>;
  }

  /** Starts an account deletion and pauses it once it holds its lock on the users row. */
  async function deletionHoldingItsLock(userId: string): Promise<HeldDeletion> {
    const deletion = startHeldDeletion(userId);
    await deletion.locked;
    return deletion;
  }

  /**
   * Starts an account deletion that pauses inside its transaction just after its
   * opening lock on the users row, the moment a settlement can race it.
   */
  function startHeldDeletion(userId: string): HeldDeletion {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleting = executeDeletion(userId, {
      ...deletionPurge,
      captureContentStorageKeysWithinTx: async (tx, conversationIds) => {
        signalLocked();
        await released;
        return deletionPurge.captureContentStorageKeysWithinTx(tx, conversationIds);
      },
    });
    return {
      locked,
      finish: async () => {
        release();
        return deleting;
      },
    };
  }

  /** Holds the conversation row FOR UPDATE on a connection of its own until released. */
  async function holdConversation(
    conversationId: string
  ): Promise<{ readonly release: () => Promise<void> }> {
    let releaseConversation!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseConversation = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const holding = dbInterloper.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update');
      signalHeld();
      await released;
    });
    await held;
    return {
      release: async () => {
        releaseConversation();
        await holding;
      },
    };
  }

  /** Resolves once at least `count` backends in this database are waiting on a lock. */
  async function lockWaitsObserved(count: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const result = await lockObserverDb.execute(
        sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
      );
      if (Number(result.rows[0]?.['waiting']) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${String(count)} backends waited on a lock`);
  }

  /**
   * Lets a held deletion finish once the settlement is waiting behind it. The
   * deletion is released whether or not the wait was seen, so a settlement that
   * never waits fails the test instead of hanging it.
   */
  async function finishOnceSettlementWaits(
    deletion: HeldDeletion
  ): Promise<Awaited<ReturnType<typeof executeAccountDeletion>>> {
    const unseen = await lockWaitsObserved(1).then(
      () => null,
      (error: unknown) => error
    );
    const outcome = await deletion.finish();
    if (unseen instanceof Error) throw unseen;
    return outcome;
  }

  it("bills an owner-funded turn to the owner with a null sender when the sender's account is deleted", async () => {
    const fixture = await seedRunFixture();
    const run = await driveRun({
      fixture,
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: () => deleteAccount(fixture.member.userId),
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    const usage = await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore: RUN_WALLET_BALANCE,
      keyRowGone: true,
    });
    expect(usage.map((row) => [row.payerUserId, row.senderUserId, row.senderLinkId])).toEqual([
      [fixture.userId, null, null],
    ]);
  });

  it("absorbs a self-funded turn whose sender's account is deleted, with one absorbed-loss capture", async () => {
    const fixture = await seedRunFixture();
    const run = await driveRun({
      fixture,
      payer: { userId: fixture.member.userId, walletId: fixture.member.walletId },
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: () => deleteAccount(fixture.member.userId),
    });

    expect(streamedText(run)).toContain(RUN_PROMPT);
    expect(run.outcome).toEqual({ outcome: 'failed', code: ERROR_CODES.CONFLICT });
    // Nobody is left to pay: nothing is billed, and the wallet the account
    // left behind does not move.
    expect(await usageOf(run.runId)).toHaveLength(0);
    expect(await walletBalance(fixture.member.walletId)).toBe(RUN_WALLET_BALANCE);
    expect(await keyRowStatus(run.keyRowId)).toBeNull();
    const captures = vi.mocked(run.telemetry.captureError).mock.calls;
    expect(captures.map(([, fingerprint]) => fingerprint)).toEqual(['workflow_refusal_absorbed']);
    const billable = run.charges.reduce((sum, charge) => sum + charge.billableCostNanoUsd, 0n);
    expect(captures[0]?.[0]).toMatchObject({
      runId: run.runId,
      absorbedNanoUsd: billable.toString(),
    });
  });
  it('absorbs a refused turn whose payer deletes their account while settlement runs, with no defect or deadlock', async () => {
    const fixture = await seedRunFixture();
    let deletionDone: ReturnType<typeof finishOnceSettlementWaits> | undefined;
    const run = await driveRun({
      fixture,
      payer: { userId: fixture.member.userId, walletId: fixture.member.walletId },
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: async () => {
        const deletion = await deletionHoldingItsLock(fixture.member.userId);
        deletionDone = finishOnceSettlementWaits(deletion);
      },
    });
    const deleted = await deletionDone;

    expect(deleted?._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(streamedText(run)).toContain(RUN_PROMPT);
    expect(run.outcome).toEqual({ outcome: 'failed', code: ERROR_CODES.CONFLICT });
    expect(await usageOf(run.runId)).toHaveLength(0);
    expect(await keyRowStatus(run.keyRowId)).toBeNull();
    const captures = vi.mocked(run.telemetry.captureError).mock.calls;
    expect(captures.map(([, fingerprint]) => fingerprint)).toEqual(['workflow_refusal_absorbed']);
  });

  it('refuses and bills with a null sender a turn whose sender deletes their account while settlement runs', async () => {
    const fixture = await seedRunFixture();
    let deletionDone: ReturnType<typeof finishOnceSettlementWaits> | undefined;
    const run = await driveRun({
      fixture,
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: async () => {
        const deletion = await deletionHoldingItsLock(fixture.member.userId);
        deletionDone = finishOnceSettlementWaits(deletion);
      },
    });
    const deleted = await deletionDone;

    expect(deleted?._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(streamedText(run)).toContain(RUN_PROMPT);
    // The deletion held the sender's row first, so it committed first and the
    // turn is the rows-gone case.
    const usage = await expectBilledRefusal(run, {
      code: ERROR_CODES.CONFLICT,
      payerWalletId: fixture.walletId,
      walletBefore: RUN_WALLET_BALANCE,
      keyRowGone: true,
    });
    expect(usage.map((row) => [row.payerUserId, row.senderUserId, row.senderLinkId])).toEqual([
      [fixture.userId, null, null],
    ]);
  });

  it('commits a turn that locked its sender first, then lets their account deletion null its rows', async () => {
    const fixture = await seedRunFixture();
    let background: Promise<Awaited<ReturnType<typeof executeAccountDeletion>>> | undefined;
    const run = await driveRun({
      fixture,
      sender: { kind: 'user', userId: fixture.member.userId },
      midRun: async () => {
        // Hold the conversation row, so the settlement stops on its conversation
        // lock right after taking its locks on the payer and the sender.
        const conversation = await holdConversation(fixture.conversationId);
        background = (async () => {
          try {
            await lockWaitsObserved(1);
            const deleting = executeDeletion(fixture.member.userId);
            // The deletion waits on the settlement's lock on the sender's row.
            await Promise.race([lockWaitsObserved(2), deleting]);
            await conversation.release();
            return await deleting;
          } finally {
            await conversation.release();
          }
        })();
      },
    });
    const deleted = await background;

    expect(deleted?._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(run.outcome).toEqual({ outcome: 'succeeded' });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
    // The turn settled and billed; the deletion that followed nulled the sender
    // on its usage row, as it does on every row the account leaves behind.
    const usage = await usageOf(run.runId);
    expect(usage.map((row) => [row.payerUserId, row.senderUserId])).toEqual([
      [fixture.userId, null],
    ]);
    expect(usage.every((row) => row.contentItemId !== null)).toBe(true);
  });

  it('absorbs a refused turn whose payer deletes their account between the refusal and its bill, with no defect or deadlock', async () => {
    const fixture = await seedRunFixture();
    const seed = await seedForkedTurn(fixture);
    let background: Promise<Awaited<ReturnType<typeof executeAccountDeletion>>> | undefined;
    const run = await driveRun({
      fixture,
      userMessageId: seed.userMessageId,
      forkId: seed.forkId,
      regenerate: {
        action: 'retry',
        targetMessageId: seed.userMessageId,
        observedForkTipId: seed.assistantMessageId,
      },
      midRun: async () => {
        // The refusal's cause: the fork tip moves under the retry.
        await commitAction((tx) =>
          updateForkTip(createConversationsStores(tx), {
            conversationId: fixture.conversationId,
            forkId: seed.forkId,
            callerUserId: fixture.userId,
            tipMessageId: seed.userMessageId,
            expectedTipMessageId: seed.assistantMessageId,
          })
        );
        // Stop the settlement on the conversation, holding its lock on the payer.
        const conversation = await holdConversation(fixture.conversationId);
        background = (async () => {
          let deletion: HeldDeletion | undefined;
          try {
            // With no deletion yet, this wait can only be the settlement on the
            // held conversation, reached after it locked the payer's row. A
            // deletion started earlier can take that row first, and the turn then
            // refuses as the rows-gone case before the refusal bill's own lock.
            await lockWaitsObserved(1);
            deletion = startHeldDeletion(fixture.userId);
            // The deletion queues behind the settlement's lock on the payer's row.
            await Promise.race([lockWaitsObserved(2), deletion.locked]);
            await conversation.release();
            // The refusal's rollback released that lock: the deletion now holds
            // the row while the refusal bill starts.
            await deletion.locked;
            return await finishOnceSettlementWaits(deletion);
          } finally {
            await conversation.release();
            await deletion?.finish();
          }
        })();
      },
    });
    const deleted = await background;

    expect(deleted?._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(streamedText(run)).toContain(RUN_PROMPT);
    expect(run.outcome).toEqual({ outcome: 'failed', code: ERROR_CODES.FORK_TIP_CONFLICT });
    expect(await usageOf(run.runId)).toHaveLength(0);
    expect(await keyRowStatus(run.keyRowId)).toBeNull();
    const captures = vi.mocked(run.telemetry.captureError).mock.calls;
    expect(captures.map(([, fingerprint]) => fingerprint)).toEqual(['workflow_refusal_absorbed']);
  });
});
