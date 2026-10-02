// POST /chat/trial's send contract: the run handle, the reasoning plan under the 1¢
// ceiling, the classifier stage, and trial-session minting.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelCatalog } from '@hushbox/db';
import {
  CANONICAL_REASONING_EFFORTS,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  CanonicalReasoningEffort,
  buildTurnSystemPrompt,
  planReasoning,
  promptCharacterCount,
  reasoningPlanModelFrom,
  utcDayKey,
} from '@hushbox/shared';
import { okAsync } from '../../lib/result/index.js';
import {
  CHAT_CLASSIFIER_INPUT,
  CHAT_DECISION_DOMAIN_INPUT,
  CHAT_TURN_INPUT,
} from './domain/index.js';
import {
  MODEL,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  getPath,
  pinTrialCatalogBaseline,
  postPath,
  postTrial,
  recordingUpgrade,
  seedGateModel,
  seedInheritedCatalogRows,
  seedModel,
  seedTrialDecoys,
  seedUser,
  trialHeaders,
  withPinnedTrialCatalog,
} from '../../test-support/chat-routes.integration.setup.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime';

describe('chat route: POST /chat/trial', () => {
  // Rows an earlier test file left in this worker slot's catalog, which the
  // premium percentile is taken over. Seeded before the baseline below so the
  // baseline is what makes this suite's verdicts its own.
  beforeAll(seedInheritedCatalogRows);
  beforeEach(pinTrialCatalogBaseline);

  it('refuses an authenticated caller (belongs on the main chat)', async () => {
    const userId = await seedUser();
    const res = await postTrial(
      fakeRealtime(STARTED),
      trialHeaders({ cookie: await cookie(userId) }),
      {
        turnSources: [{ kind: 'model', id: MODEL }],
        prompt: 'hi',
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'AUTHENTICATED_ON_TRIAL' });
  });

  it('refuses a web-search request (an account feature)', async () => {
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
      webSearchEnabled: true,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FEATURE_REQUIRES_AUTH' });
  });

  // The trial turn has no fan-out builder, so the mixed shape is not
  // representable at all here — the source list is bounded to one answer, which
  // refuses the slot beside a pinned model from either end.
  for (const [label, sources] of [
    ['slot first', [{ kind: 'smart' }, { kind: 'model', id: MODEL }]],
    ['slot last', [{ kind: 'model', id: MODEL }, { kind: 'smart' }]],
  ] as const) {
    it(`refuses a trial send carrying the Smart slot beside a pinned model, ${label} (400)`, async () => {
      const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: sources,
        prompt: 'hi',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'VALIDATION' });
    });
  }

  it('requires an Idempotency-Key', async () => {
    const res = await postTrial(
      fakeRealtime(STARTED),
      { 'x-trial-token': crypto.randomUUID() },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(res.status).toBe(400);
  });

  it('starts a trial run (201) echoing the supplied session id', async () => {
    await seedModel();
    // A supplied token resolves as the session id, so the run room and the
    // returned trialSessionId are that token.
    const token = crypto.randomUUID();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders({ 'x-trial-token': token }), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: 'run-x', deadlineAt: 999, trialSessionId: token });
  });

  it('drops a custom-instructions key instead of refusing the send', async () => {
    // Custom instructions are an account feature; the trial send carries none.
    // The body schema is a plain object, so a key it does not declare is
    // stripped in parsing and the send still starts — only the nested source
    // objects are strict. A stray caller therefore gets its run, not a 400,
    // and the run body (which the executor reads instructions off) stays clean.
    await seedModel();
    const captured: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const token = crypto.randomUUID();
    const res = await postTrial(realtime, trialHeaders({ 'x-trial-token': token }), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
      customInstructions: 'answer in French',
    });
    expect(res.status).toBe(201);
    expect(captured[0]?.customInstructions).toBeUndefined();
  });

  /**
   * Rates at which the 1¢ ceiling is genuinely the binding term for a reasoning
   * level. Stored at 800 / 1,200, they are held at their ceilings, 1,000 /
   * 1,500: `medium` (B = 12,288) plus a minimum viable answer costs
   * 13,288 × 1,500 ≈ 19.9M nano and overruns the ceiling, while `low` (B = 4,096)
   * plus one fits. The suite's default 2/3 nano rates cannot tell the two apart —
   * storage-free, every level fits a 1¢ ceiling there — so a refusal pinned on that
   * basis would pin nothing. Determinism comes from the seeding, not the rates —
   * see {@link REASONING_TRIAL_FIXTURE}.
   */
  const REASONING_TRIAL_RATES = { anchor: { base: { input: '800', output: '1200' } } } as const;

  /**
   * The reasoning fixture's descriptor. Seeded through `withPinnedTrialCatalog`
   * rather than `seedGateModel` alone: the premium gate ranks a model against a
   * percentile of the whole exposed pool, so a re-rated fixture landing beside
   * enough cheap rows reads as PREMIUM and the send answers 403 instead of the
   * intended cost verdict — with nothing wrong in the code under test.
   */
  const REASONING_TRIAL_FIXTURE = {
    reasoning: { supportedEfforts: null },
    limits: { contextLength: 1_000_000 },
    pricing: REASONING_TRIAL_RATES,
  } as const;

  /** What the 1¢ ceiling buys at the ceiling of {@link REASONING_TRIAL_RATES}, storage-free. */
  function trialBuysTokens(prompt: string): number {
    return Math.floor((10_000_000 - trialInputTokens(prompt) * 1000) / 1500);
  }

  /**
   * A fixture whose rates make the CLASSIFIER RESERVE the term that decides the
   * send: the smallest viable answer sits inside the 1¢ ceiling while that answer
   * plus the reserve does not. The reserve is the classifier's own truncated
   * prompt at the engine's input rate plus `CLASSIFIER_OUTPUT_TOKEN_CAP` at its
   * output rate, so a high OUTPUT rate is what separates the two sides here.
   *
   * Which side of the ceiling each lands on is pinned by the companion pair of
   * tests, not asserted by this comment: the no-auto send must answer 201 for the
   * auto send's 402 to mean anything.
   */
  const CLASSIFIER_RESERVE_TRIAL_FIXTURE = {
    reasoning: { supportedEfforts: null },
    limits: { contextLength: 1_000_000 },
    pricing: { anchor: { base: { input: '800', output: '2400' } } },
  } as const;

  /**
   * {@link withPinnedTrialCatalog} WITHOUT its cheap 2/3-nano row, so the seeded
   * fixture is itself the cheapest priceable text model — which is to say the
   * classifier engine. The reserve is then priced at the fixture's own rates.
   *
   * With the cheap row present the engine is that row, its reserve is a few
   * thousand nano, and no rate on the fixture can make the reserve decide the
   * send — a classifier-cost refusal would be unobservable however the fixture is
   * priced. The pricey decoys stay, because they are what holds the premium
   * percentile above the fixture and keeps the verdict a cost one.
   */
  async function withFixtureAsEngineTrialCatalog<T>(
    fixtureId: string,
    descriptorOverrides: Record<string, unknown>,
    postSend: () => Promise<T>
  ): Promise<T> {
    await db.delete(modelCatalog);
    await seedTrialDecoys();
    await seedGateModel(fixtureId, descriptorOverrides);
    return postSend();
  }

  /**
   * The trial turn's input-token count: the ONE shared prompt measurement (system
   * prompt included, so the oracle moves with the wire prompt) at 3 characters per
   * token.
   */
  function trialInputTokens(prompt: string): number {
    const chars = promptCharacterCount({
      systemPrompt: buildTurnSystemPrompt({ utcDay: utcDayKey(new Date()) }),
      historyCharacters: 0,
      prompt,
    });
    return Math.ceil(chars / 3);
  }

  it('caps a trial single-model answer at its context headroom when the money does not bind', async () => {
    // BILLING §Model bounds: ceiling = min(providerCap, contextHeadroom, budgetBuys).
    // The seeded model has no provider cap, and with its stored 3-nano output
    // rate held at the ceiling of 4 nano per token the 1¢ ceiling buys ~2.5M
    // tokens — far past this 1M window — so the PROMPT is what binds and the cap
    // is the context headroom.
    //
    // Recorded because it is the trap in this fixture: the spec-conformant cap here
    // equals what an entirely UNBOUNDED cap would also produce, so this case pins the
    // physical bound and proves nothing about the money term. The companion below is
    // the one that binds on money.
    const bigCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await withPinnedTrialCatalog(bigCtx, { limits: { contextLength: 1_000_000 } }, () =>
      postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: bigCtx }],
        prompt: 'hi',
      })
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({
      maxOutputTokens: 1_000_000 - trialInputTokens('hi'),
    });
  });

  it('caps a trial single-model answer at what the 1¢ ceiling buys when the money binds', async () => {
    // The companion case, on a window wide enough that the MONEY term is tightest.
    // The oracle is §Model bounds' `budgetBuys` on a turn that never persists, so
    // §Trial Usage gives it no storage term at all:
    //   floor((1¢ − inputTokens × inputRate) / outputRate), at 3/4, the ceilings
    //   of the seeded 2/3 rates.
    // Storage would have swallowed ~99.8% of this ceiling — the old cap was 7,909
    // tokens on the 1M-window fixture — and a trial turn does not pay it.
    const wideCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await withPinnedTrialCatalog(
      wideCtx,
      { limits: { contextLength: 5_000_000 } },
      () =>
        postTrial(realtime, trialHeaders(), {
          turnSources: [{ kind: 'model', id: wideCtx }],
          prompt: 'hi',
        })
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const inputTokens = trialInputTokens('hi');
    const buys = Math.floor((10_000_000 - inputTokens * 3) / 4);
    // The money term is genuinely the binding one here, which is what the other
    // fixture cannot show.
    expect(buys).toBeLessThan(5_000_000 - inputTokens);
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ maxOutputTokens: buys });
  });

  it('refuses a trial reasoning level whose plan exceeds the 1¢ ceiling with 402', async () => {
    // Same cheap-model basis as the cap test: medium's 12_288-token reasoning
    // budget plus the minimum answer overruns the 1¢ ceiling — computed via the
    // shared plan, never a hardcoded level list.
    const bigCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withPinnedTrialCatalog(bigCtx, REASONING_TRIAL_FIXTURE, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: bigCtx }],
        prompt: 'hi',
        reasoningEffort: 'medium',
      })
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  it('classifies a trial auto send instead of running it reasoning-free', async () => {
    // The inversion of the old trial behaviour: `auto` used to compile a turn
    // with no reasoning wire at all whenever the model offered two or more real
    // choices — the silent static fallback §Reasoning Effort 5 forbids, on the
    // path §Trial Usage names. It now takes the same classifier stage a paid
    // pinned+auto send takes, under the trial policy.
    const autoCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await withPinnedTrialCatalog(autoCtx, REASONING_TRIAL_FIXTURE, () =>
      postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: autoCtx }],
        prompt: 'hi',
        reasoningEffort: 'auto',
      })
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    expect(definition.nodes.at(-1)).toMatchObject({
      type: 'smartModel',
      candidates: [{ id: autoCtx }],
      classify: { model: false, effort: true },
    });
  });

  it('sends the trial classifier its own rendered input, not the answer prompt', async () => {
    // The trial arm used to hand the run a single hardcoded prompt input, so a
    // classifier node compiled onto it would have had nothing to read. Its input
    // carries the rendered option lines the reserve is priced against — which the
    // turn prompt does not.
    const autoCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const captured: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await withPinnedTrialCatalog(autoCtx, REASONING_TRIAL_FIXTURE, () =>
      postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: autoCtx }],
        prompt: 'hi',
        reasoningEffort: 'auto',
      })
    );
    expect(res.status).toBe(201);
    const inputs = captured[0]?.inputs;
    const classifier = inputs?.[CHAT_CLASSIFIER_INPUT];
    const prompt = inputs?.[CHAT_TURN_INPUT];
    expect(prompt).toEqual({ kind: 'text', text: 'hi' });
    expect(classifier?.kind === 'text' && classifier.text).toContain(
      CLASSIFIER_SYSTEM_PROMPT_MARKER
    );
    expect(classifier).not.toEqual(prompt);
    // And the presented options reach the reducer, so its fallback is the
    // turn's cheapest rather than the axis's.
    const presented = inputs?.[CHAT_DECISION_DOMAIN_INPUT];
    expect(presented?.kind === 'text' && presented.text.length > 0).toBe(true);
  });

  it('offers the trial classifier only the rungs the 1¢ ceiling funds', async () => {
    // The classifier reads the trial menu at the request's instant, so it is
    // offered the funded prefix of the ladder, never the whole of it: no offered
    // rung's reasoning budget is past what the 1¢ ceiling buys.
    const autoCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const captured: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await withPinnedTrialCatalog(autoCtx, REASONING_TRIAL_FIXTURE, () =>
      postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: autoCtx }],
        prompt: 'hi',
        reasoningEffort: 'auto',
      })
    );
    expect(res.status).toBe(201);
    // The input carries the turn's decision domain; its presented rungs are
    // what the classifier was offered.
    const domain = captured[0]?.inputs[CHAT_DECISION_DOMAIN_INPUT];
    const offered =
      domain?.kind === 'text'
        ? z.object({ presentedEfforts: z.array(z.string()) }).parse(JSON.parse(domain.text))
            .presentedEfforts
        : [];
    const ladder = ['off', ...CANONICAL_REASONING_EFFORTS];
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(offered.length).toBeLessThan(ladder.length);
    expect(offered).toEqual(ladder.slice(0, offered.length));
    for (const rung of offered.filter((id) => id !== 'off')) {
      const planned = planReasoning(
        reasoningPlanModelFrom(REASONING_TRIAL_FIXTURE),
        CanonicalReasoningEffort.parse(rung),
        1
      );
      if (!planned.feasible) throw new Error(`the fixture offers no '${rung}' rung`);
      expect(planned.plan.reasoningBudgetTokens).toBeLessThan(trialBuysTokens('hi'));
    }
  });

  it('leaves a classified trial definition unstamped and on the trial policy', async () => {
    // A trial turn persists nothing, so the classified definition must carry the
    // no-persist policy and no storage stamp — otherwise admission would hold
    // storage that settlement can never bill.
    const autoCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    await withPinnedTrialCatalog(autoCtx, REASONING_TRIAL_FIXTURE, () =>
      postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: autoCtx }],
        prompt: 'hi',
        reasoningEffort: 'auto',
      })
    );
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    expect(definition.storage).toBeUndefined();
    expect(definition.hooks).toEqual({ admission: 'trial', settlement: 'trial' });
  });

  it('keeps a trial auto send on the regular turn for a non-reasoning model', async () => {
    // A non-reasoning model presents no effort choice, so this send has nothing
    // to classify and the regular compile resolves it.
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    await seedModel();
    const res = await postTrial(realtime, trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
      reasoningEffort: 'auto',
    });
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    expect(definition.nodes.map((node) => node.type)).toEqual(['modelCall']);
  });

  /** The pair's context window in whole tokens; the fractional arm is this plus a half. */
  const WHOLE_WINDOW_TOKENS = 100_000;

  /**
   * A reasoning fixture at the suite's default cheap rates, so nothing but the
   * classifier engine can decide the send.
   */
  const SOLE_ROW_TRIAL_FIXTURE = {
    reasoning: { supportedEfforts: null },
    limits: { contextLength: WHOLE_WINDOW_TOKENS },
  } as const;

  /**
   * The same fixture with a FRACTIONAL context window, which is what leaves a
   * trial-eligible model with no engine to classify it. The two projections
   * disagree on such a window and that disagreement is the whole mechanism:
   * trial eligibility prices a model through the plain money projection, which
   * FLOORS the window, while the classifier engine is drawn from the shared
   * pool projection, which EXCLUDES it outright. So the send is admitted and
   * has nothing to classify it with.
   */
  const FRACTIONAL_WINDOW_TRIAL_FIXTURE = {
    ...SOLE_ROW_TRIAL_FIXTURE,
    limits: { contextLength: WHOLE_WINDOW_TOKENS + 0.5 },
  } as const;

  /**
   * The fixture as the WHOLE exposed catalog — no baseline row and no decoys,
   * so nothing else can win the engine pick and the two sends below differ only
   * in the seeded window.
   *
   * Exclusivity also keeps the premium leg out of the verdict: a priceable-text
   * pool under the percentile's minimum size has no price threshold at all, so
   * neither send can be refused for ranking above one.
   */
  async function withSoleTrialCatalogRow<T>(
    fixtureId: string,
    descriptorOverrides: Record<string, unknown>,
    postSend: () => Promise<T>
  ): Promise<T> {
    await db.delete(modelCatalog);
    await seedGateModel(fixtureId, descriptorOverrides);
    return postSend();
  }

  it('starts the same sole-row trial auto send once the window is whole (201)', async () => {
    // The premise the classifier-code refusal rests on. Without it that 503
    // could be the catalog holding nothing sendable at all, and the pair would
    // pin nothing about the engine: on a whole window the one row IS the
    // engine, so the send classifies and starts.
    const soleCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withSoleTrialCatalogRow(soleCtx, SOLE_ROW_TRIAL_FIXTURE, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: soleCtx }],
        prompt: 'hi',
        reasoningEffort: 'auto',
      })
    );
    expect(res.status).toBe(201);
  });

  it('refuses a trial auto send with the typed classifier code when no engine can be priced (503)', async () => {
    // The fourth outcome of this arm: the compile REFUSES rather than resolving
    // the effort itself, because a static pick is what BILLING §Reasoning
    // Effort 5 forbids on every tier. The row seeded below is the shape
    // ingestion no longer stores, so this drives a row persisted before that
    // guard; `routes.ts`'s `trialAutoDefinitionOrRefusal` docblock owns that
    // provenance and the projection disagreement behind it.
    const noEngineCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withSoleTrialCatalogRow(noEngineCtx, FRACTIONAL_WINDOW_TRIAL_FIXTURE, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: noEngineCtx }],
        prompt: 'hi',
        reasoningEffort: 'auto',
      })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'CLASSIFIER_UNAVAILABLE' });
  });

  it('runs the classifier-reserve fixture without auto (201 — the answer alone fits)', async () => {
    // The premise the refusal below rests on. Without it the 402 could be the
    // model gate refusing an over-cap model, and the pair would pin nothing.
    const engineCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withFixtureAsEngineTrialCatalog(
      engineCtx,
      CLASSIFIER_RESERVE_TRIAL_FIXTURE,
      () =>
        postTrial(fakeRealtime(STARTED), trialHeaders(), {
          turnSources: [{ kind: 'model', id: engineCtx }],
          prompt: 'hi',
        })
    );
    expect(res.status).toBe(201);
  });

  it('refuses a trial auto send whose classifier reserve overruns the 1¢ ceiling (402)', async () => {
    // The same model and the same prompt as the 201 above, differing only in
    // `auto` — so the ceiling that the answer fits is the ceiling the answer plus
    // the classifier's reserve does not. Auto is priced, never silently degraded
    // to a reasoning-free turn (BILLING §Reasoning Effort 5, §Trial Usage).
    const engineCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withFixtureAsEngineTrialCatalog(
      engineCtx,
      CLASSIFIER_RESERVE_TRIAL_FIXTURE,
      () =>
        postTrial(fakeRealtime(STARTED), trialHeaders(), {
          turnSources: [{ kind: 'model', id: engineCtx }],
          prompt: 'hi',
          reasoningEffort: 'auto',
        })
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  /**
   * Rates at which the 1¢ ceiling buys an answer but no rung: held at their
   * ceilings, 1,000 / 4,000, it fits a cap past the minimum-answer floor and
   * short of Lite's budget plus that same floor. The ladder is full (six
   * choices), so the turn classifies.
   */
  const UNFUNDABLE_LADDER_TRIAL_FIXTURE = {
    reasoning: { supportedEfforts: null },
    limits: { contextLength: 1_000_000 },
    pricing: { anchor: { base: { input: '800', output: '3200' } } },
  } as const;

  it('sends the same fixture without auto (201 — the answer alone fits the ceiling)', async () => {
    // The baseline the auto case at this rate is measured against: same fixture,
    // same prompt, so `reasoningEffort: 'auto'` is the only variable between them.
    const ladderCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withPinnedTrialCatalog(ladderCtx, UNFUNDABLE_LADDER_TRIAL_FIXTURE, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: ladderCtx }],
        prompt: 'hi',
      })
    );
    expect(res.status).toBe(201);
  });

  it('sends a trial auto send whose ceiling buys no offered rung (201)', async () => {
    // The same model and prompt as the 201 above, differing only in `auto`. Six
    // real choices exist, so the turn classifies, and the ceiling buys no rung
    // with a minimum answer beside it. The send is admitted rather than
    // refused: a laddered model is not owed a rung, and the executor replans
    // the classifier's pick into the cap the hold already priced.
    const ladderCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withPinnedTrialCatalog(ladderCtx, UNFUNDABLE_LADDER_TRIAL_FIXTURE, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: ladderCtx }],
        prompt: 'hi',
        reasoningEffort: 'auto',
      })
    );
    expect(res.status).toBe(201);
  });

  it('runs a ceiling-fitting trial reasoning level with the wire and explicit B+H cap (201)', async () => {
    const bigCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await withPinnedTrialCatalog(bigCtx, REASONING_TRIAL_FIXTURE, () =>
      postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id: bigCtx }],
        prompt: 'hi',
        reasoningEffort: 'low',
      })
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    // The 1¢ ceiling buys `trialBuysTokens` total output tokens storage-free; low
    // reserves B=4096 of them, leaving the rest as H — the wire cap stays B+H and is
    // ALWAYS explicit on a reasoning call, trial included. B is never shrunk, so
    // the level either fits with a minimum viable answer beside it or is refused.
    expect(answer?.type === 'modelCall' && answer.params).toEqual({
      maxOutputTokens: trialBuysTokens('hi'),
      reasoning: { effort: 'low' },
    });
  });

  it('refuses a trial reasoning effort on a non-reasoning model with 400', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
      reasoningEffort: 'low',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('pins an explicit reasoning level on a trial smart-model send (201)', async () => {
    await seedModel();
    // An effort pins onto a reasoning-capable candidate, and the catalog baseline
    // declares none — without one the send has no eligible candidate to carry the
    // level and answers 402 on cost.
    await seedGateModel(`chat-route/${crypto.randomUUID().slice(0, 8)}`, {
      reasoning: { supportedEfforts: null },
    });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'smart' }],
      prompt: 'hi',
      reasoningEffort: 'low',
    });
    expect(res.status).toBe(201);
  });

  it("passes 'off' through a trial smart-model send untouched (201 — the no-op direction of the refusal seam)", async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'smart' }],
      prompt: 'hi',
      reasoningEffort: 'off',
    });
    expect(res.status).toBe(201);
  });

  it('mints and returns a session id a tokenless client can attach to its room', async () => {
    await seedModel();
    // No x-trial-token: the route mints a fresh session id and runs in trial:<id>.
    let capturedRoom = '';
    const realtime = fakeRealtime(STARTED, {
      startRun: (conversationId) => {
        capturedRoom = conversationId;
        return okAsync(STARTED);
      },
    });
    const res = await postTrial(
      realtime,
      {
        'Idempotency-Key': crypto.randomUUID(),
        'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
      },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(res.status).toBe(201);
    // The run room is trial:<mintedSessionId>; the 201 echoes that session id so
    // a tokenless client learns it.
    const sessionId = capturedRoom.replace(/^trial:/, '');
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toEqual({
      runId: 'run-x',
      deadlineAt: 999,
      trialSessionId: sessionId,
    });

    // A follow-up WS upgrade using that id as the token attaches to the SAME
    // server-derived room the run started in.
    const { calls, realtime: wsRealtime } = recordingUpgrade();
    const ws = await getPath('/chat/trial/websocket', wsRealtime, { 'x-trial-token': sessionId });
    expect(ws.status).toBe(200);
    expect(calls).toEqual([
      { conversationId: capturedRoom, principalId: capturedRoom, isGuest: false },
    ]);
  });

  it('ignores a trialToken query param on the POST (header-only route)', async () => {
    await seedModel();
    const queryToken = crypto.randomUUID();
    let capturedRoom = '';
    const realtime = fakeRealtime(STARTED, {
      startRun: (conversationId) => {
        capturedRoom = conversationId;
        return okAsync(STARTED);
      },
    });
    // No x-trial-token header: the WS-only query fallback must NOT leak into
    // the POST — the route mints a fresh session instead of adopting the param.
    const res = await postPath(
      `/chat/trial?trialToken=${encodeURIComponent(queryToken)}`,
      realtime,
      {
        'Idempotency-Key': crypto.randomUUID(),
        'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
      },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(res.status).toBe(201);
    expect(capturedRoom).toMatch(/^trial:/);
    expect(capturedRoom).not.toBe(`trial:${queryToken}`);
  });

  it('replays a settled trial key without the session-id 201 shape (200)', async () => {
    await seedModel();
    // A non-started outcome (a settled key replay) takes the shared contract, not
    // the fresh-run 201 — so no trialSessionId is minted onto it.
    const realtime = fakeRealtime({ outcome: 'replay', response: { runId: 'settled-trial' } });
    const res = await postTrial(realtime, trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'settled-trial' });
  });

  it('maps a trial run-start refusal to its status (409) without a session id', async () => {
    await seedModel();
    const realtime = fakeRealtime({ started: false, code: 'CONCURRENT_RUN' });
    const res = await postTrial(realtime, trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
    });
    expect(res.status).toBe(409);
  });

  it('refuses an unknown model with 400', async () => {
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: 'no/such-model' }],
      prompt: 'hi',
    });
    expect(res.status).toBe(400);
  });

  it('does not consume a quota slot for a refused unknown-model request', async () => {
    await seedModel();
    // One fixed identity so both quota counters would accumulate if the refused
    // requests consumed slots. The daily limit is 5; five refusals followed by a
    // valid send proves the refusals burned nothing (validation precedes the INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'model', id: 'no/such-model' }], prompt: 'hi' }
      );
      expect(refused.status).toBe(400);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });
});
