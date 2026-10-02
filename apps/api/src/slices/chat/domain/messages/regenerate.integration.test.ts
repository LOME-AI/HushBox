import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  decryptContentEnvelope,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  llmCompletions,
  messages,
  modelCatalog,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import {
  STORAGE_COST_PER_CHARACTER_NANO,
  providerUsdToBillableNanoUsd,
} from '../../../billing/index.js';
import { MOCK_GENERATION_COST_USD } from '../../../models/index.js';
import { createChatStores } from '../../adapters/stores.js';
import { buildTurnDefinition } from '../turn/definition.js';
import { createConversationRuntime } from '../runtime.js';
import { CHAT_TURN_INPUT } from '../constants.js';
import { ASSISTANT_SENDER_ID } from '../settlement/settlement.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { ChatHookBindings } from '../runtime.js';
import type { EpochPublicKeyReader } from '../settlement/settlement.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type {
  FlowRunOutcome,
  RegenerateAction,
  RunContext,
  RunIdentity,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/**
 * The regenerate/edit turn driven END TO END through the real conversation
 * runtime: the run referee's claim, the definition's admission + settlement
 * hooks, and — the seam neither the route tests (which stub the realtime) nor
 * the settlement-commit tests (which inject pre-computed charges) exercise —
 * the real workflow executor calling the DETERMINISTIC MOCK PROVIDER to produce
 * the regenerated answer, whose bytes then flow into the same fenced settlement.
 *
 * AI is driven via the `x-mock-*` mock-provider seam (`mockProviderEnabled` +
 * per-run `mockDirectives`), never a cassette: the mock echoes the prompt as
 * `Echo:\n<prompt>` (newline-separated so a column-0-sensitive prompt keeps its
 * shape) with a tiny inline authoritative cost, so a regenerated
 * turn's content and charge are both reproducible without a recorded exchange.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for chat regenerate integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([9, 9, 9]);
const decoder = new TextDecoder();
const MODEL = `chat-route-regen/${crypto.randomUUID().slice(0, 8)}`;
// A stable body hash: the run referee scopes a claim by (userId, route, runKey),
// so a fresh runKey per turn already isolates rows; the replay test reuses one
// runKey with THIS same hash to exercise the settled-row replay path.
const BODY_HASH = 'regenerate-body-hash';
/**
 * The fixture model's catalog token rates. The OUTPUT rate is load-bearing, not
 * decoration: it is what keeps this file's observed-cost proof from being
 * vacuous. Every answer spends at least one output token, so the catalog price
 * of any answer here starts an order of magnitude above the mock provider's
 * whole inline billable figure, and the two candidate costs cannot coincide.
 */
const CATALOG_INPUT_PER_TOKEN_NANO = 2500n;
const CATALOG_OUTPUT_PER_TOKEN_NANO = 10_000n;

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
    .where(eq(epochs.conversationId, conversationId))
    .orderBy(asc(epochs.epochNumber));
  return rows.find((_row, index) => index + 1 === epochNumber)?.key ?? rows[0]?.key ?? null;
};

