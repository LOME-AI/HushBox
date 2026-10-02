import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog, users, wallets } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { createBillingStores } from '../../../billing/index.js';
import { listDescriptors } from '../../../models/index.js';
import { turnMinCost } from '../turn/pricing.js';
import { buildSmartModelTurnDefinition, buildTrialSmartModelTurnDefinition } from './turn.js';
import type { TurnBudget } from '../turn/definition.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for smart-model-turn integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([4, 4, 4]);
const MODEL = `chat-route-smart/${crypto.randomUUID().slice(0, 8)}`;
const REASONING_MODEL = `chat-route-smart/${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db
    .delete(modelCatalog)
    .where(
      inArray(modelCatalog.modelId, [
        MODEL,
        REASONING_MODEL,
        DEAR_TRIAL_MODEL,
        SEARCH_SLOT_MODEL,
        SEARCH_PINNED_MODEL,
      ])
    );
  await db.$client.end();
});

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
        pricing: { kind: 'tokens', anchor: { base: { input: '2', output: '3' }, tiers: [] } },
        zdrReachable: true,
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

/** A trial-eligible reasoning-capable text model (effort-native full ladder). */
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
        pricing: { kind: 'tokens', anchor: { base: { input: '2', output: '3' }, tiers: [] } },
        reasoning: { supportedEfforts: null },
        zdrReachable: true,
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

async function seedRichUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@smart-turn.test`,
        username: `sm${suffix}`,
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
  // A large purchased balance keeps every exposed text model affordable, so a
  // candidate is always derivable regardless of which other rows the catalog
  // holds.
  await db
    .insert(wallets)
    .values({ userId: id, type: 'purchased', balanceNanoUsd: 1_000_000_000_000n });
  return id;
}

