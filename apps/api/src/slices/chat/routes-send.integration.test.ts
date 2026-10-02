// POST /chat's outer contract: authentication, body validation, the run handle it
// returns, fork threading, and the idempotency referee. Turn construction lives in
// the sibling routes-send-* suites.
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import { conversationMembers, epochMembers, epochs, messages, wallets } from '@hushbox/db';
import {
  MAX_SELECTED_MODELS,
  buildTurnSystemPrompt,
  historyCharacterCount,
  promptCharacterCount,
  utcDayKey,
} from '@hushbox/shared';
import { fromPromise, okAsync } from '../../lib/result/index.js';
import { hmacRateLimitId } from '../../lib/rate-limit/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createChatStores } from './adapters/stores.js';
import { createConversationRuntime } from './domain/runtime.js';
import { promptInputTokensFor } from './domain/turn/definition.js';
import {
  BYTES,
  MODEL,
  MODEL_B,
  MODEL_C,
  STARTED,
  cookie,
  createdConversationIds,
  db,
  fakeRealtime,
  post,
  recordingRealtime,
  redis,
  seedConversation,
  seedFork,
  seedModel,
  seedModelId,
  seedPurchasedWallet,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';
import { seedConversationWithEpoch } from '../../test-support/conversation-seed.js';
import type { PaidRunIdentity, RunContext, WorkflowDefinition } from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime';
import type { RealtimeBroadcast } from '../conversations/index.js';
import type { RunStartOutcome } from '../conversations/ports/realtime.js';
import type { EpochPublicKeyReader } from './domain/settlement/settlement.js';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

describe('chat route: POST /chat', () => {
  it('rejects an anonymous request', async () => {
    const res = await post(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': 'k1' },
      {
        conversationId: 'c',
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hi' },
      }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const userId = await seedUser();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId: '',
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hi' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('requires an Idempotency-Key', async () => {
    const userId = await seedUser();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId) },
      {
        conversationId: crypto.randomUUID(),
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hi' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('rejects a models array wider than MAX_SELECTED_MODELS with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: Array.from({ length: MAX_SELECTED_MODELS + 1 }, (_, index) => ({
          kind: 'model',
          id: `m/model-${String(index)}`,
        })),
        userMessage: { content: 'hi' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, false);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': 'k2' },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hi' },
      }
    );
    expect(res.status).toBe(403);
  });

  it('returns a run handle (201) for a member with a purchased wallet', async () => {
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
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      runId: 'run-x',
      deadlineAt: 999,
      userMessageId: expect.stringMatching(UUID_PATTERN),
      assistantMessageIds: ['answer-x'],
    });
  });

  it('refuses a send whose user message carries an id with 400', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const { starts, realtime } = recordingRealtime();
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
    expect(starts).toEqual([]);
  });

  it('hands the room the user message id the run-start response returns', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const { userMessageId } = await res.json<{ userMessageId: unknown }>();
    expect(userMessageId).toEqual(expect.stringMatching(UUID_PATTERN));
    const handed = captured[0];
    // The room threads this body's user message into the run identity, and
    // settlement stores the user row under exactly that id.
    expect(handed?.mode === 'paid' ? handed.userMessage.id : undefined).toBe(userMessageId);
  });

  it('mints a fresh user message id for each send', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const send = async (): Promise<unknown> => {
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          userMessage: { content: 'hello' },
        }
      );
      const { userMessageId } = await res.json<{ userMessageId: unknown }>();
      return userMessageId;
    };
    const first = await send();
    const second = await send();
    expect(first).not.toBe(second);
  });

  it('threads supplied custom instructions onto the run body as run-scoped context', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    // customInstructions is run-scoped context (never baked into the definition,
    // which stays free of user content) that also scopes the dedup hash. The
    // executor reads it off the run body, so the run body is where it must land.
    const captured: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
        customInstructions: 'answer in French',
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.customInstructions).toBe('answer in French');
  });

  it('builds one sibling node per model when a multi-model list is sent', async () => {
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
          { kind: 'model', id: MODEL_B },
          { kind: 'model', id: MODEL_C },
        ],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    // One optional skip-on-error sibling per selected model, in the sent order.
    expect(siblings.map((node) => node.model)).toEqual([MODEL, MODEL_B, MODEL_C]);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
    }
  });

  it('prices the provider leg on the sent prompt and storage on the stored message', async () => {
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
    const history = [
      { role: 'user' as const, content: 'earlier question' },
      { role: 'assistant' as const, content: 'earlier answer' },
    ];
    const instructions = 'answer in French';
    const content = 'hello';
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content },
        history,
        customInstructions: instructions,
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    // The provider leg is measured by the ONE shared counter over the exact
    // prompt the language adapter sends — including the built system prompt,
    // which the composer preview also counts. The date line is fixed-width
    // (YYYY-MM-DD), so the length is clock-independent.
    const sent = promptCharacterCount({
      systemPrompt: buildTurnSystemPrompt({
        utcDay: utcDayKey(new Date()),
        customInstructions: instructions,
      }),
      historyCharacters: historyCharacterCount(history),
      prompt: content,
    });
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' ? answer.promptInputTokens : undefined).toBe(
      promptInputTokensFor({
        promptCharacterCount: sent,
        inputCharacterCount: content.length,
        funding: { kind: 'purchased', spendableNanoUsd: 1n },
      })
    );
    // The storage stamp carries a different measurement, because the turn stores
    // a different thing: one new user message row. The system prompt never rests
    // and the resent history was stored by the turns that wrote it.
    expect(definition.storage?.inputChars).toBe(content.length);
    expect(sent).toBeGreaterThan(content.length);
  });

  it('threads x-mock-* headers into the run-start body mockDirectives in dev/E2E', async () => {
    // The test env is NODE_ENV=development, so the route reads the mock headers
    // and populates the run-start body — proving per-request directives now flow.
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: Record<string, unknown>[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as Record<string, unknown>);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      {
        cookie: await cookie(userId),
        'Idempotency-Key': crypto.randomUUID(),
        'x-mock-classifier-resolution': 'a/model',
        'x-mock-failing-models': 'm1,m2',
      },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.['mockDirectives']).toEqual({
      classifierResolution: 'a/model',
      failingModels: ['m1', 'm2'],
    });
  });

  it('refuses a paid send past the per-user rate cap (429) and stays per-user', async () => {
    await seedModel();
    const limitedUser = await seedUser();
    // Pre-fill this user's 60s window to the cap; the next send is the 31st.
    await redis.set(`ratelimit:chat:stream:user:${hmacRateLimitId(limitedUser)}`, 30, { ex: 60 });
    const overLimit = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(limitedUser), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId: crypto.randomUUID(),
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hi' },
      }
    );
    expect(overLimit.status).toBe(429);
    expect(await overLimit.json()).toMatchObject({ code: 'RATE_LIMITED' });

    // A different user with a fresh window is unaffected — the limit is per-user.
    const freshUser = await seedUser();
    const conversationId = await seedConversation(freshUser, true);
    await seedPurchasedWallet(freshUser);
    const allowed = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(freshUser), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hi' },
      }
    );
    expect(allowed.status).toBe(201);
    await redis.del(`ratelimit:chat:stream:user:${hmacRateLimitId(limitedUser)}`);
    await redis.del(`ratelimit:chat:stream:user:${hmacRateLimitId(freshUser)}`);
  });

  it('refuses a multi-model send when any listed model is unknown with 400', async () => {
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
          { kind: 'model', id: `no/such-${crypto.randomUUID().slice(0, 8)}` },
        ],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a send onto a missing fork with 404', async () => {
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
        forkId: crypto.randomUUID(),
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(404);
  });

  it('threads the forkId into the run for a member sending onto an existing fork', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const forkId = await seedFork(conversationId);
    const captured: { forkId: string | undefined }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ forkId: body.mode === 'paid' ? body.forkId : undefined });
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        forkId,
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([{ forkId }]);
  });

  it('refuses an unknown model with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: 'no/such-model' }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('replays the settled turn response (200) instead of a transport error', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ outcome: 'replay', response: { runId: 'settled-run' } }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'settled-run' });
  });

  it('attaches a resend of a live run with the message ids that run was minted', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const liveUserMessageId = crypto.randomUUID();
    const liveAnswerId = crypto.randomUUID();
    const res = await post(
      fakeRealtime({
        outcome: 'attach',
        userMessageId: liveUserMessageId,
        assistantMessageIds: [liveAnswerId],
      }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: 'attach',
      userMessageId: liveUserMessageId,
      assistantMessageIds: [liveAnswerId],
    });
  });

  it('attaches with null message ids when the room holds no live run for the key', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ outcome: 'attach', userMessageId: null, assistantMessageIds: null }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: 'attach',
      userMessageId: null,
      assistantMessageIds: null,
    });
  });

  it('maps a reused key with a different body to 409', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'IDEMPOTENCY_BODY_MISMATCH' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });
});

