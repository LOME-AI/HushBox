// POST /chat/trial's eligibility gates (media, premium, over-1¢), the Smart Model
// candidate set, the 5/day quota, and the per-IP abuse throttle.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, SMART_MODEL_ID, TRIAL_MESSAGE_LIMIT } from '@hushbox/shared';
import { TEST_DAY_START, freezeClock } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
  listDescriptors,
  trialGateVerdict,
} from './domain/index.js';
import { turnPromptCharacterCount } from './routes/request-shapes.js';
import {
  MODEL,
  MODEL_B,
  STARTED,
  createApp,
  db,
  fakeRealtime,
  ipIdentity,
  pinTrialCatalogBaseline,
  postTrial,
  recordingRealtime,
  redis,
  seedGateModel,
  seedImageGateModel,
  seedInheritedCatalogRows,
  seedModel,
  seedModelId,
  seedUnrepresentableGateModel,
  testEnv,
  trialDecoyModelIds,
  trialHeaders,
  withDearTrialCatalog,
} from '../../test-support/chat-routes.integration.setup.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import type { RealtimeBroadcast } from '../conversations/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
import type { WorkflowDefinition } from '@hushbox/shared';

describe('chat route: POST /chat/trial', () => {
  // Rows an earlier test file left in this worker slot's catalog, which the
  // premium percentile is taken over. Seeded before the baseline below so the
  // baseline is what makes this suite's verdicts its own.
  beforeAll(seedInheritedCatalogRows);
  beforeEach(pinTrialCatalogBaseline);

  it('builds the classified smartModel definition for a trial smart-model send (201)', async () => {
    await seedModel();
    // Two eligible candidates are what make this a routing decision: one leaves
    // the model axis closed, and the classifier pair is not built. Seeded here
    // rather than in a hook because a sibling case wipes the catalog table.
    await seedModelId(MODEL_B);
    const captured: WorkflowDefinition[] = [];
    const modes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        modes.push(body.mode);
        return okAsync(STARTED);
      },
    });
    const res = await postTrial(realtime, trialHeaders(), {
      turnSources: [{ kind: 'smart' }],
      prompt: 'hello',
    });
    expect(res.status).toBe(201);
    expect(modes).toEqual(['trial']);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    // The same smartModel turn as the paid path, under the trial
    // (no-persist / no-charge) hooks.
    expect(definition.hooks).toEqual({ admission: 'trial', settlement: 'trial' });
    const node = definition.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    // Candidates are server-derived from the trial-eligible catalog subset
    // (the file seeds catalog rows across tests, so assert membership and
    // invariants, never an exact list). The expensive decoys fail the trial
    // affordability leg, so they can never appear.
    const candidateIds = node.candidates.map((candidate) => candidate.id);
    // A single candidate closes the model axis, so no classifier pair is built
    // and the definition collapses to the bare smartModel node. Assert the
    // precondition before the shape, or a fixture that stops seeding a second
    // eligible model reads as an unexplained node-shape mismatch.
    expect(candidateIds.length).toBeGreaterThanOrEqual(2);
    expect(definition.nodes.map((one) => one.type)).toEqual(['modelCall', 'fanIn', 'smartModel']);
    expect(candidateIds).toContain(MODEL);
    expect(candidateIds).not.toContain(SMART_MODEL_ID);
    for (const decoyId of trialDecoyModelIds) {
      expect(candidateIds).not.toContain(decoyId);
    }
    expect(node.classifierModelId).toBe(candidateIds[0]);
  });

  // Large enough that even a 1-nano-per-input-token candidate's message base
  // (chars / 3 tokens) exceeds the 1¢ cap, so NO candidate can be eligible.
  const OVER_CAP_PROMPT_CHARS = 31_500_000;

  it('refuses a trial smart-model send with no eligible candidate as 402 TRIAL_MESSAGE_TOO_EXPENSIVE', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'smart' }],
      prompt: 'x'.repeat(OVER_CAP_PROMPT_CHARS),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  it('burns no quota slot for a trial smart-model refusal', async () => {
    await seedModel();
    // One fixed identity: five 402 refusals then a valid send prove the
    // refusals burned no slot (the candidate derivation precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.13-${crypto.randomUUID()}`,
    };
    const overCap = 'x'.repeat(OVER_CAP_PROMPT_CHARS);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'smart' }], prompt: overCap }
      );
      expect(refused.status).toBe(402);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { turnSources: [{ kind: 'smart' }], prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });

  it('consumes exactly one quota slot per successful trial smart-model send', async () => {
    await seedModel();
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.14-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const ok = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'smart' }], prompt: 'hi' }
      );
      expect(ok.status).toBe(201);
    }
    const sixth = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { turnSources: [{ kind: 'smart' }], prompt: 'hi' }
    );
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ code: 'TRIAL_LIMIT_REACHED' });
  });

  it('refuses web search on a trial smart-model send first (403 FEATURE_REQUIRES_AUTH)', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'smart' }],
      prompt: 'hi',
      webSearchEnabled: true,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FEATURE_REQUIRES_AUTH' });
  });

  it('blocks a non-text (image) model with 403 MEDIA_TRIAL_BLOCKED', async () => {
    const imageId = `chat-route-image/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageId);
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: imageId }],
      prompt: 'hi',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'MEDIA_TRIAL_BLOCKED' });
  });

  // ROUTE ORDERING, not compile behaviour: `trialTurnDefinitionOrRefusal`
  // (`apps/api/src/slices/chat/routes.ts`) runs the model/affordability gate
  // BEFORE the reasoning-acceptance leg, so a media send carrying an effort
  // level is answered by the gate and never by that leg.
  //
  // The order is load-bearing because `trialReasoningSelection` is
  // modality-sensitive where the compile is not: varying `outputs` alone flips
  // its answer, pinned in
  // `apps/api/src/slices/chat/domain/turn/definition.test.ts`. The gate running
  // first is the only reason that sensitivity never reaches a client. Measured
  // by moving the gate call below the acceptance leg in `routes.ts`: this case
  // then answers 400, and the other cases in this file stay green.
  it('answers a media send naming an effort level with the media block', async () => {
    const imageId = `chat-route-image/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageId);
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: imageId }],
      prompt: 'hi',
      reasoningEffort: 'low',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'MEDIA_TRIAL_BLOCKED' });
  });

  // `off` short-circuits the trial acceptance leg untouched, so the compile owns
  // this refusal — the division `trialSingleTurnDefinition`'s docblock states.
  // The leg is pinned in `apps/api/src/slices/chat/domain/turn/reasoning.test.ts`
  // and the compile's surfacing of it in
  // `apps/api/src/slices/chat/domain/turn/definition.test.ts`; what this case adds
  // is that it reaches a trial caller as a 400 rather than being dropped.
  it('refuses a mandatory-reasoning model asked to turn reasoning off with 400', async () => {
    const mandatoryId = `chat-route-mandatory/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(mandatoryId, { reasoning: { mandatory: true, supportedEfforts: null } });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: mandatoryId }],
      prompt: 'hi',
      reasoningEffort: 'off',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('blocks a premium (recently released) model with 403 PREMIUM_REQUIRES_ACCOUNT', async () => {
    const premiumId = `chat-route-premium/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(premiumId, { releasedAt: Math.floor(Date.now() / 1000) });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: premiumId }],
      prompt: 'hi',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'PREMIUM_REQUIRES_ACCOUNT' });
  });

  it('blocks an over-1¢ message with 402 TRIAL_MESSAGE_TOO_EXPENSIVE', async () => {
    const dearId = `chat-route-dear/${crypto.randomUUID().slice(0, 8)}`;
    // The dear model is eligible on the model legs (old, below-quartile), yet a
    // long prompt pushes the actual message past 1¢ on the minimum basis. Its
    // refusal class is percentile-dependent, so pin a deterministic catalog.
    const res = await withDearTrialCatalog(dearId, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: dearId }],
        prompt: 'x'.repeat(37_500),
      })
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  describe('a trial auto send on a mandatory-reasoning model offering one rung', () => {
    const silentTelemetry: Telemetry = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      captureError: () => {},
    };
    const AUTO_PROMPT = 'Explain how tides work.';

    // Date alone is frozen, so the route and the gate precondition judge one
    // instant while the database and Redis clients keep their real timers.
    beforeEach(() => {
      freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Seeds the single-rung mandatory model at `outputPerToken` nano-USD per output token. */
    async function seedSingleRungMandatory(outputPerToken: string): Promise<string> {
      const id = `chat-route-single-rung/${crypto.randomUUID().slice(0, 8)}`;
      await seedGateModel(id, {
        reasoning: { mandatory: true, supportedEfforts: ['high'] },
        pricing: { anchor: { base: { input: '100', output: outputPerToken } } },
      });
      return id;
    }

    /** The trial gate's verdict on `id` over the persisted catalog, at the prompt the route prices. */
    async function trialGateOn(id: string): Promise<string> {
      const read = await listDescriptors({ db, telemetry: silentTelemetry });
      const catalog = read._unsafeUnwrap();
      return trialGateVerdict(
        catalog.find((descriptor) => descriptor.id === id),
        catalog,
        turnPromptCharacterCount({}, AUTO_PROMPT, []),
        TEST_DAY_START
      )._unsafeUnwrap();
    }

    it('refuses a trial auto send on a single-rung mandatory model the ceiling cannot fund as 402 TRIAL_MESSAGE_TOO_EXPENSIVE', async () => {
      const id = await seedSingleRungMandatory('400');
      expect(await trialGateOn(id)).toBe('allowed');
      const { starts, realtime } = recordingRealtime();
      // A full day's allowance of refusals on one identity, then a valid send:
      // the closing 201 holds only if no refusal spent a slot.
      const fixed = {
        'x-trial-token': crypto.randomUUID(),
        'cf-connecting-ip': `203.0.113.15-${crypto.randomUUID()}`,
      };
      for (let attempt = 1; attempt <= TRIAL_MESSAGE_LIMIT; attempt += 1) {
        const refused = await postTrial(
          realtime,
          { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
          { turnSources: [{ kind: 'model', id }], prompt: AUTO_PROMPT, reasoningEffort: 'auto' }
        );
        expect(refused.status).toBe(402);
        expect(await refused.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
      }
      expect(starts).toEqual([]);
      const ok = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
      );
      expect(ok.status).toBe(201);
    });

    it('builds a trial auto send on a single-rung mandatory model the ceiling funds', async () => {
      const id = await seedSingleRungMandatory('100');
      expect(await trialGateOn(id)).toBe('allowed');
      const { starts, realtime } = recordingRealtime();
      const res = await postTrial(realtime, trialHeaders(), {
        turnSources: [{ kind: 'model', id }],
        prompt: AUTO_PROMPT,
        reasoningEffort: 'auto',
      });
      expect(res.status).toBe(201);
      expect(starts).toEqual([1]);
    });
  });

  it('refuses a text model with no token price at the premium gate', async () => {
    const partialId = `chat-route-partial/${crypto.randomUUID().slice(0, 8)}`;
    // Priced per image: text on the model legs, but no token turn can price it
    // for trial, so the eligibility gate excludes it as a premium exclusion.
    await seedUnrepresentableGateModel(partialId, {
      pricing: { kind: 'perImage', anchor: '2', dearest: '2' },
    });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: partialId }],
      prompt: 'hi',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'PREMIUM_REQUIRES_ACCOUNT' });
  });

  it('lets an eligible cheap text model through, consuming a quota slot', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
    });
    expect(res.status).toBe(201);
  });

  it('burns no quota slot for a gate refusal', async () => {
    const imageId = `chat-route-image/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageId);
    await seedModel();
    // One fixed identity: five refusals then a valid send prove the refusals
    // burned no slot (the gate precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.9-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'model', id: imageId }], prompt: 'hi' }
      );
      expect(refused.status).toBe(403);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });

  it('burns no quota slot for a premium-model refusal', async () => {
    const premiumId = `chat-route-premium/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(premiumId, { releasedAt: Math.floor(Date.now() / 1000) });
    await seedModel();
    // One fixed identity: five 403 PREMIUM refusals then a valid send prove the
    // refusals burned no slot (the gate precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.11-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'model', id: premiumId }], prompt: 'hi' }
      );
      expect(refused.status).toBe(403);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });

  it('burns no quota slot for an over-1¢ message refusal', async () => {
    const dearId = `chat-route-dear/${crypto.randomUUID().slice(0, 8)}`;
    // One fixed identity: five 402 TOO_EXPENSIVE refusals then a valid send prove
    // the refusals burned no slot (the affordability check precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.12-${crypto.randomUUID()}`,
    };
    // Pin a deterministic catalog for the whole sequence: the refusals' 402-vs-403
    // class is percentile-dependent (the helper seeds `dearId` + MODEL), and the
    // closing 201 on MODEL is a catalog-sensitive success send.
    await withDearTrialCatalog(dearId, async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const refused = await postTrial(
          fakeRealtime(STARTED),
          { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
          { turnSources: [{ kind: 'model', id: dearId }], prompt: 'x'.repeat(37_500) }
        );
        expect(refused.status).toBe(402);
      }
      const ok = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
      );
      expect(ok.status).toBe(201);
    });
  });

  it('mints a session and defaults the IP when the token and IP headers are absent', async () => {
    await seedModel();
    // No x-trial-token (a session id is minted) and no cf-connecting-ip (the
    // sentinel IP is used) — the session counter is fresh, so the run starts.
    const res = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID() },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(res.status).toBe(201);
  });

  it('maps a realtime transport failure to 503', async () => {
    await seedModel();
    const errorRealtime: RealtimeBroadcast = {
      ...fakeRealtime(STARTED),
      startRun: () => errAsync(unavailableError('conversation room unreachable')),
    };
    const res = await postTrial(errorRealtime, trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
    });
    expect(res.status).toBe(503);
  });

  it('depletes the 5/day quota and refuses the sixth send (429)', async () => {
    await seedModel();
    // One fixed identity across the sends so the daily quota counter accumulates.
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const ok = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
      );
      expect(ok.status).toBe(201);
    }
    const sixth = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
    );
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ code: 'TRIAL_LIMIT_REACHED' });
  });

  describe('the per-IP abuse throttle', () => {
    /**
     * Puts one caller's throttle window at its cap and returns the headers that
     * identify it, so the next send from those headers is the one over the cap.
     * The key is built from the registry entry rather than spelled out, and the
     * identity comes from the same `callerIpId` the route uses — a second copy
     * of either would let the test pass while the route wrote somewhere else.
     */
    async function exhaustedThrottleHeaders(): Promise<{
      readonly headers: Record<string, string>;
      readonly key: string;
    }> {
      const ip = `203.0.113.34-${crypto.randomUUID()}`;
      const key = rateLimitKey(CHAT_TRIAL_SEND_IP_RATE_LIMIT, await ipIdentity(ip))._unsafeUnwrap();
      const { maxAttempts, windowSeconds } = CHAT_TRIAL_SEND_IP_RATE_LIMIT;
      await redis.set(key, maxAttempts, { ex: windowSeconds });
      return { headers: trialHeaders({ 'cf-connecting-ip': ip }), key };
    }

    it('refuses a send over the cap without reaching the database', async () => {
      // A dead database is what makes this a proof rather than a status check:
      // the trial send's first Postgres touch is the disabled-model gate, and
      // against this address that read answers 503 UNAVAILABLE (the sibling
      // case in the admin-disabled gate suite pins exactly that). A 429 here
      // therefore says the throttle answered before any query was issued —
      // there is no ordering in which a reached gate could return this body.
      const deadDbEnv = {
        ...testEnv,
        DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox',
      };
      const { headers, key } = await exhaustedThrottleHeaders();
      try {
        const res = await createApp(fakeRealtime(STARTED)).request(
          '/chat/trial',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }),
          },
          deadDbEnv
        );
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({
          code: 'RATE_LIMITED',
          details: { retryAfterSeconds: expect.any(Number) },
        });
      } finally {
        await redis.del(key);
      }
    });

    it('answers with a body the entitlement refusal cannot be mistaken for', async () => {
      await seedModel();
      // Two 429s on one route: the trial capacity the admission hook refuses on,
      // and this throttle. A status-only assertion cannot tell them apart, so
      // each one's body is what identifies which limiter answered.
      const entitlement = await postTrial(
        fakeRealtime({ started: false, code: ERROR_CODES.TRIAL_CAPACITY_REACHED }),
        trialHeaders(),
        { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
      );
      expect(entitlement.status).toBe(429);
      const entitlementBody = await entitlement.json();

      const { headers, key } = await exhaustedThrottleHeaders();
      try {
        const throttled = await postTrial(fakeRealtime(STARTED), headers, {
          turnSources: [{ kind: 'model', id: MODEL }],
          prompt: 'hi',
        });
        expect(throttled.status).toBe(429);
        const throttledBody = await throttled.json();
        expect(entitlementBody).toEqual({ code: 'TRIAL_CAPACITY_REACHED' });
        expect(throttledBody).toMatchObject({ code: 'RATE_LIMITED' });
        expect(throttledBody).not.toEqual(entitlementBody);
      } finally {
        await redis.del(key);
      }
    });

    it('leaves the 5/day entitlement quota unconsumed', async () => {
      await seedModel();
      const { headers, key } = await exhaustedThrottleHeaders();
      const token = crypto.randomUUID();
      try {
        // Five throttled sends on one trial token. The quota keys on that token
        // as well as on the IP, so if the throttle spent a slot the fifth would
        // have exhausted the day's allowance.
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const throttled = await postTrial(
            fakeRealtime(STARTED),
            { ...headers, 'Idempotency-Key': crypto.randomUUID(), 'x-trial-token': token },
            { turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }
          );
          expect(throttled.status).toBe(429);
        }
        // The same token from an IP whose window is open: a 201 says the day's
        // allowance is still whole, which only holds if the throttle consumed
        // none of it.
        const admitted = await postTrial(
          fakeRealtime(STARTED),
          trialHeaders({ 'x-trial-token': token }),
          {
            turnSources: [{ kind: 'model', id: MODEL }],
            prompt: 'hi',
          }
        );
        expect(admitted.status).toBe(201);
      } finally {
        await redis.del(key);
      }
    });
  });
});