async function seedBrokeUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@smart-turn.test`,
        username: `sm${suffix}`,
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
  // Zero purchased balance: the group-member / free-tier shape whose spend is
  // funded by the budget's effective funding, not their own wallet.
  await db.insert(wallets).values({ userId: id, type: 'purchased', balanceNanoUsd: 0n });
  return id;
}

describe('buildSmartModelTurnDefinition with a budget', () => {
  it('filters candidates by the effective turn funding, not the sender wallet', async () => {
    const userId = await seedBrokeUser();
    await db.delete(modelCatalog);
    await seedModel();
    const build = await buildSmartModelTurnDefinition(
      { db, telemetry: silentTelemetry, billing: createBillingStores() },
      {
        userId,
        now: new Date(),
        budget: {
          promptCharacterCount: 400,
          inputCharacterCount: 400,
          // $5 of effective funding (owner-funded / free-allowance turn):
          // ample for the seeded model even though the sender holds $0.
          funding: { spendableNanoUsd: 5_000_000_000n, kind: 'purchased' },
        },
      }
    );
    const value = build._unsafeUnwrap();
    expect(value.buildable).toBe(true);
  });

  /**
   * The candidate menu must never be STRICTER than the payer freeze that chose
   * the payer. Both price §Smart Model 5's balance-independent minimum over the
   * same catalog at the same tier, so their only reachable disagreement is the
   * storage basis: the freeze prices storage over the new user message, and the
   * turn build has to forward that same count rather than the assembled
   * prompt's. Widened back to the whole prompt, the menu's minimum rises by the
   * replayed history's storage — headroom clears the freeze, the candidate set
   * then comes back empty, and the send is refused after the funding decision
   * has already been made. Funded at EXACTLY the frozen figure, which is the one
   * balance at which the two bases can be told apart.
   */
  it('draws a candidate menu at the exact balance the payer freeze called sufficient', async () => {
    const userId = await seedBrokeUser();
    const deps = { db, telemetry: silentTelemetry, billing: createBillingStores() };
    await db.delete(modelCatalog);
    await seedModel();
    // A short new message inside a long replayed prompt: the 20,000-character
    // remainder is exactly what the two storage bases disagree about.
    const counts = { promptCharacterCount: 20_400, inputCharacterCount: 400 };
    const exposed = await listDescriptors(deps);
    const frozen = turnMinCost(
      exposed._unsafeUnwrap(),
      { turnSources: [{ kind: 'smart' }] },
      counts
    );
    if (frozen === undefined) throw new Error('expected the seeded catalog to price the slot');
    const build = await buildSmartModelTurnDefinition(deps, {
      userId,
      now: new Date(),
      budget: { ...counts, funding: { spendableNanoUsd: frozen, kind: 'purchased' } },
    });
    expect(build._unsafeUnwrap().buildable).toBe(true);
  });
});

describe('buildSmartModelTurnDefinition without a budget', () => {
  it('builds an uncapped answer node (the omitted-budget defensive path)', async () => {
    const userId = await seedRichUser();
    // Candidate derivation scans the WHOLE exposed catalog (the cheapest text
    // model becomes the classifier; a row with unpriceable/zero rates sorts to
    // the front and fails the classifier-reserve computation, making the build
    // refuse). Clear the table and seed one controlled model so the global read
    // sees only this test's set — the file seeds several models across tests, so
    // its own leftovers would otherwise perturb the derivation.
    await db.delete(modelCatalog);
    await seedModel();
    const build = await buildSmartModelTurnDefinition(
      { db, telemetry: silentTelemetry, billing: createBillingStores() },
      { userId, now: new Date() }
    );
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    // No budget → no derived ceiling → the answer call keeps the model default,
    // so the node carries the schema's empty params default.
    expect(node?.type === 'smartModel' && node.params).toEqual({});
  });
});

/** A trial-eligible model dear enough that the character count binds the 1¢ cap. */
const DEAR_TRIAL_MODEL = 'trial-forward/dear';

/** Every trial send carries its 1¢ ceiling; these tests assert wiring, not money. */
const TRIAL_BUDGET: TurnBudget = {
  promptCharacterCount: 400,
  inputCharacterCount: 400,
  funding: { kind: 'free', spendableNanoUsd: 10_000_000n },
};

describe('buildTrialSmartModelTurnDefinition with classifyEffort', () => {
  it('declares both classifier dimensions when a trial candidate can reason', async () => {
    // Deterministic catalog (see the paid no-budget test): one plain and one
    // reasoning-capable trial-eligible model, so the effort-dimension gate has
    // a reasoning candidate to find.
    await db.delete(modelCatalog);
    await seedModel();
    await seedReasoningModel();
    const build = await buildTrialSmartModelTurnDefinition(
      { db, telemetry: silentTelemetry },
      {
        now: new Date(),
        budget: TRIAL_BUDGET,
        classifyEffort: true,
      }
    );
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable trial smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    expect(node?.type === 'smartModel' && node.classify).toEqual({ model: true, effort: true });
  });

  it('stamps the hard-off wire on a trial Smart turn when the send selected none', async () => {
    await db.delete(modelCatalog);
    await seedModel();
    await seedReasoningModel();
    const build = await buildTrialSmartModelTurnDefinition(
      { db, telemetry: silentTelemetry },
      {
        now: new Date(),
        budget: TRIAL_BUDGET,
        reasoningOff: true,
      }
    );
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable trial smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    expect(node.params['reasoning']).toEqual({ enabled: false });
    expect(node.classify).toBeUndefined();
  });
});

/**
 * The two threads that carry a pinned rung into candidate derivation, one per
 * arm. Each is asserted by a BOOLEAN FLIP over a catalog holding only a model
 * with no ladder: with the thread cut, the pin never reaches the derivation and
 * both arms build. Nothing else in either suite moves when the line is removed,
 * which is why the pin is stated here as a flip rather than as a shape.
 */
describe('a pinned rung reaches candidate derivation on both arms', () => {
  it('refuses a paid Smart send whose only candidate can offer no rung', async () => {
    const userId = await seedRichUser();
    const deps = { db, telemetry: silentTelemetry, billing: createBillingStores() };
    await db.delete(modelCatalog);
    await seedModel();
    const buildable = async (pinnedEffort?: 'high'): Promise<boolean> => {
      const build = await buildSmartModelTurnDefinition(deps, {
        userId,
        now: new Date(),
        ...(pinnedEffort === undefined ? {} : { pinnedEffort }),
      });
      return build._unsafeUnwrap().buildable;
    };
    expect(await buildable()).toBe(true);
    expect(await buildable('high')).toBe(false);
  });

  it('refuses a trial Smart send whose only candidate can offer no rung', async () => {
    await db.delete(modelCatalog);
    await seedModel();
    const buildable = async (pinnedEffort?: 'high'): Promise<boolean> => {
      const build = await buildTrialSmartModelTurnDefinition(
        { db, telemetry: silentTelemetry },
        {
          now: new Date(),
          budget: TRIAL_BUDGET,
          ...(pinnedEffort === undefined ? {} : { pinnedEffort }),
        }
      );
      return build._unsafeUnwrap().buildable;
    };
    expect(await buildable()).toBe(true);
    expect(await buildable('high')).toBe(false);
  });
});

/**
 * A tool-capable pair dear enough that the funding below binds the candidate
 * ceilings: on a context-bound catalog every ceiling is identical at every
 * funding level, so the reservation the search tool takes out of the turn would
 * be invisible here and this suite would assert nothing.
 */
const SEARCH_SLOT_MODEL = 'chat-route-search/slot';
const SEARCH_PINNED_MODEL = 'chat-route-search/pinned';

async function seedSearchPair(): Promise<void> {
  for (const [modelId, inputPerToken, outputPerToken] of [
    [SEARCH_SLOT_MODEL, '10000', '20000'],
    [SEARCH_PINNED_MODEL, '11000', '21000'],
  ] as const) {
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
          behaviors: ['streaming', 'tools'],
          limits: { contextLength: 10_000_000 },
          pricing: {
            kind: 'tokens',
            anchor: { base: { input: inputPerToken, output: outputPerToken }, tiers: [] },
          },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
  }
}

describe('the pinned siblings` web search reaches candidate derivation', () => {
  /**
   * The thread the caller must state: the slot's menu is graded and capped
   * against funding the siblings' search has already taken. Asserted as a flip
   * over the stamped per-candidate caps, because those caps override the node
   * parameter in both the estimator and execution — a menu blind to the tool
   * hands execution a ceiling the turn cannot fund, and no later answer fit can
   * bring it back.
   */
  async function slotCandidateCaps(webSearchEnabled: boolean): Promise<readonly number[]> {
    const userId = await seedRichUser();
    await db.delete(modelCatalog);
    await seedSearchPair();
    const build = await buildSmartModelTurnDefinition(
      { db, telemetry: silentTelemetry, billing: createBillingStores() },
      {
        userId,
        now: new Date(),
        pinnedModels: [SEARCH_PINNED_MODEL],
        webSearchEnabled,
        budget: {
          promptCharacterCount: 400,
          inputCharacterCount: 400,
          funding: { spendableNanoUsd: 5_000_000_000n, kind: 'purchased' },
        },
      }
    );
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable mixed smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    return node.candidates.map((candidate) => candidate.maxOutputTokens ?? 0);
  }

  it('caps the slot`s candidates lower on a searching turn than on a search-free one', async () => {
    const searching = await slotCandidateCaps(true);
    const searchFree = await slotCandidateCaps(false);
    expect(searching).toHaveLength(searchFree.length);
    expect(searching.length).toBeGreaterThan(0);
    for (const [index, ceiling] of searching.entries()) {
      expect(ceiling).toBeLessThan(searchFree[index] ?? 0);
    }
  });
});

