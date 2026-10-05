import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs, modelCatalog, users, wallets } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ERROR_CODES } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { createBillingStores } from '../../../billing/index.js';
import { CATALOG_REFRESH_JOB_TYPE, createModelPricingResolver } from '../../../models/index.js';
import { CHAT_TURN_HOOKS } from '../constants.js';
import {
  buildAutoEffortTurnDefinition,
  buildSmartModelTurnDefinition,
  buildTrialSmartModelTurnDefinition,
} from '../smart-model/turn.js';
import { buildMultiModelTurnDefinition } from './definition.js';
import { buildMediaTurnDefinition } from './media-turn.js';
import { okAsync } from '../../../../lib/result/index.js';
import {
  MODEL,
  STARTED,
  fakeRealtime,
  postTrial,
  trialHeaders,
  withPinnedTrialCatalog,
} from '../../../../test-support/chat-routes.integration.setup.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { TurnBudget } from './definition.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for catalog-generation integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([5, 5, 5]);
const TEXT_MODEL = `chat-generation/${crypto.randomUUID().slice(0, 8)}`;
const REASONING_MODEL = `chat-generation/${crypto.randomUUID().slice(0, 8)}`;
const IMAGE_MODEL = `chat-generation/${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

const deps = { db, telemetry: silentTelemetry };

const PAID_BUDGET: TurnBudget = {
  promptCharacterCount: 'hello world'.length,
  inputCharacterCount: 'hello world'.length,
  funding: { kind: 'purchased', spendableNanoUsd: 1_000_000_000_000n },
};

const TRIAL_BUDGET: TurnBudget = {
  promptCharacterCount: 'hello world'.length,
  inputCharacterCount: 'hello world'.length,
  funding: { kind: 'free', spendableNanoUsd: 10_000_000n },
};

afterAll(async () => {
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  await db
    .delete(modelCatalog)
    .where(inArray(modelCatalog.modelId, [TEXT_MODEL, REASONING_MODEL, IMAGE_MODEL]));
  await db.$client.end();
});

/**
 * One cheap text model, one reasoning model and one image model are the whole
 * catalog: the Smart Model and `auto` builders pick their classifier engine and
 * candidates from every exposed row, so rows other files leave behind would
 * otherwise decide whether these builds succeed.
 */
async function seedCatalog(): Promise<void> {
  await db.delete(modelCatalog);
  const text = (modelId: string, reasoning: object): object => ({
    id: modelId,
    provider: 'p',
    version: '4',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 128_000 },
    pricing: {
      kind: 'tokens',
      anchorContextTokens: 1_000_000,
      anchor: { base: { input: '2', output: '3' }, tiers: [] },
    },
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: TEST_DAY_START,
    ...reasoning,
  });
  await db.insert(modelCatalog).values([
    { modelId: TEXT_MODEL, descriptor: text(TEXT_MODEL, {}) },
    {
      modelId: REASONING_MODEL,
      descriptor: text(REASONING_MODEL, { reasoning: { supportedEfforts: null } }),
    },
    {
      modelId: IMAGE_MODEL,
      descriptor: {
        id: IMAGE_MODEL,
        provider: 'p',
        version: '4',
        inputs: ['text'],
        outputs: ['image'],
        parameters: {},
        behaviors: [],
        limits: {},
        pricing: { kind: 'perImage', anchor: '46000000', dearest: '46000000' },
        zdrReachable: true,
        zdrPin: ['test-provider'],
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: TEST_DAY_START,
      },
    },
  ]);
}

async function seedRichUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@catalog-generation.test`,
        username: `cg${suffix}`,
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
  await db
    .insert(wallets)
    .values({ userId: id, type: 'purchased', balanceNanoUsd: 1_000_000_000_000n });
  return id;
}

/** The generation a catalog read taken now names. */
async function currentGeneration(): Promise<string> {
  const resolver = await createModelPricingResolver(deps);
  return resolver._unsafeUnwrap().generation;
}

