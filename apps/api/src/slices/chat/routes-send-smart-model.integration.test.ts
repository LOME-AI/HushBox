// POST /chat's Smart Model slot and the auto-effort classifier stage: candidate
// derivation, the classified definition it builds, and their refusals.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { allowanceSpending, modelCatalog, wallets } from '@hushbox/db';
import {
  REASONING_OFF_WIRE,
  SMART_MODEL_ID,
  isTurnClassifierNode,
  utcDayKey,
} from '@hushbox/shared';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { DAILY_ALLOWANCE_NANO_USD, createBillingStores } from '../billing/index.js';
import { createConversationsStores } from '../conversations/index.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import { createChatManifest } from './index.js';
import { CHAT_DECISION_NODE_ID, hashRequestBody } from './domain/index.js';
import {
  MODEL,
  MODEL_B,
  MODEL_C,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  post,
  seedConversation,
  seedGateModel,
  seedModel,
  seedModelId,
  seedPurchasedWallet,
  seedToolCapableModelId,
  seedUnrepresentableGateModel,
  seedUser,
  testEnv,
  WEB_SEARCH_MODEL_PREFIX,
} from '../../test-support/chat-routes.integration.setup.js';
import type { Node, WorkflowDefinition } from '@hushbox/shared';
import type { AppEnv } from '../../lib/context/index.js';