describe('the trial Smart Model gate prices the budget`s own character count', () => {
  /**
   * The forwarding this arm's 1¢ ceiling depends on. The candidate gate must
   * price the SAME characters the definition is compiled against — which is the
   * route's `promptCharacterCount`, custom instructions included. When this file
   * recounted the prompt locally instead, it could see the system prompt, the
   * history and the input but NOT the instructions, and admitted sends the
   * definition then priced above the cap.
   *
   * The model is priced so the count binds on its own: input at 4,000 nano per
   * token means the 7,500 extra characters cost the whole 1¢ ceiling before a
   * single answer token is priced. Nothing here asserts an amount — the pin is
   * that the count REACHES the gate, which a local recount of
   * prompt-plus-history would not reproduce.
   */
  async function buildWith(promptCharacterCount: number): Promise<boolean> {
    await db.delete(modelCatalog);
    await db
      .insert(modelCatalog)
      .values({
        modelId: DEAR_TRIAL_MODEL,
        descriptor: {
          id: DEAR_TRIAL_MODEL,
          provider: 'p',
          version: '3',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: ['streaming'],
          limits: { contextLength: 128_000 },
          pricing: {
            kind: 'tokens',
            anchor: { base: { input: '4000', output: '1000' }, tiers: [] },
          },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const build = await buildTrialSmartModelTurnDefinition(
      { db, telemetry: silentTelemetry },
      {
        now: new Date(),
        budget: { ...TRIAL_BUDGET, promptCharacterCount },
      }
    );
    return build._unsafeUnwrap().buildable;
  }

  it('builds on a count the cap covers and refuses on one it does not', async () => {
    expect(await buildWith(400)).toBe(true);
    expect(await buildWith(400 + 7500)).toBe(false);
  });
});
