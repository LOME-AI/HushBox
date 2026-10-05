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
  modelCatalog,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { providerUsdToBillableNanoUsd } from '../../../billing/index.js';
import { createEstimateRun, createModelPricingResolver } from '../../../models/index.js';
import { createWorkflowExecutor } from '../../../workflows/index.js';
import { createR2Storage } from '../../../media/index.js';
import { createChatStores } from '../../adapters/stores.js';
import { CHAT_TURN_INPUT } from '../constants.js';
import { adaptersFor, createConversationRuntime, createTurnExecutionRegistry } from '../runtime.js';
import { buildTurnDefinition, createTurnCompileRegistries } from '../turn/definition.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type {
  FlowRunOutcome,
  InferenceEvent,
  RunContext,
  RunIdentity,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { ModelProvider } from '../../../models/index.js';
import type { Storage } from '../../../media/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

/**
 * A bill above its hold, end to end on the local stack: a real turn definition
 * priced against a seeded long-context catalog row, the real chat admission and
 * fenced settlement, and a provider that reports more input than the turn
 * reserved. Telemetry and the provider are the only fakes.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for hold-overrun integration tests'
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the hold-overrun integration tests`);
  }
  return value;
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([9, 9, 9]);
const MODEL = `hold-overrun/${crypto.randomUUID().slice(0, 8)}`;
const WALLET_BALANCE = 1_000_000_000_000n;

/** The turn's new message: 88 characters, the only input it stores. */
const NEW_MESSAGE = 'x'.repeat(88);
/** What the provider is sent: 570,000 characters, so the turn reserves a 190,000-token prompt. */
const PROMPT_CHARS = 570_000;
/** The answer cap the model's catalog row allows. */
const OUTPUT_CAP = 64_000;

/** What the fake provider reports: one step past the 200,000-token tier, at the output cap. */
const OBSERVED_INPUT_TOKENS = 205_000;
const OBSERVED_OUTPUT_TOKENS = 64_000;
const STORED_ANSWER = 'a'.repeat(320_000);
const INLINE_COST_USD = 2.67;

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

function recordingTelemetry(): Telemetry {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), captureError: vi.fn() };
}

/** A sink that refuses every capture, as a Sentry outage would. */
function throwingTelemetry(): Telemetry {
  return {
    ...recordingTelemetry(),
    captureError: vi.fn(() => {
      throw new Error('sink down');
    }),
  };
}

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

/** The provider: one step of 205,000 input and 64,000 output tokens, 320,000 stored characters, $2.67 inline. */
const provider: ModelProvider = {
  infer: () =>
    (async function* stream(): AsyncGenerator<InferenceEvent> {
      await Promise.resolve();
      yield { kind: 'step-start', step: 0 };
      yield { kind: 'text-delta', index: 0, content: STORED_ANSWER };
      const usage = { inputTokens: OBSERVED_INPUT_TOKENS, outputTokens: OBSERVED_OUTPUT_TOKENS };
      yield {
        kind: 'step-finish',
        step: 0,
        generationId: 'gen-overrun',
        usage,
        providerCostUsd: INLINE_COST_USD,
      };
      yield {
        kind: 'finish',
        metadata: {
          usage,
          finishReason: 'length',
          providerCostUsd: INLINE_COST_USD,
          generationId: 'gen-overrun',
        },
      };
    })(),
};