describe('chat route: POST /chat', () => {
  it('routes Smart Model + auto through the both-dimensions classifier stage (201, one call)', async () => {
    const reasoner = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(reasoner, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    await seedModelId(MODEL);
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
        reasoningEffort: 'auto',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const node = captured[0]?.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a captured smartModel node');
    // One classifier generation classifies BOTH dimensions (model + effort).
    expect(node.classify).toEqual({ model: true, effort: true });
  });

  it('stamps the explicit hard-off wire on a Smart Model + none send (201)', async () => {
    // The founder's hard-off ruling: 'off' wires { enabled: false }
    // explicitly — never parameter omission — so a default_enabled candidate
    // truly stops reasoning on the composite path too.
    const reasoner = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(reasoner, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    await seedModelId(MODEL);
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
        reasoningEffort: 'off',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const node = captured[0]?.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a captured smartModel node');
    expect(node.params['reasoning']).toEqual({ enabled: false });
    // No effort dimension: 'off' is the user's choice, nothing to classify.
    expect(node.classify).toBeUndefined();
  });

  it('refuses pinned + auto with the typed classifier code when no engine can be priced (503)', async () => {
    // BILLING §Effort 5/8d: auto needs a classifier once the model offers two
    // or more choices; with no priceable engine the send fails with its own
    // code (explicit levels stay usable) — never a silent static pick.
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const headers = { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() };
    try {
      // Exclusivity is what makes the premise hold: the fixture is the only
      // exposed row and carries no token price, so NOTHING exposed can price a
      // classifier call. Seeding it beside a priceable catalog does not reach
      // the refusal — a model without a token price does not win the engine pick, so
      // the priceable row would answer and the send would succeed. It is
      // dropped immediately after, or every later auto turn inherits it.
      const res = await withFixtureAsEngineCatalog(
        () =>
          seedUnrepresentableGateModel(model, {
            reasoning: { supportedEfforts: null },
            limits: { contextLength: 1_000_000 },
            pricing: { kind: 'perImage', anchor: '2', dearest: '2' },
          }),
        () =>
          post(fakeRealtime(STARTED), headers, {
            conversationId,
            turnSources: [{ kind: 'model', id: model }],
            reasoningEffort: 'auto',
            userMessage: { content: 'hello' },
          })
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: 'CLASSIFIER_UNAVAILABLE' });
    } finally {
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
    }
  });

  /**
   * A fixture priced so the CLASSIFIER RESERVE is the term that decides a PAID
   * send: the smallest viable answer sits inside the payer's funds while that
   * answer plus the reserve does not. The reserve's output leg is the shared
   * `CLASSIFIER_OUTPUT_TOKEN_CAP`, which is larger than the minimum answer, so a
   * high OUTPUT rate is what separates the two sides. Which side each lands on is
   * pinned by the companion pair below, never asserted by this comment.
   */
  const PAID_CLASSIFIER_RESERVE_FIXTURE = {
    reasoning: { supportedEfforts: null },
    limits: { contextLength: 1_000_000 },
    pricing: { anchor: { base: { input: '1', output: '300000' } } },
  } as const;

  /**
   * Wipes the catalog so `seedFixture`'s row is the ONLY one, and therefore also
   * the cheapest priceable text model — which is to say the classifier engine,
   * whose rates the reserve is priced at. With any cheaper row present the engine is that row, the
   * reserve is a few thousand nano, and no rate on the fixture can make the
   * reserve decide the send: a classifier-cost refusal would be unobservable
   * however the fixture is priced. Every test seeds the models it needs, which is
   * what makes the wipe safe here as it is for the trial wrapper below.
   */
  async function withFixtureAsEngineCatalog<T>(
    seedFixture: () => Promise<void>,
    send: () => Promise<T>
  ): Promise<T> {
    await db.delete(modelCatalog);
    await seedFixture();
    return send();
  }

  it('runs the paid classifier-reserve fixture without auto (201 — the answer alone fits)', async () => {
    // The premise the refusal below rests on. Without this 201 the 402 could be
    // the answer itself overrunning the payer's funds, and the pair would pin
    // nothing about the classifier.
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const headers = { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() };
    const res = await withFixtureAsEngineCatalog(
      () => seedGateModel(model, PAID_CLASSIFIER_RESERVE_FIXTURE),
      () =>
        post(fakeRealtime(STARTED), headers, {
          conversationId,
          turnSources: [{ kind: 'model', id: model }],
          userMessage: { content: 'hello' },
        })
    );
    expect(res.status).toBe(201);
  });

  it('refuses a paid pinned + auto send the payer cannot fund the classified turn for (402)', async () => {
    // The same model, wallet and prompt as the 201 above, differing only in
    // `auto` — so the answer fits the payer's funds and the answer plus the
    // classifier's reserve does not.
    //
    // Falling back to the regular turn here is what BILLING §Reasoning Effort 5
    // forbids: that turn resolves `auto` reasoning-free, which is CHEAPER than
    // the classified turn the payer could not afford, so nothing downstream
    // refuses it and the payer is billed for a turn they did not ask for. The
    // captured-definition assertion is the half that pins it — a degraded send
    // answers 201 and starts a run.
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
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
    const headers = { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() };
    const res = await withFixtureAsEngineCatalog(
      () => seedGateModel(model, PAID_CLASSIFIER_RESERVE_FIXTURE),
      () =>
        post(realtime, headers, {
          conversationId,
          turnSources: [{ kind: 'model', id: model }],
          reasoningEffort: 'auto',
          userMessage: { content: 'hello' },
        })
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'INSUFFICIENT_ADMISSION' });
    expect(captured).toEqual([]);
  });

  it('accepts a level only ONE selected model offers on a multi-model send (201)', async () => {
    // The union choice set: the High-only sibling resolves to hard off rather
    // than 400ing the whole build (the old every-model unanimity rule).
    const openModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const highOnly = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(openModel, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    await seedGateModel(highOnly, {
      reasoning: { supportedEfforts: ['high'] },
      limits: { contextLength: 1_000_000 },
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
          { kind: 'model', id: openModel },
          { kind: 'model', id: highOnly },
        ],
        reasoningEffort: 'low',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const siblings = captured[0]?.nodes.filter((node) => node.type === 'modelCall') ?? [];
    expect(siblings.map((node) => node.params['reasoning'])).toEqual([
      { effort: 'low' },
      { enabled: false },
    ]);
  });

  it('keeps pinned + auto on the regular turn for a non-reasoning model (no call, no charge, no reserve)', async () => {
    await seedModel();
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
        turnSources: [{ kind: 'model', id: MODEL }],
        reasoningEffort: 'auto',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    // The fallback path: a plain modelCall turn — no classifier stage at all.
    const node = captured[0]?.nodes.at(-1);
    if (node?.type !== 'modelCall') throw new Error('expected a captured modelCall node');
    expect(node.params['reasoning']).toBeUndefined();
  });

  it('keeps web search on the answer node of a classified auto turn (no composite)', async () => {
    // The pinned+auto composite carries no tool loop: if this turn ever became
    // a smartModel node, web search would silently vanish from the run.
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      behaviors: ['streaming', 'tools'],
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
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
        webSearchEnabled: true,
        reasoningEffort: 'auto',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const nodes = captured[0]?.nodes ?? [];
    expect(nodes.some((node) => node.type === 'smartModel')).toBe(false);
    const calls = nodes.filter((node) => node.type === 'modelCall');
    // ONE classifier for the turn. A turn that never classified would carry the
    // tool on its sole call too, so the tool claim below only says the search
    // survived classification while this holds.
    expect(calls.filter((node) => isTurnClassifierNode(node, nodes))).toHaveLength(1);
    const answer = calls.find((node) => !isTurnClassifierNode(node, nodes));
    if (answer?.type !== 'modelCall') throw new Error('expected a captured modelCall node');
    expect(answer.tools).toEqual(['webSearch']);
    // No reasoning wire is BUILT into the answer: the classified level arrives
    // on the decision at runtime and is carved into the cap already reserved
    // for it, which is what keeps the priced definition the executed one.
    expect(answer.params['reasoning']).toBeUndefined();
  });

  it('classifies multi-model + auto through a turn-level call, keeping N modelCall siblings', async () => {
    // The fan-out stays N siblings — a smartModel composite would drop all but
    // one generation — and gains ONE turn-level classifier whose answer every
    // sibling reads.
    const modelA = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const modelB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(modelA, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    await seedGateModel(modelB, {
      reasoning: {},
      limits: { contextLength: 1_000_000 },
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
        reasoningEffort: 'auto',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const nodes = captured[0]?.nodes ?? [];
    expect(nodes.some((node) => node.type === 'smartModel')).toBe(false);
    const calls = nodes.filter((node) => node.type === 'modelCall');
    const classifiers = calls.filter((node) => isTurnClassifierNode(node, nodes));
    const siblings = calls.filter((node) => !isTurnClassifierNode(node, nodes));
    // ONE classifier for the whole turn — per-sibling classification would cost
    // N× the reserve — and the two answer siblings it decides for.
    expect(classifiers).toHaveLength(1);
    expect(siblings).toHaveLength(2);
    expect(nodes.filter((node) => node.type === 'fanIn')).toHaveLength(1);
    // No reasoning wire is BUILT into a sibling: the level arrives on the
    // decision at runtime and is carved into the cap already reserved for it,
    // which is what keeps the priced definition the executed one.
    expect(siblings.map((node) => node.params['reasoning'])).toEqual([undefined, undefined]);
  });

  it('builds the classified smartModel definition for a smart-model send (201)', async () => {
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
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const node = definition.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    // Candidates are server-derived from the exposed catalog + wallet balance
    // (the file seeds catalog rows across tests, so assert membership and
    // ordering invariants, never an exact list). Asserted before the node shape
    // below so a fixture that stopped reaching the pool names the missing model
    // instead of surfacing as an opaque node-type mismatch.
    const candidateIds = node.candidates.map((candidate) => candidate.id);
    expect(candidateIds).toEqual(expect.arrayContaining([MODEL, MODEL_B]));
    // classify → decide → slot: the classifier the reserve pays for is a node.
    expect(definition.nodes.map((one) => one.type)).toEqual(['modelCall', 'fanIn', 'smartModel']);
    // The engine is chosen on a prompt-independent combined rate while the pool is
    // ordered on turn cost and has its high-cost outliers removed, so the engine is
    // neither the first candidate nor necessarily a candidate at all — the cheapest
    // model per token can be an enormous-capacity outlier. Nothing depends on the
    // coincidence: the classifier's own fallback resolves within `candidates`.
    expect(node.classifierModelId).not.toBe(SMART_MODEL_ID);
    expect(candidateIds).not.toContain(SMART_MODEL_ID);
  });

  it('hashes only client intent for a smart-model send — candidates never perturb the body hash', async () => {
    await seedModelId(MODEL);
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
    const userMessage = { content: 'hello' };
    const body = { conversationId, turnSources: [{ kind: 'smart' }], userMessage };
    await post(realtime, { cookie: await cookie(userId), 'Idempotency-Key': 'key-a' }, body);
    // Second identical send after the catalog gained a model (a new candidate).
    await seedModelId(MODEL_C);
    await post(realtime, { cookie: await cookie(userId), 'Idempotency-Key': 'key-b' }, body);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
    // The hash covers the body as sent — one smart turn source — and never the
    // candidate set the classifier resolves it to.
    expect(hashes[0]).toBe(
      hashRequestBody({
        conversationId,
        turnSources: [{ kind: 'smart' }],
        userMessage,
        history: [],
      })
    );
  });

  // The mixed turn: the Smart slot answering BESIDE the models the same send
  // pinned by name, from either end of the selection.
  for (const [label, order] of [
    ['slot first', ['smart', 'pinned'] as const],
    ['slot last', ['pinned', 'smart'] as const],
  ] as const) {
    it(`builds the Smart slot beside its pinned sibling, ${label} (201)`, async () => {
      await seedModelId(MODEL);
      await seedModelId(MODEL_B);
      await seedModelId(MODEL_C);
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
          turnSources: order.map((entry) =>
            entry === 'smart' ? { kind: 'smart' } : { kind: 'model', id: MODEL }
          ),
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(201);
      const nodes = captured[0]?.nodes ?? [];
      const slot = nodes.find((node) => node.type === 'smartModel');
      if (slot?.type !== 'smartModel') throw new Error('expected a smartModel slot node');
      const siblings = nodes.filter(
        (node) => node.type === 'modelCall' && !isTurnClassifierNode(node, nodes)
      );
      // The sibling the user pinned is a node of its own — it is NOT swallowed
      // by the slot, which is what a slot-only build silently did.
      expect(siblings.map((node) => (node.type === 'modelCall' ? node.model : ''))).toEqual([
        MODEL,
      ]);
      // Candidate/pinned disjointness: the slot can never resolve to the model
      // the same turn already pinned, so no answer is priced or billed twice.
      expect(slot.candidates.map((candidate) => candidate.id)).not.toContain(MODEL);
      expect(slot.candidates.length).toBeGreaterThan(0);
    });
  }

  /** The answer nodes of a captured mixed build, classifier excluded. */
  function answerNodes(definition: WorkflowDefinition | undefined): readonly Node[] {
    const nodes = definition?.nodes ?? [];
    return nodes.filter(
      (node) =>
        node.type === 'smartModel' ||
        (node.type === 'modelCall' && !isTurnClassifierNode(node, nodes))
    );
  }

  it('carries the turn-level hard-off wire onto the pinned sibling as well as the slot', async () => {
    // Effort is one turn-level answer. A sibling that ignored it would reason
    // while the slot beside it did not, on a send that asked for neither.
    const reasoner = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(reasoner, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
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
        turnSources: [{ kind: 'smart' }, { kind: 'model', id: reasoner }],
        reasoningEffort: 'off',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const sibling = answerNodes(captured[0]).find((node) => node.type === 'modelCall');
    expect(sibling?.type === 'modelCall' && sibling.params['reasoning']).toEqual(
      REASONING_OFF_WIRE
    );
  });

  it('feeds the pinned sibling the decision when the mixed turn classifies effort', async () => {
    // With the effort axis open the turn's ONE classifier answers for the slot
    // and the sibling alike, which is what makes a single reserve cover both.
    const reasonerA = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const reasonerB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    for (const id of [reasonerA, reasonerB]) {
      await seedGateModel(id, {
        reasoning: { supportedEfforts: null },
        limits: { contextLength: 1_000_000 },
      });
    }
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
        turnSources: [{ kind: 'smart' }, { kind: 'model', id: reasonerA }],
        reasoningEffort: 'auto',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const sibling = answerNodes(captured[0]).find((node) => node.type === 'modelCall');
    expect(sibling?.type === 'modelCall' && sibling.in.node).toBe(CHAT_DECISION_NODE_ID);
  });

  it('grades the candidate menu at a pinned level and pins the sibling to it', async () => {
    const pinnedReasoner = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const candidateReasoner = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    for (const id of [pinnedReasoner, candidateReasoner]) {
      await seedGateModel(id, {
        reasoning: { supportedEfforts: null },
        limits: { contextLength: 1_000_000 },
      });
    }
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
        turnSources: [{ kind: 'model', id: pinnedReasoner }, { kind: 'smart' }],
        reasoningEffort: 'high',
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const nodes = answerNodes(captured[0]);
    const sibling = nodes.find((node) => node.type === 'modelCall');
    expect(sibling?.type === 'modelCall' && sibling.params['reasoning']).toBeDefined();
    const slot = nodes.find((node) => node.type === 'smartModel');
    expect(slot?.type === 'smartModel' && slot.pinnedEffort).toBe('high');
  });

  it('carries web search onto the pinned sibling of a mixed turn', async () => {
    const searchModel = `${WEB_SEARCH_MODEL_PREFIX}/${crypto.randomUUID().slice(0, 8)}`;
    await seedToolCapableModelId(searchModel);
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
    const send = async (modelId: string): Promise<Response> =>
      post(
        realtime,
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'smart' }, { kind: 'model', id: modelId }],
          webSearchEnabled: true,
          userMessage: { content: 'hello' },
        }
      );
    const res = await send(searchModel);
    expect(res.status).toBe(201);
    const sibling = answerNodes(captured[0]).find((node) => node.type === 'modelCall');
    expect(sibling?.type === 'modelCall' && sibling.tools).toEqual(['webSearch']);
    // The same gate a pure fan-out applies: a sibling that cannot run the tool
    // loop refuses the whole build rather than answering searchlessly.
    const refused = await send(MODEL);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'VALIDATION' });
  });

  /** Sends one text turn as `userId`, varying only the source list. */
  function sourceListSender(
    userId: string,
    conversationId: string
  ): (turnSources: unknown) => Promise<Response> {
    return async (turnSources) =>
      post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources,
          userMessage: { content: 'hello' },
        }
      );
  }

  // The two arrangements that stay out by design now that the mixed shape runs.
  // Each is paired with the body it differs from by exactly the offending
  // property, which still returns 201 — so a refusal cannot be credited to the
  // fixture, the route class, or the wallet.
  it('refuses a second Smart slot, while the same send carrying one runs (400)', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const send = sourceListSender(userId, conversationId);
    const refused = await send([
      { kind: 'smart' },
      { kind: 'model', id: MODEL },
      { kind: 'smart' },
    ]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'VALIDATION' });
    const control = await send([{ kind: 'smart' }, { kind: 'model', id: MODEL }]);
    expect(control.status).toBe(201);
  });

  it('refuses a per-sibling effort, while the same send without it runs (400)', async () => {
    // Effort is turn-level: one option per registered dimension. A source
    // carrying its own level is refused by the source object being strict.
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const send = sourceListSender(userId, conversationId);
    const refused = await send([
      { kind: 'smart' },
      { kind: 'model', id: MODEL, reasoningEffort: 'high' },
    ]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'VALIDATION' });
    const control = await send([{ kind: 'smart' }, { kind: 'model', id: MODEL }]);
    expect(control.status).toBe(201);
  });

  it('emits one answer node per selected source, in the selected order', async () => {
    // Tiles are pre-allocated one per source client-side, so a build emitting
    // fewer answer nodes than sources leaves a tile no stream ever reaches.
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    await seedModelId(MODEL_C);
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
          { kind: 'model', id: MODEL },
          { kind: 'smart' },
          { kind: 'model', id: MODEL_B },
        ],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const nodes = captured[0]?.nodes ?? [];
    const answers = nodes.filter(
      (node) =>
        node.type === 'smartModel' ||
        (node.type === 'modelCall' && !isTurnClassifierNode(node, nodes))
    );
    expect(answers).toHaveLength(3);
    // Declaration order is the selected order — it is the fork tip at
    // settlement and the order the streams are opened in.
    expect(
      answers.map((node) =>
        node.type === 'modelCall' ? node.model : /* the slot names no model */ 'smart'
      )
    ).toEqual([MODEL, 'smart', MODEL_B]);
  });

  it('refuses a smart-model send when no candidate is affordable with 402', async () => {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    // Both wallets, as at registration, with a zero purchased balance: the turn
    // routes to the free wallet, and Smart Model derives its candidates from the
    // payer's EFFECTIVE funding — the remaining daily allowance on the free
    // tier. With today's allowance fully spent, funding is zero, so even the
    // cheapest candidate plus the classifier reserve is out of reach and the
    // candidate list is empty.
    await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 0n });
    await db.insert(wallets).values({ userId, type: 'free', balanceNanoUsd: 0n });
    await db
      .insert(allowanceSpending)
      .values({ userId, day: utcDayKey(new Date()), spentNanoUsd: DAILY_ALLOWANCE_NANO_USD });
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_ADMISSION' });
  });

  it('maps a smart-model candidate-derivation failure to its domain error response (503)', async () => {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    // Fail only the allowance leg of the balance read: the turn context
    // (readWallets) still resolves, so the error surfaces inside the
    // smart-model candidate derivation and rides the route's domain-error map.
    const billing = createBillingStores();
    const failingBilling: typeof billing = {
      ...billing,
      readAllowanceSpent: () => errAsync(unavailableError('allowance read down')),
    };
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: failingBilling,
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          turnSources: [{ kind: 'smart' }],
          userMessage: { content: 'hello' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});
