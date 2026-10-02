import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PAID_CUSHION_NANO_USD } from '@hushbox/shared';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  modelCatalog,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { createBillingStores } from '../../../billing/index.js';
import { createConversationsStores } from '../../../conversations/index.js';
import { resolveTurnContext } from './context.js';
import { buildMultiModelTurnDefinition, buildTurnDefinition } from './definition.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { ModelReasoning } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for turn-definition integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([3, 3, 3]);
const MODEL = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
const REASONING_MODEL = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
const variantModelIds: string[] = [];
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db
    .delete(modelCatalog)
    .where(inArray(modelCatalog.modelId, [MODEL, REASONING_MODEL, ...variantModelIds]));
  await db.$client.end();
});

/** Billable rates 2500 / 10_000 nano-USD per token, context window 128_000. */
async function seedModel(): Promise<void> {
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
        releasedAt: FIXTURE_STAMP_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

/** Same rates/window as {@link seedModel}, plus open-effort reasoning metadata. */
async function seedReasoningModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: REASONING_MODEL,
      descriptor: {
        id: REASONING_MODEL,
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
        releasedAt: FIXTURE_STAMP_SECONDS,
        fetchedAt: 0,
        reasoning: { supportedEfforts: null },
      },
    })
    .onConflictDoNothing();
}

/** A fresh catalog id for one variant model, tracked for cleanup. */
function openModel(): string {
  const id = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
  variantModelIds.push(id);
  return id;
}

/** Same rates/window as {@link seedModel} with the given reasoning metadata. */
async function seedVariantModel(modelId: string, reasoning?: ModelReasoning): Promise<void> {
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
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: {
          kind: 'tokens',
          anchor: { base: { input: '2500', output: '10000' }, tiers: [] },
        },
        zdrReachable: true,
        releasedAt: FIXTURE_STAMP_SECONDS,
        fetchedAt: 0,
        ...(reasoning === undefined ? {} : { reasoning }),
      },
    })
    .onConflictDoNothing();
}