const rt = createConversationRuntime({
  db,
  redis,
  telemetry: silentTelemetry,
  apiKey: 'mock-key',
  searchApiKey: 'mock-key',
  isCI: false,
  // The paramount production-inert gate: only with this true (dev/E2E) does a
  // run's `mockDirectives` select the deterministic mock instead of OpenRouter.
  mockProviderEnabled: true,
  chatStores: createChatStores(),
  // These text-turn regenerates must never reach storage; a throwing proxy proves it.
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
          anchor: {
            base: {
              input: CATALOG_INPUT_PER_TOKEN_NANO.toString(),
              output: CATALOG_OUTPUT_PER_TOKEN_NANO.toString(),
            },
            tiers: [],
          },
        },
        zdrReachable: true,
        releasedAt: FIXTURE_STAMP_SECONDS,
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

interface Fixture {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
}

/** A funded owner with a real epoch keypair so settlement can wrap real content. */
async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@regen.test`,
        username: `rg${suffix}`,
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

  // Ample balance so admission never blocks and no output-token ceiling bites.
  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: 1_000_000_000_000n })
    .returning({ id: wallets.id });
  const walletId = first(walletRows, 'wallet').id;

  const keyPair = generateEpochKeyPair();
  const { conversationId, epochId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: keyPair.publicKey,
  });
  createdConversationIds.push(conversationId);

  // The member-keyed epoch-at-persist gate verifies the sender's public key
  // against the authoritative `epoch_members` wrap-set; the initiator's key
  // (users.publicKey === BYTES) is a member of epoch 1.
  await db.insert(epochMembers).values({
    epochId,
    memberPublicKey: BYTES,
    wrap: BYTES,
    visibleFromEpoch: 1,
  });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return { userId, walletId, conversationId, epochPrivateKey: keyPair.privateKey };
}

interface DrivenTurn {
  readonly outcome: FlowRunOutcome;
  readonly runId: string;
  readonly runKey: string;
  /**
   * The PRE-RUN estimate the definition's admission hook was handed — the run
   * priced at its declared ceiling, and the figure the wallet hold was taken
   * against. Captured by wrapping the bound hook, so a money assertion can hold
   * what was estimated BEFORE the provider call against what was charged after
   * it. Absent only when a run failed before admission ran.
   */
  readonly admissionEstimateNanoUsd?: bigint;
}

/**
 * Drive one paid turn through the runtime exactly as the DO does: claim the
 * run referee, bind the definition's policy hooks over the run context, and
 * start the real executor with the deterministic mock selected (empty
 * `mockDirectives` is defined, so the mock — not OpenRouter — answers). Awaits
 * settlement, then releases the admission hold like the DO's terminal sink.
 */
async function driveTurn(
  fixture: Fixture,
  userMessage: { readonly id: string; readonly content: string },
  regenerate?: RegenerateAction
): Promise<DrivenTurn> {
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
    throw new Error(`expected a fresh executor claim, got ${claim.outcome}`);

  const context: RunContext = {
    ...identity,
    runId,
    fence: claim.fence,
    mockDirectives: {},
    ...(regenerate === undefined ? {} : { regenerate }),
  };
  // The real bound hooks, with admission wrapped only to record the estimate it
  // was handed: the decision itself is the production hook's, untouched.
  const bound = rt.bindHooks(context, definition);
  let admissionEstimateNanoUsd: bigint | undefined;
  const hooks: ChatHookBindings = {
    ...bound,
    admission: async (request) => {
      admissionEstimateNanoUsd = request.estimate;
      return bound.admission(request);
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
  // Free the wallet's hold like the DO does, so the next turn on this wallet
  // admits on balance alone rather than tripping the concurrent-hold guard.
  if (admission.admitted && admission.hold !== undefined) await rt.releaseHold(admission.hold);
  return {
    outcome,
    runId,
    runKey,
    ...(admissionEstimateNanoUsd === undefined ? {} : { admissionEstimateNanoUsd }),
  };
}

interface MessageRow {
  readonly id: string;
  readonly senderType: string;
  readonly parentMessageId: string | null;
  readonly sequenceNumber: number;
  readonly wrappedContentKey: Uint8Array | null;
}

async function messagesInOrder(conversationId: string): Promise<MessageRow[]> {
  return db
    .select({
      id: messages.id,
      senderType: messages.senderType,
      parentMessageId: messages.parentMessageId,
      sequenceNumber: messages.sequenceNumber,
      wrappedContentKey: messages.wrappedContentKey,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sequenceNumber));
}

/**
 * Decrypt an assistant reply's text content to prove the mock produced it. The
 * assistant reply's AAD binds `ASSISTANT_SENDER_ID` (settlement stamps every
 * generated reply with it), not a user id.
 */
async function replyText(fixture: Fixture, message: MessageRow): Promise<string> {
  const contentRows = await db
    .select()
    .from(contentItems)
    .where(eq(contentItems.messageId, message.id));
  const content = first(contentRows, 'content item');
  if (message.wrappedContentKey === null || content.encryptedBlob === null) {
    throw new Error('ciphertext missing on the regenerated reply');
  }
  const wrapped = message.wrappedContentKey as WrappedSecret;
  const contentKey = unwrapContentKeyFromEpoch(fixture.epochPrivateKey, wrapped);
  const plaintext = decryptContentEnvelope(
    contentKey,
    wrapped,
    {
      conversationId: fixture.conversationId,
      messageId: message.id,
      contentItemId: content.id,
      position: 0,
      epochNumber: 1,
      senderId: ASSISTANT_SENDER_ID,
    },
    content.encryptedBlob
  );
  return decoder.decode(plaintext);
}

describe('chat regenerate turn (end to end — runtime + mock provider + settlement)', () => {
  it('retry-all deletes the old reply, persists the mock-echoed reply, and bills the new generation', async () => {
    const fixture = await seedFixture();

    // A fresh send establishes the anchor turn: user message + assistant reply.
    const anchor = { id: crypto.randomUUID(), content: 'first prompt' };
    const fresh = await driveTurn(fixture, anchor);
    expect(fresh.outcome.outcome).toBe('succeeded');

    const afterSend = await messagesInOrder(fixture.conversationId);
    expect(afterSend).toHaveLength(2);
    const seededUser = first(afterSend, 'user message');
    const seededReply = afterSend[1];
    if (seededReply === undefined) throw new Error('expected the seeded assistant reply');
    expect(seededUser.senderType).toBe('user');
    expect(seededReply.senderType).toBe('assistant');
    expect(seededReply.parentMessageId).toBe(seededUser.id);
    // Saved ⟺ billed on the fresh send: exactly one charge for the run.
    const seedCharges = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.runId, fresh.runId));
    expect(seedCharges).toHaveLength(1);

    // Regenerate (retry-all): the anchor user message is kept; its reply is
    // replaced by a freshly generated one. The re-sent prompt feeds inference.
    const regen = await driveTurn(
      fixture,
      { id: crypto.randomUUID(), content: 'first prompt' },
      { action: 'retry', targetMessageId: seededUser.id }
    );
    expect(regen.outcome.outcome).toBe('succeeded');

    const afterRegen = await messagesInOrder(fixture.conversationId);
    // The anchor survives; the old reply is gone; one fresh reply re-parents
    // onto the anchor at a strictly higher sequence (sequences never reused).
    expect(afterRegen.map((row) => row.id)).toEqual([seededUser.id, expect.any(String)]);
    const newReply = afterRegen[1];
    if (newReply === undefined) throw new Error('expected the regenerated reply');
    expect(newReply.id).not.toBe(seededReply.id);
    expect(newReply.senderType).toBe('assistant');
    expect(newReply.parentMessageId).toBe(seededUser.id);
    expect(newReply.sequenceNumber).toBeGreaterThan(seededReply.sequenceNumber);
    // The mock provider echoes the prompt (`Echo:\n<prompt>`) then appends a
    // trailing fenced JSON block — the streamdown incomplete-markdown / SSE
    // multi-line fidelity fence. Assert the full regenerated content round-trips
    // through settlement, fence included.
    expect(await replyText(fixture, newReply)).toBe(
      'Echo:\nfirst prompt\n\n```json\n{\n  "ok": true\n}\n```'
    );

    // The new generation is billed (saved ⟺ billed) with a live content FK.
    const newCharges = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.runId, regen.runId));
    expect(newCharges).toHaveLength(1);
    const newCharge = first(newCharges, 'new usage record');
    expect(newCharge.contentItemId).not.toBeNull();
    expect(newCharge.costNanoUsd).toBeGreaterThan(0n);

    // Financial retention: the original charge row stands, only its content FK
    // nulled by the deleted reply's cascade — money is never destroyed.
    const oldCharge = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, fresh.runId)),
      'original usage record'
    );
    expect(oldCharge.contentItemId).toBeNull();
  });

  it('bills the provider-observed inline cost rather than the estimate the run was admitted on', async () => {
    const fixture = await seedFixture();
    const prompt = 'observed cost prompt';
    const turn = await driveTurn(fixture, { id: crypto.randomUUID(), content: prompt });
    expect(turn.outcome.outcome).toBe('succeeded');

    const turnMessages = await messagesInOrder(fixture.conversationId);
    const reply = turnMessages[1];
    if (reply === undefined) throw new Error('expected the assistant reply');
    const answer = await replyText(fixture, reply);
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, turn.runId)),
      'usage record'
    );
    const completion = first(
      await db.select().from(llmCompletions).where(eq(llmCompletions.usageRecordId, usage.id)),
      'completion'
    );

    // Two DIFFERENT costs are live on this one run, which is what makes the
    // assertion below discriminate rather than restate. The pre-run estimate
    // priced the declared ceiling and the wallet hold was taken against it; the
    // observed cost arrived on the provider's finish event and converts at the
    // port's own markup seam. They cannot collide: the answer spends output
    // tokens, and the catalog price of a SINGLE output token already exceeds the
    // whole observed billable figure.
    const observedBillable = providerUsdToBillableNanoUsd(MOCK_GENERATION_COST_USD);
    expect(completion.outputTokens).toBeGreaterThan(0);
    expect(observedBillable).toBeLessThan(CATALOG_OUTPUT_PER_TOKEN_NANO);
    expect(turn.admissionEstimateNanoUsd).toBeGreaterThan(observedBillable);

    // The committed row carries the OBSERVED figure plus the turn's additive
    // storage fee, flagged exact — neither estimate reaches the ledger. Pricing
    // the estimate instead would leave every other settlement-layer money test
    // green, because each of those hands settlement a cost it constructed
    // itself; only a run that actually calls the provider can tell the two
    // apart.
    const storageFee = BigInt(prompt.length + answer.length) * STORAGE_COST_PER_CHARACTER_NANO;
    expect(usage.costNanoUsd).toBe(observedBillable + storageFee);
    expect(usage.isEstimated).toBe(false);
  });

  it('replays a retried regenerate under the same run key without a second execution or charge', async () => {
    const fixture = await seedFixture();

    const anchor = { id: crypto.randomUUID(), content: 'idem prompt' };
    const fresh = await driveTurn(fixture, anchor);
    expect(fresh.outcome.outcome).toBe('succeeded');
    const seededUser = first(await messagesInOrder(fixture.conversationId), 'user message');

    // First regenerate settles and flips its key row to succeeded.
    const regen = await driveTurn(
      fixture,
      { id: crypto.randomUUID(), content: 'idem prompt' },
      { action: 'retry', targetMessageId: seededUser.id }
    );
    expect(regen.outcome.outcome).toBe('succeeded');

    const messagesBefore = await messagesInOrder(fixture.conversationId);
    const chargesBefore = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(eq(usageRecords.runId, regen.runId));
    expect(chargesBefore).toHaveLength(1);

    // A retry of the SAME run key (the client's Idempotency-Key) resolves at the
    // referee as a replay — the settled response, never a second execution.
    const replay = await rt.claimRun({
      runKey: regen.runKey,
      runId: crypto.randomUUID(),
      bodyHash: BODY_HASH,
      identity: {
        mode: 'paid',
        payerUserId: fixture.userId,
        sender: { kind: 'user', userId: fixture.userId },
        conversationId: fixture.conversationId,
        walletId: fixture.walletId,
        epochNumber: 1,
        userMessage: { id: crypto.randomUUID(), content: 'idem prompt' },
      },
    });
    expect(replay.outcome).toBe('replay');

    // No second reply, no second charge: the DB is byte-for-byte where it was.
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(messagesBefore.length);
    const chargesAfter = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(eq(usageRecords.runId, regen.runId));
    expect(chargesAfter).toHaveLength(1);
  });
});