describe('chat route: POST /chat resent after its run settled', () => {
  const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
    const rows = await tx
      .select({ key: epochs.epochPublicKey })
      .from(epochs)
      .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
    return rows[0]?.key ?? null;
  };

  /** The runtime the room composes, answering from the deterministic mock provider. */
  const runtime = createConversationRuntime({
    db,
    redis,
    telemetry: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      captureError: () => {},
    },
    apiKey: 'mock-key',
    searchApiKey: 'mock-key',
    isCI: false,
    mockProviderEnabled: true,
    chatStores: createChatStores(),
    // A text turn never reaches storage; a throwing proxy proves it.
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

  /** A funded member of a conversation wrapped to a real epoch key, so settlement can store. */
  async function seedPayer(): Promise<{ userId: string; conversationId: string }> {
    const userId = await seedUser();
    await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000_000n });
    const { conversationId, epochId } = await seedConversationWithEpoch(db, {
      userId,
      title: BYTES,
      epochPublicKey: generateEpochKeyPair().publicKey,
    });
    createdConversationIds.push(conversationId);
    // Settlement checks the sender's key (BYTES) against the epoch's wrap-set.
    await db
      .insert(epochMembers)
      .values({ epochId, memberPublicKey: BYTES, wrap: BYTES, visibleFromEpoch: 1 });
    await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
    return { userId, conversationId };
  }

  /**
   * Starts a run the way the room does: the referee claims the key, a settled
   * key replays its stored response, and a fresh one runs through settlement.
   */
  async function startInRoom(conversationId: string, body: RunStartBody): Promise<RunStartOutcome> {
    if (body.mode !== 'paid') throw new Error('expected a paid run-start body');
    const identity: PaidRunIdentity = {
      mode: 'paid',
      payerUserId: body.userId,
      sender: body.sender,
      conversationId,
      walletId: body.walletId,
      epochNumber: body.epochNumber,
      userMessage: body.userMessage,
    };
    const runId = crypto.randomUUID();
    const claim = await runtime.claimRun({
      runKey: body.runKey,
      runId,
      bodyHash: body.bodyHash,
      identity,
    });
    if (claim.outcome === 'replay') return { outcome: 'replay', response: claim.response };
    if (claim.outcome !== 'executor') throw new Error(`unexpected claim: ${claim.outcome}`);
    const context: RunContext = { ...identity, runId, fence: claim.fence, mockDirectives: {} };
    const hooks = runtime.bindHooks(context, body.definition);
    const handle = runtime.executor.start({
      definition: body.definition,
      inputs: body.inputs,
      history: body.history,
      hooks,
      runKey: body.runKey,
      runId,
      mockDirectives: {},
      emit: () => {},
    });
    const outcome = await handle.done;
    if (outcome.outcome !== 'succeeded') throw new Error(`run did not settle: ${outcome.outcome}`);
    const admission = await handle.admitted;
    if (admission.admitted && admission.hold !== undefined)
      await runtime.releaseHold(admission.hold);
    return {
      started: true,
      runId,
      deadlineAt: Date.now(),
      assistantMessageIds: hooks.assistantMessageIds,
    };
  }

  function roomRealtime(): RealtimeBroadcast {
    return fakeRealtime(STARTED, {
      startRun: (conversationId, body) =>
        fromPromise(startInRoom(conversationId, body), (cause) =>
          unavailableError('room run failed', cause)
        ),
    });
  }

  it('replays the user message id its run-start response returned', async () => {
    await seedModel();
    const payer = await seedPayer();
    const realtime = roomRealtime();
    const headers = { cookie: await cookie(payer.userId), 'Idempotency-Key': crypto.randomUUID() };
    const body = {
      conversationId: payer.conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'hello' },
    };

    const started = await post(realtime, headers, body);
    expect(started.status).toBe(201);
    const { userMessageId } = await started.json<{ userMessageId: unknown }>();
    expect(userMessageId).toEqual(expect.stringMatching(UUID_PATTERN));
    const storedUserRows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.conversationId, payer.conversationId), eq(messages.senderType, 'user'))
      );
    expect(storedUserRows).toEqual([{ id: userMessageId }]);

    const replayed = await post(realtime, headers, body);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ userMessageId });
  });

  it('stores the answer under the id its run-start response returned, and replays that id', async () => {
    await seedModel();
    const payer = await seedPayer();
    const realtime = roomRealtime();
    const headers = { cookie: await cookie(payer.userId), 'Idempotency-Key': crypto.randomUUID() };
    const body = {
      conversationId: payer.conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'hello' },
    };

    const started = await post(realtime, headers, body);
    expect(started.status).toBe(201);
    const { assistantMessageIds } = await started.json<{ assistantMessageIds: unknown }>();
    expect(assistantMessageIds).toEqual([expect.stringMatching(UUID_PATTERN)]);
    const storedAnswers = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.conversationId, payer.conversationId), eq(messages.senderType, 'assistant'))
      );
    expect(storedAnswers.map((row) => row.id)).toEqual(assistantMessageIds);

    const replayed = await post(realtime, headers, body);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ assistantMessageIds });
  });
});