beforeAll(async () => {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '4',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 1_000_000, maxOutputTokens: OUTPUT_CAP },
        // Sonnet 4.5's anchor: dearer rates once a request passes 200,000 prompt tokens.
        pricing: {
          kind: 'tokens',
          anchorContextTokens: 1_000_000,
          anchor: {
            base: { input: '3450', output: '17250' },
            tiers: [{ abovePromptTokens: 200_000, rates: { input: '6900', output: '25875' } }],
          },
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
        email: `${suffix}@hold-overrun.test`,
        username: `ho${suffix}`,
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

async function turnDefinition(): Promise<WorkflowDefinition> {
  const built = await buildTurnDefinition({ db, telemetry: recordingTelemetry() }, MODEL, {
    budget: {
      promptCharacterCount: PROMPT_CHARS,
      inputCharacterCount: NEW_MESSAGE.length,
      funding: { kind: 'purchased', spendableNanoUsd: WALLET_BALANCE },
    },
  });
  return built._unsafeUnwrap();
}

/** The run's executor: the runtime's own composition, with the fake provider in the mock's place. */
async function executorWith(
  telemetry: Telemetry
): Promise<ReturnType<typeof createWorkflowExecutor>> {
  const resolved = await createModelPricingResolver({ db, telemetry: recordingTelemetry() });
  const resolver = resolved._unsafeUnwrap();
  const compile = createTurnCompileRegistries(resolver);
  const { tools } = adaptersFor(
    {
      mockProviderEnabled: true,
      apiKey: '',
      searchApiKey: '',
      isCI: false,
      telemetry,
    },
    {}
  );
  return createWorkflowExecutor({
    registries: { nodes: compile.nodes, constraints: compile.constraints },
    execution: createTurnExecutionRegistry({
      provider,
      tools,
      models: compile.models,
      compute: compile.compute,
      constraints: compile.constraints,
      telemetry,
    }),
    estimateRun: createEstimateRun(resolver),
    clock: { now: () => Date.now() },
    rng: { random: () => 0.5 },
    telemetry,
  });
}

function runtimeWith(telemetry: Telemetry): ReturnType<typeof createConversationRuntime> {
  return createConversationRuntime({
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
}

interface SettledRun {
  readonly outcome: FlowRunOutcome;
  readonly runKey: string;
  readonly runId: string;
  readonly identity: RunIdentity;
  readonly holdNanoUsd: bigint;
}

/** Claims, admits, runs and settles one turn through the runtime's hooks. */
async function settleTurn(fixture: Fixture, telemetry: Telemetry): Promise<SettledRun> {
  const definition = await turnDefinition();
  const rt = runtimeWith(telemetry);
  const runKey = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const identity: RunIdentity = {
    mode: 'paid',
    payerUserId: fixture.userId,
    sender: { kind: 'user', userId: fixture.userId },
    conversationId: fixture.conversationId,
    walletId: fixture.walletId,
    epochNumber: 1,
    userMessage: { id: crypto.randomUUID(), content: NEW_MESSAGE },
  };
  const claim = await rt.claimRun({ runKey, runId, bodyHash: 'hold-overrun', identity });
  if (claim.outcome !== 'executor') {
    throw new Error(`expected a fresh executor claim, got ${claim.outcome}`);
  }
  const context: RunContext = { ...identity, runId, fence: claim.fence };
  const hooks = rt.bindHooks(context, definition);
  const holds: bigint[] = [];
  const executor = await executorWith(telemetry);
  const handle = executor.start({
    definition,
    inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: NEW_MESSAGE } },
    hooks: {
      ...hooks,
      admission: (request) => {
        holds.push(request.estimate);
        return hooks.admission(request);
      },
    },
    runKey,
    runId,
    emit: () => undefined,
  });
  const outcome = await handle.done;
  const admission = await handle.admitted;
  if (admission.admitted && admission.hold !== undefined) await rt.releaseHold(admission.hold);
  return { outcome, runKey, runId, identity, holdNanoUsd: first(holds, 'admitted hold') };
}

async function walletBalance(walletId: string): Promise<bigint> {
  const rows = await db
    .select({ balance: wallets.balanceNanoUsd })
    .from(wallets)
    .where(eq(wallets.id, walletId));
  return first(rows, 'wallet').balance;
}

function overrunCaptures(telemetry: Telemetry): unknown[][] {
  return vi
    .mocked(telemetry.captureError)
    .mock.calls.filter((call) => call[1] === 'settlement_above_hold');
}

describe('a settled bill above its hold', () => {
  it('debits the actual bill and captures one event naming the input estimate and the crossed tier', async () => {
    const fixture = await seedFixture();
    const telemetry = recordingTelemetry();

    const run = await settleTurn(fixture, telemetry);

    expect(run.outcome).toEqual({ outcome: 'succeeded' });
    // 190,000 prompt tokens × 4,313 + 64,000 × (21,563 + 1,500 output storage)
    // + 640 framing characters × 300 + 88 new characters × 300.
    expect(run.holdNanoUsd).toBe(2_295_720_400n);
    const usage = first(
      await db
        .select({ cost: usageRecords.costNanoUsd })
        .from(usageRecords)
        .where(eq(usageRecords.runId, run.runId)),
      'usage'
    );
    // $2.67 inline, billed once at its one rounding.
    const bill = providerUsdToBillableNanoUsd(INLINE_COST_USD);
    expect(bill).toBe(3_070_500_000n);
    // The bill plus 320,000 + 88 stored characters × 300.
    expect(usage.cost).toBe(bill + 96_026_400n);
    expect(usage.cost).toBe(3_166_526_400n);
    expect(await walletBalance(fixture.walletId)).toBe(WALLET_BALANCE - 3_166_526_400n);
    const captures = overrunCaptures(telemetry);
    expect(captures).toHaveLength(1);
    const [error] = captures[0] ?? [];
    expect(error).toMatchObject({
      runId: run.runId,
      holdNanoUsd: '2295720400',
      billedNanoUsd: '3166526400',
      // The bill is within the observed step's ceiling at the tier it reached
      // (3,838,141,000, measured in the price core's hold-overrun test), so the
      // rate leg stays silent.
      legs: 'input-above-estimate,tier-crossed',
      billing: 'inline',
    });
  });

  it('leaves the rows committed and the run succeeded when the capture throws', async () => {
    const fixture = await seedFixture();
    const telemetry = throwingTelemetry();

    const run = await settleTurn(fixture, telemetry);

    expect(run.outcome).toEqual({ outcome: 'succeeded' });
    expect(overrunCaptures(telemetry)).toHaveLength(1);
    expect(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, run.runId))
    ).toHaveLength(1);
    expect(await walletBalance(fixture.walletId)).toBe(WALLET_BALANCE - 3_166_526_400n);
  });

  it('replays a second claim under the same idempotency key and adds no capture', async () => {
    const fixture = await seedFixture();
    const telemetry = recordingTelemetry();
    const run = await settleTurn(fixture, telemetry);

    const replay = await runtimeWith(telemetry).claimRun({
      runKey: run.runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'hold-overrun',
      identity: run.identity,
    });

    expect(replay.outcome).toBe('replay');
    expect(overrunCaptures(telemetry)).toHaveLength(1);
    expect(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, run.runId))
    ).toHaveLength(1);
  });
});
