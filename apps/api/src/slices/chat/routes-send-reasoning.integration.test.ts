// POST /chat's reasoning-effort contract: what it refuses, the wires it produces, and
// its place in the dedup body hash.
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { modelCatalog } from '@hushbox/db';
import { planReasoning, reasoningPlanModelFrom } from '@hushbox/shared/affordability';
import { okAsync } from '../../lib/result/index.js';
import { hashRequestBody } from './domain/index.js';
import {
  MODEL,
  MODEL_B,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  post,
  seedConversation,
  seedGateModel,
  seedImageGateModel,
  seedModel,
  seedModelId,
  seedPurchasedWallet,
  seedUnrepresentableGateModel,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';
import type { CanonicalReasoningEffort, WorkflowDefinition } from '@hushbox/shared';

/** The context every reasoning model here is seeded with — its only sizing basis. */
const REASONING_LIMITS = { contextLength: 1_000_000 };

/**
 * The reasoning budget these seeded models' ladders put at a rung, read through
 * the published plan producer. The budget table is money-layer machinery held
 * behind the wall, and asking the producer pins the CLAMPED figure the route
 * sizes its own cap against rather than the raw tier.
 */
function seededBudgetAt(effort: CanonicalReasoningEffort): number {
  const planned = planReasoning(
    reasoningPlanModelFrom({ reasoning: {}, limits: REASONING_LIMITS }),
    effort,
    1
  );
  if (!planned.feasible) throw new Error(`the seeded reasoning model offers no '${effort}' rung`);
  return planned.plan.reasoningBudgetTokens;
}

describe('chat route: POST /chat', () => {
  it('refuses an explicit reasoning effort on a non-reasoning model with 400 (no silent downgrade)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        reasoningEffort: 'medium',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('rejects a reasoningEffort outside the selection enum with 400', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        reasoningEffort: 'maximum',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it("refuses 'off' on a mandatory-reasoning model with 400 (never silently ignored)", async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { mandatory: true, supportedEfforts: null },
      limits: REASONING_LIMITS,
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        reasoningEffort: 'off',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('threads the reasoning wire and an explicit B+H completion cap onto the answer node (201)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: REASONING_LIMITS,
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        reasoningEffort: 'low',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('expected a captured answer node');
    expect(answer.params['reasoning']).toEqual({ effort: 'low' });
    // An explicit completion cap of reasoning budget + answer headroom always
    // rides a reasoning call — never the model default.
    const cap = answer.params['maxOutputTokens'];
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeGreaterThan(seededBudgetAt('low'));
  });

  it('wires a budget-native reasoning model with max_tokens instead of an effort word (201)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    // Absent supportedEfforts = budget-native (no effort vocabulary).
    await seedGateModel(model, {
      reasoning: {},
      limits: REASONING_LIMITS,
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        reasoningEffort: 'low',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('expected a captured answer node');
    expect(answer.params['reasoning']).toEqual({
      max_tokens: seededBudgetAt('low'),
    });
  });

  it('threads per-sibling reasoning wires on a multi-model send (201)', async () => {
    const modelA = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const modelB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(modelA, {
      reasoning: { supportedEfforts: null },
      limits: REASONING_LIMITS,
    });
    await seedGateModel(modelB, {
      reasoning: {},
      limits: REASONING_LIMITS,
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: modelA },
          { kind: 'model', id: modelB },
        ],
        reasoningEffort: 'low',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const siblings = captured[0]?.nodes.filter((node) => node.type === 'modelCall') ?? [];
    expect(siblings).toHaveLength(2);
    expect(siblings.map((node) => node.params['reasoning'])).toEqual([
      { effort: 'low' },
      { max_tokens: seededBudgetAt('low') },
    ]);
  });

  it('refuses a reasoning turn on a model with no context-length limit with 400 (no sizing basis)', async () => {
    // A reasoning call must carry an explicit affordably-derived completion
    // cap; a model with no context length has no sizing basis, so the
    // build fails closed rather than sending an uncapped reasoning call.
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedUnrepresentableGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: {},
    });
    try {
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: model }],
          reasoningEffort: 'low',
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'VALIDATION' });
    } finally {
      // Drop the fixture here rather than at `afterAll`: it is a priceable text
      // model at this file's cheapest rate with no context length, so leaving it
      // in the shared catalog lets it win the auto-effort classifier's
      // cheapest-engine tiebreak in a later test and fail that turn as
      // unaffordable.
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
    }
  });

  it('pins an EXPLICIT reasoning level onto a Smart Model send (201, effort axis closed)', async () => {
    // The pin grades the candidate menu, so the slot needs a pool row that can
    // resolve it: the two plain fixtures below offer no ladder at all, and a
    // menu with nothing at the pinned rung refuses the send outright.
    await seedGateModel(`chat-route/${crypto.randomUUID().slice(0, 8)}`, {
      reasoning: { supportedEfforts: null },
      limits: REASONING_LIMITS,
    });
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        reasoningEffort: 'high',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const slot = captured[0]?.nodes.find((node) => node.type === 'smartModel');
    if (slot?.type !== 'smartModel') throw new Error('expected a captured smartModel slot');
    expect(slot.pinnedEffort).toBe('high');
    // The pin IS the answer to the effort question, so the classifier is never
    // bought to ask it again — it routes the model axis alone.
    expect(slot.classify?.effort ?? false).toBe(false);
  });

  it('refuses a slot-only send pinned to a level no model in the pool offers (402)', async () => {
    // A ladder-free pool is this case's whole premise, and the catalog is one
    // table per worker slot: a laddered row an earlier case left behind would
    // resolve the pin and the send would answer 201. The wipe is what makes the
    // premise hold, and it is safe because every case here seeds its own rows.
    await db.delete(modelCatalog);
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        reasoningEffort: 'high',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'INSUFFICIENT_ADMISSION' });
    expect(captured).toEqual([]);
  });

  it('refuses an explicit level on a Smart Model send carrying a model list (400)', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: MODEL },
          { kind: 'model', id: MODEL_B },
        ],
        reasoningEffort: 'high',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses an explicit reasoning effort on a media turn with 400', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        reasoningEffort: 'low',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it("passes 'off' through a media turn untouched (201 — the no-op direction of the refusal seam)", async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        reasoningEffort: 'off',
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
  });

  it("passes 'off' through a Smart Model send untouched (201 — the no-op direction of the refusal seam)", async () => {
    // Min grades the slot's candidates as a pin at the off rung, so the pool
    // needs a candidate that can switch reasoning off: over ladderless models
    // alone the shared producer refuses the selection, and the route with it.
    const canSwitchOff = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(canSwitchOff, {
      reasoning: { supportedEfforts: null },
      limits: REASONING_LIMITS,
    });
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        reasoningEffort: 'off',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
  });

  it('scopes reasoningEffort into the dedup body hash (absent hashes the pre-feature shape)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: REASONING_LIMITS,
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const hashes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        hashes.push(body.bodyHash);
        return okAsync(STARTED);
      },
    });
    const userMessage = { content: 'same turn' };
    const absent = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, turnSources: [{ kind: 'model', id: model }], userMessage }
    );
    const engaged = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        userMessage,
        reasoningEffort: 'low',
      }
    );
    expect(absent.status).toBe(201);
    expect(engaged.status).toBe(201);
    // The effort is client intent that changes the answer, so it scopes the
    // dedup (same key + different effort drives the referee's body-mismatch
    // 409); an absent effort hashes exactly the pre-feature shape, so an old
    // client's retry never 409s against its own turn.
    expect(hashes[1]).not.toBe(hashes[0]);
    expect(hashes[0]).toBe(
      hashRequestBody({
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        userMessage,
        history: [],
      })
    );
    expect(hashes[1]).toBe(
      hashRequestBody({
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        reasoningEffort: 'low',
        userMessage,
        history: [],
      })
    );
  });

  it('builds pinned + auto as a single-candidate effort-dimension smartModel node (201)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: REASONING_LIMITS,
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        reasoningEffort: 'auto',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const node = captured[0]?.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a captured smartModel node');
    // The user's pick is the ONLY candidate (no routing — short-circuit); only
    // the effort dimension classifies.
    expect(node.candidates.map((candidate) => candidate.id)).toEqual([model]);
    expect(node.classify).toEqual({ model: false, effort: true });
    // The completion cap reserves the highest level's budget on top of the
    // answer headroom, so any classified level carves out of an existing hold.
    const cap = node.params['maxOutputTokens'];
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeGreaterThan(seededBudgetAt('high'));
  });
});