async function seedUser(balanceNanoUsd: bigint): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@turn-ceiling.test`,
        username: `tc${suffix}`,
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
  await db.insert(wallets).values({ userId: id, type: 'purchased', balanceNanoUsd });
  return id;
}

async function seedConversation(userId: string): Promise<string> {
  const { conversationId } = await seedConversationWithEpoch(db, { userId, title: BYTES });
  createdConversationIds.push(conversationId);
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return conversationId;
}

/** The chat turn path: context (payer funding) → definition → answer node. */
async function builtAnswerParams(balanceNanoUsd: bigint): Promise<Record<string, unknown>> {
  const userId = await seedUser(balanceNanoUsd);
  const conversationId = await seedConversation(userId);
  const context = await resolveTurnContext(
    { conversations: createConversationsStores, billing: createBillingStores() },
    db,
    {
      conversationId,
      sender: { kind: 'user', userId },
      now: new Date(),
      // A solo turn never reaches the group comparison, so the priced minimum
      // is inert here; the freeze prices one regardless, so no caller can omit
      // it where it counts. An empty snapshot prices nothing.
      exposedCatalog: [],
      selection: { turnSources: [{ kind: 'model', id: MODEL }] },
      promptCharacterCount: 'hello world'.length,
      inputCharacterCount: 'hello world'.length,
    }
  );
  const funding = context._unsafeUnwrap().funding;
  await seedModel();
  const definition = await buildTurnDefinition({ db, telemetry: silentTelemetry }, MODEL, {
    budget: {
      promptCharacterCount: 'hello world'.length,
      inputCharacterCount: 'hello world'.length,
      funding,
    },
  });
  const answer = definition._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
  if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
  return answer.params;
}

describe('the chat turn path output-token ceiling', () => {
  it('builds a low-balance payer a capped modelCall bound by what the money buys', async () => {
    // $0.10 balance: estInput = ceil(11/3) = 4; billable rates 2500/10_000, held
    // at their ceilings 3125/12_500;
    // fixed = 4×3125 + 11×300 + 640×300 framing = 207_800;
    // variable = 12_500 + 5×300 stored output = 14_000;
    // effective = 100_000_000 + 500_000_000 cushion →
    // maxOutputTokens = floor(599_792_200/14_000) = 42_842. Where money binds, the
    // canonical estimator's own fit lands on the same token count.
    const params = await builtAnswerParams(100_000_000n);
    expect(params).toEqual({ maxOutputTokens: 42_842 });
  });

  it('caps a rich payer at the context headroom, the tightest bound left once money is loose', async () => {
    // $10,000 balance, so `budgetBuys` is far past this model's room and the PROMPT
    // is what binds: BILLING §Model bounds' ceiling = min(providerCap,
    // contextHeadroom, budgetBuys) = 128_000 − ceil(11/3) = 127_996. The cap used to
    // be omitted here, which left admission pricing the full 128,000-token window —
    // more than the ceiling the specification names, and a wire cap with no money
    // term behind it on the trial arm of the same code path.
    const params = await builtAnswerParams(10_000_000_000_000n);
    expect(params).toEqual({ maxOutputTokens: 128_000 - Math.ceil('hello world'.length / 3) });
  });
});

describe('the reasoning turn build fail-fasts', () => {
  it('refuses a reasoning build with no payer budget (no sizing basis for the explicit cap)', async () => {
    await seedReasoningModel();
    const result = await buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
      reasoningEffort: 'low',
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('caps an unaffordable reasoning turn at B plus the minimum answer so admission refuses it', async () => {
    // A free payer whose funds cannot cover B + the 1000-token minimum answer:
    // the build keeps an EXPLICIT B + MINIMUM cap with no guess for the answer fit,
    // and admission's balance gate — not a silent effort downgrade — refuses.
    await seedReasoningModel();
    const result = await buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
      budget: {
        promptCharacterCount: 5,
        inputCharacterCount: 5,
        funding: { kind: 'free', spendableNanoUsd: 1_000_000n },
      },
      reasoningEffort: 'low',
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    expect(answer.params).toEqual({
      // low B = 4096 + the 1000-token minimum answer allocation.
      maxOutputTokens: 5096,
      reasoning: { effort: 'low' },
    });
  });
});

describe('multi-model effort resolution (union choice set, per-model downgrade)', () => {
  const RICH = {
    promptCharacterCount: 'hello world'.length,
    inputCharacterCount: 'hello world'.length,
    funding: { kind: 'purchased', spendableNanoUsd: 100_000_000_000n },
  } as const;

  /** Every sibling's wire, in selected order, for a multi-model text build. */
  async function siblingWires(
    models: readonly { readonly id: string; readonly reasoning?: ModelReasoning }[],
    reasoningEffort: 'lite' | 'low' | 'medium' | 'high' | 'max' | 'off'
  ): Promise<unknown[]> {
    for (const model of models) await seedVariantModel(model.id, model.reasoning);
    const result = await buildMultiModelTurnDefinition(
      { db, telemetry: silentTelemetry },
      models.map((model) => model.id),
      { budget: RICH, reasoningEffort, now: new Date(TEST_DAY_START) }
    );
    const outcome = result._unsafeUnwrap();
    if (outcome.kind !== 'built') throw new Error('expected a built turn');
    return outcome.definition.nodes
      .filter((node) => node.type === 'modelCall')
      .map((node) => node.params['reasoning']);
  }

  it('resolves a level a sibling lacks per model instead of refusing the whole turn', async () => {
    // The union offers Low (the open-ladder sibling); the High-only sibling has
    // nothing at or below it and can disable, so it runs reasoning-off — where
    // the every-model unanimity rule used to 400 the build.
    const wires = await siblingWires(
      [
        { id: openModel(), reasoning: { supportedEfforts: null } },
        { id: openModel(), reasoning: { supportedEfforts: ['high'] } },
      ],
      'low'
    );
    expect(wires).toEqual([{ effort: 'low' }, { enabled: false }]);
  });

  it('runs a mandatory sibling at its LOWEST rung when the choice sits below its ladder', async () => {
    const wires = await siblingWires(
      [
        { id: openModel(), reasoning: { supportedEfforts: null } },
        { id: openModel(), reasoning: { supportedEfforts: ['hi', 'lo'], mandatory: true } },
      ],
      'lite'
    );
    expect(wires).toEqual([{ effort: 'minimal' }, { effort: 'lo' }]);
  });

  it('wires the union pick verbatim on every sibling that offers it', async () => {
    const wires = await siblingWires(
      [
        { id: openModel(), reasoning: { supportedEfforts: null } },
        { id: openModel(), reasoning: { supportedEfforts: ['hi', 'lo'] } },
      ],
      'high'
    );
    expect(wires).toEqual([{ effort: 'high' }, { effort: 'hi' }]);
  });

  it('leaves a non-reasoning sibling wire-silent (no entry, no refusal)', async () => {
    const wires = await siblingWires(
      [{ id: openModel(), reasoning: { supportedEfforts: null } }, { id: openModel() }],
      'medium'
    );
    expect(wires).toEqual([{ effort: 'medium' }, undefined]);
  });

  it('refuses a choice outside the union option set with a typed validation error', async () => {
    const models = [
      { id: openModel(), reasoning: { supportedEfforts: ['high'] } },
      { id: openModel(), reasoning: { supportedEfforts: ['high'] } },
    ];
    for (const model of models) await seedVariantModel(model.id, model.reasoning);
    const result = await buildMultiModelTurnDefinition(
      { db, telemetry: silentTelemetry },
      models.map((model) => model.id),
      { budget: RICH, reasoningEffort: 'low', now: new Date(TEST_DAY_START) }
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('keeps the single-model explicit refusal: an unoffered level still 400s', async () => {
    const model = openModel();
    await seedVariantModel(model, { supportedEfforts: ['high'] });
    const result = await buildTurnDefinition({ db, telemetry: silentTelemetry }, model, {
      budget: RICH,
      reasoningEffort: 'low',
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it("picks the sole real choice for 'auto' on a Min-only model (no classifier, no reserve)", async () => {
    const model = openModel();
    await seedVariantModel(model, { supportedEfforts: ['none'] });
    const result = await buildTurnDefinition({ db, telemetry: silentTelemetry }, model, {
      budget: RICH,
      reasoningEffort: 'auto',
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    expect(answer.params['reasoning']).toEqual({ enabled: false });
  });
});

describe("the hard-off ('off') turn build", () => {
  async function noneAnswerParams(
    options: Parameters<typeof buildTurnDefinition>[2]
  ): Promise<Record<string, unknown>> {
    await seedReasoningModel();
    const result = await buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
      ...options,
      reasoningEffort: 'off',
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    return answer.params;
  }

  it('wires { enabled: false } with exactly the reasoning-free answer cap (B=0, cap = H)', async () => {
    // Same $0.10 payer as the reasoning-free derivation test, so the frozen
    // spendable figure is that balance plus its cushion, exactly as the freeze
    // produces it: the cap must be byte-identical to a plain turn's — the off
    // wire adds no B term.
    const params = await noneAnswerParams({
      budget: {
        promptCharacterCount: 'hello world'.length,
        inputCharacterCount: 'hello world'.length,
        funding: {
          kind: 'purchased',
          spendableNanoUsd: 100_000_000n + PAID_CUSHION_NANO_USD,
        },
      },
    });
    expect(params).toEqual({ maxOutputTokens: 42_842, reasoning: { enabled: false } });
  });

  it('builds a budget-less (trial) hard-off turn uncapped, like a plain trial turn', async () => {
    const params = await noneAnswerParams({});
    expect(params).toEqual({ reasoning: { enabled: false } });
  });
});