describe('every turn builder stamps the catalog generation it priced with', () => {
  it('stamps a multi-model turn', async () => {
    await seedCatalog();
    const built = await buildMultiModelTurnDefinition(deps, [TEXT_MODEL, REASONING_MODEL], {
      now: new Date(TEST_DAY_START),
    });
    const outcome = built._unsafeUnwrap();
    if (outcome.kind !== 'built') throw new Error('expected a built multi-model turn');
    expect(outcome.definition.catalogGeneration).toBe(await currentGeneration());
  });

  it('stamps a paid Smart Model turn', async () => {
    await seedCatalog();
    const userId = await seedRichUser();
    const built = await buildSmartModelTurnDefinition(
      { ...deps, billing: createBillingStores() },
      { userId, now: new Date(TEST_DAY_START), budget: PAID_BUDGET }
    );
    const build = built._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable Smart Model turn');
    expect(build.definition.catalogGeneration).toBe(await currentGeneration());
  });

  it('stamps a trial Smart Model turn', async () => {
    await seedCatalog();
    const built = await buildTrialSmartModelTurnDefinition(deps, {
      now: new Date(TEST_DAY_START),
      budget: TRIAL_BUDGET,
    });
    const build = built._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable trial Smart Model turn');
    expect(build.definition.catalogGeneration).toBe(await currentGeneration());
  });

  it('stamps a pinned-model auto-effort turn', async () => {
    await seedCatalog();
    const built = await buildAutoEffortTurnDefinition(deps, REASONING_MODEL, {
      budget: PAID_BUDGET,
      hooks: CHAT_TURN_HOOKS,
      now: new Date(TEST_DAY_START),
    });
    const build = built._unsafeUnwrap();
    if (build.kind !== 'built') throw new Error('expected a classified auto-effort turn');
    expect(build.definition.catalogGeneration).toBe(await currentGeneration());
  });

  it('stamps a media turn', async () => {
    await seedCatalog();
    const built = await buildMediaTurnDefinition(deps, [IMAGE_MODEL], 'image', {
      params: {},
      budget: PAID_BUDGET,
    });
    expect(built._unsafeUnwrap().catalogGeneration).toBe(await currentGeneration());
  });
});

describe('the trial route stamps the catalog generation it priced with', () => {
  /** Sends one trial turn and returns the definition the route handed the room. */
  async function trialDefinition(
    fixture: Record<string, unknown>,
    body: { readonly reasoningEffort?: 'auto' }
  ): Promise<WorkflowDefinition> {
    const fixtureId = `chat-generation/${crypto.randomUUID().slice(0, 8)}`;
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, start) => {
        captured.push(start.definition);
        return okAsync(STARTED);
      },
    });
    const res = await withPinnedTrialCatalog(fixtureId, fixture, () =>
      postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: fixtureId }],
        prompt: 'hi',
        ...body,
      })
    );
    expect(res.status).toBe(201);
    const [definition] = captured;
    if (definition === undefined) throw new Error('expected the route to start a run');
    return definition;
  }

  it('stamps a trial single-model turn', async () => {
    const definition = await trialDefinition({ limits: { contextLength: 1_000_000 } }, {});
    expect(definition.catalogGeneration).toBe(await currentGeneration());
  });

  it('stamps a trial auto-effort turn', async () => {
    const definition = await trialDefinition(
      {
        reasoning: { supportedEfforts: null },
        limits: { contextLength: 1_000_000 },
        pricing: { anchor: { base: { input: '800', output: '1200' } } },
      },
      { reasoningEffort: 'auto' }
    );
    // The classified arm, not the regular compile it falls back to.
    expect(definition.nodes.some((node) => node.type === 'smartModel')).toBe(true);
    expect(definition.catalogGeneration).toBe(await currentGeneration());
  });

  it('refuses a trial send whose catalog read fails, starting no run', async () => {
    const unreadable = `chat-generation/${crypto.randomUUID().slice(0, 8)}`;
    // A catalog whose only row was written under an older descriptor version
    // exposes nothing current, so the read refuses.
    await db.delete(modelCatalog);
    await db.insert(modelCatalog).values({ modelId: unreadable, descriptor: { version: '2' } });
    try {
      const starts: unknown[] = [];
      const realtime = fakeRealtime(STARTED, {
        startRun: (_conversationId, start) => {
          starts.push(start);
          return okAsync(STARTED);
        },
      });
      const res = await postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: MODEL }],
        prompt: 'hi',
      });
      expect({ status: res.status, body: await res.json(), starts }).toEqual({
        status: 503,
        body: { code: ERROR_CODES.UNAVAILABLE },
        starts: [],
      });
    } finally {
      await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [unreadable]));
      // The refused read on the request's handle enqueued the catalog refresh.
      await db.delete(jobs).where(inArray(jobs.type, [CATALOG_REFRESH_JOB_TYPE]));
    }
  });
});
