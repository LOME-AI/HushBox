// POST /chat/regenerate's turn construction: fan-out over a model list, media and
// reasoning wires, Smart Model, and what enters the dedup body hash.
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { conversationForks, wallets } from '@hushbox/db';
import { ResolvedReasoningEffort, SMART_MODEL_ID, isTurnClassifierNode } from '@hushbox/shared';
import { toolCallCapFor, toolLoopStepsFor } from '@hushbox/shared/affordability';
import { okAsync } from '../../lib/result/index.js';
import { hmacRateLimitId } from '../../lib/rate-limit/index.js';
import { CHAT_TURN_NODE_ID, hashRequestBody, storesNewUserMessage } from './domain/index.js';
import {
  MODEL,
  MODEL_B,
  MODEL_C,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  postRegenerate,
  redis,
  seedConversation,
  seedFork,
  seedGateModel,
  seedImageGateModel,
  seedMessage,
  seedModel,
  seedModelId,
  seedPurchasedWallet,
  seedUser,
  seedVideoGateModel,
} from '../../test-support/chat-routes.integration.setup.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime';
import type { RealtimeBroadcast } from '../conversations/index.js';

describe('chat route: POST /chat/regenerate', () => {
  /** A retry's resent prompt: fed to the model, stored nowhere new. */
  const RESENT_PROMPT = 'what did you mean by that?';
  /** An edit's replacement prompt: a new user message row, so it IS stored. */
  const EDITED_PROMPT = 'what did you mean, precisely?';

  it('refuses a regenerate whose target is not in the conversation with 404', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: crypto.randomUUID(),
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(404);
  });

  it('refuses a regenerate from a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, false);
    await seedPurchasedWallet(userId);
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: crypto.randomUUID(),
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(403);
  });

  it('rejects a regenerate naming an unknown model with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: `unknown/${crypto.randomUUID().slice(0, 8)}` }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a regenerate past the per-user rate cap (429)', async () => {
    const userId = await seedUser();
    // Pre-fill the shared per-user window to the cap; the next send is the 31st.
    await redis.set(`ratelimit:chat:stream:user:${hmacRateLimitId(userId)}`, 30, { ex: 60 });
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId: crypto.randomUUID(),
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: crypto.randomUUID(),
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' });
    await redis.del(`ratelimit:chat:stream:user:${hmacRateLimitId(userId)}`);
  });

  it('fans out a regenerate over a multi-model list (201)', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    await seedModelId(MODEL_C);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: MODEL },
          { kind: 'model', id: MODEL_B },
          { kind: 'model', id: MODEL_C },
        ],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings.map((node) => node.model)).toEqual([MODEL, MODEL_B, MODEL_C]);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
    }
  });

  it('caps a multi-model regenerate at the payer-budget output ceiling', async () => {
    // A big-context model so the shared ceiling is BUDGET-derived (not context-
    // capped), proving the payer budget feeds the multi-model regenerate turn —
    // the path that silently lost its ceiling when the options argument bound to
    // a bare boolean. Money-adjacent: the ceiling feeds the admission hold.
    const bigA = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const bigB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(bigA, { limits: { contextLength: 1_000_000 } });
    await seedGateModel(bigB, { limits: { contextLength: 1_000_000 } });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: bigA },
          { kind: 'model', id: bigB },
        ],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings).toHaveLength(2);
    const ceilings = siblings.map((node) => node.params['maxOutputTokens']);
    for (const ceiling of ceilings) {
      // Present and positive: before the fix, options bound to `false`, dropping
      // the budget, so no maxOutputTokens param was written at all.
      expect(typeof ceiling).toBe('number');
      expect(ceiling as number).toBeGreaterThan(0);
      expect(ceiling as number).toBeLessThan(1_000_000);
    }
    // The siblings share one ceiling (the multi-model turn's single budget).
    expect(ceilings[0]).toBe(ceilings[1]);

    // What makes the ceiling the PAYER-BUDGET one rather than the physical one:
    // a thinner wallet buys fewer answer tokens off the same models and the same
    // prompt. A money-free bound (context length minus prompt) is identical for
    // both payers, so only this comparison separates the two derivations.
    const poorId = await seedUser();
    const poorConversationId = await seedConversation(poorId, true);
    await db.insert(wallets).values({
      userId: poorId,
      type: 'purchased',
      balanceNanoUsd: 100_000n,
    });
    const poorAnchor = await seedMessage(poorConversationId, {
      senderType: 'user',
      senderId: poorId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    await postRegenerate(
      realtime,
      { cookie: await cookie(poorId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId: poorConversationId,
        turnSources: [
          { kind: 'model', id: bigA },
          { kind: 'model', id: bigB },
        ],
        targetMessageId: poorAnchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    const poorCeiling = captured[1]?.nodes.find((node) => node.type === 'modelCall')?.params[
      'maxOutputTokens'
    ];
    expect(typeof poorCeiling).toBe('number');
    expect(poorCeiling as number).toBeGreaterThan(0);
    expect(poorCeiling as number).toBeLessThan(ceilings[0] as number);
  });

  it('includes the models list in the regenerate body hash', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    await seedModelId(MODEL_C);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const hashes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        hashes.push(body.bodyHash);
        return okAsync(STARTED);
      },
    });
    // Two regenerates identical but for the models list — different bodyHashes
    // prove the list feeds the dedup hash (so a multi-model retry never replays a
    // single-model run and vice versa).
    const userMessage = { content: 'again' };
    const shared = {
      conversationId,
      targetMessageId: anchor,
      action: 'retry',
    } as const;
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        ...shared,
        turnSources: [
          { kind: 'model', id: MODEL },
          { kind: 'model', id: MODEL_B },
        ],
        userMessage,
      }
    );
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        ...shared,
        turnSources: [
          { kind: 'model', id: MODEL },
          { kind: 'model', id: MODEL_C },
        ],
        userMessage,
      }
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('routes a one-source regenerate through the SINGLE-model build (201)', async () => {
    // Send and regenerate resolve one shape: a regenerate naming one model takes
    // the same single-model compile the send that produced it took, so the node
    // is the mandatory single answer rather than an optional fan-out sibling.
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings.map((node) => node.model)).toEqual([MODEL]);
    expect(siblings[0]?.id).toBe(CHAT_TURN_NODE_ID);
    expect(siblings[0]?.type === 'modelCall' && siblings[0].optional).toBe(false);
  });

  it('reserves no prompt storage for a retry, which stores no user message', async () => {
    // A retry re-runs against the anchor the original turn already stored and
    // charged: the resent prompt rests nowhere new, so the admission hold must
    // carry no input-storage term for it. The provider leg is a different
    // question and is unchanged — the model still receives every character.
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: RESENT_PROMPT },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    // The stamp is still present, carrying no new message: it is what makes the
    // hold reserve the ANSWER's output storage, which a retry does persist.
    expect(definition.storage).toEqual({ inputChars: 0 });
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' ? answer.promptInputTokens : 0).toBeGreaterThan(0);
  });

  it('reserves the prompt storage an edit will store, over its replacement message', async () => {
    // The distinction is retry versus edit, not regenerate versus send: an edit
    // inserts a new user message row, so its storage is reserved as a send's is.
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'edit',
        userMessage: { content: EDITED_PROMPT },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    expect(definition.storage?.inputChars).toBe(EDITED_PROMPT.length);
  });

  /** A seeded conversation whose one user message is the regenerate's anchor. */
  async function seedAnchor(): Promise<{ userId: string; conversationId: string; anchor: string }> {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    return { userId, conversationId, anchor };
  }

  /** A realtime double that records every run body it is handed. */
  function capturingRealtime(): { starts: RunStartBody[]; realtime: RealtimeBroadcast } {
    const starts: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        starts.push(body);
        return okAsync(STARTED);
      },
    });
    return { starts, realtime };
  }

  it('refuses an edit whose replacement message carries an id with 400', async () => {
    const { userId, conversationId, anchor } = await seedAnchor();
    const { starts, realtime } = capturingRealtime();
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'edit',
        userMessage: { id: crypto.randomUUID(), content: EDITED_PROMPT },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
    expect(starts).toEqual([]);
  });

  it("hands the room an edit's minted replacement id, the one its run-start response returns", async () => {
    const { userId, conversationId, anchor } = await seedAnchor();
    const { starts, realtime } = capturingRealtime();
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'edit',
        userMessage: { content: EDITED_PROMPT },
      }
    );
    expect(res.status).toBe(201);
    const { userMessageId } = await res.json<{ userMessageId: unknown }>();
    expect(typeof userMessageId).toBe('string');
    expect(userMessageId).not.toBe(anchor);
    const handed = starts[0];
    expect(handed?.mode === 'paid' ? handed.userMessage.id : undefined).toBe(userMessageId);
  });

  it("returns a retry's anchor as its user message id, and hands the room the same", async () => {
    const { userId, conversationId, anchor } = await seedAnchor();
    const { starts, realtime } = capturingRealtime();
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: RESENT_PROMPT },
      }
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userMessageId: anchor });
    const handed = starts[0];
    expect(handed?.mode === 'paid' ? handed.userMessage.id : undefined).toBe(anchor);
  });

  it('reserves exactly the characters settlement will charge storage over', async () => {
    // Observes the RESERVE side only: the charge basis is recomputed here from the same
    // predicate, so this goes red when the ROUTE stops asking `storesNewUserMessage`, not
    // when settlement does — that side is pinned by the retry and edit prompt-storage cases
    // in `apps/api/src/slices/chat/domain/settlement/settlement.integration.test.ts`.
    await seedModelId(MODEL);
    for (const action of ['retry', 'edit'] as const) {
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const anchor = await seedMessage(conversationId, {
        senderType: 'user',
        senderId: userId,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      const captured: WorkflowDefinition[] = [];
      const realtime = fakeRealtime(STARTED, {
        startRun: (_conversationId, body) => {
          captured.push(body.definition);
          return okAsync(STARTED);
        },
      });
      const content = RESENT_PROMPT;
      const res = await postRegenerate(
        realtime,
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          targetMessageId: anchor,
          action,
          userMessage: { content },
        }
      );
      expect(res.status).toBe(201);
      const definition = captured[0];
      if (definition === undefined) throw new Error('expected a captured definition');
      // Settlement's own basis, written as settlement writes it.
      const charged = storesNewUserMessage({ action }) ? content.length : 0;
      expect(definition.storage?.inputChars).toBe(charged);
    }
  });

  it('includes custom instructions in the regenerate body hash', async () => {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const hashes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        hashes.push(body.bodyHash);
        return okAsync(STARTED);
      },
    });
    // Two regenerates identical but for the custom instructions — different
    // bodyHashes prove the instructions scope the dedup (they change the answer,
    // so a retry with new instructions must not replay the prior run).
    const userMessage = { content: 'again' };
    const shared = {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      targetMessageId: anchor,
      action: 'retry',
    } as const;
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, customInstructions: 'answer in French', userMessage }
    );
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, userMessage }
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('threads reasoningEffort onto the regenerated answer node (201)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        targetMessageId: anchor,
        action: 'retry',
        reasoningEffort: 'low',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('expected a captured answer node');
    expect(answer.params['reasoning']).toEqual({ effort: 'low' });
  });

  it('refuses an explicit reasoning level on a non-reasoning-model regenerate with 400', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        reasoningEffort: 'medium',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('pins an explicit reasoning level onto the Smart Model regenerate node (201)', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        targetMessageId: anchor,
        action: 'retry',
        reasoningEffort: 'high',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const node = captured[0]?.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    // `pinnedEffort` is where a sender's level rides on this node — the execution
    // applies it to whichever candidate the model axis binds. Status alone left
    // the level unpinned: a dropped level still answers 201.
    expect(node.pinnedEffort).toBe('high');
  });

  it('builds an automatic-effort regenerate as a single-candidate effort classifier node (201)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        targetMessageId: anchor,
        action: 'retry',
        reasoningEffort: 'auto',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const node = captured[0]?.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a captured smartModel node');
    // A regenerate resolves `auto` exactly as the send that produced it did:
    // the re-run's own model is the only candidate, so nothing routes and only
    // the effort dimension is asked.
    expect(node.candidates.map((candidate) => candidate.id)).toEqual([model]);
    expect(node.classify).toEqual({ model: false, effort: true });
  });

  it('classifies a searching automatic-effort regenerate beside a tool-carrying answer (201)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      behaviors: ['streaming', 'tools'],
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        webSearchEnabled: true,
        targetMessageId: anchor,
        action: 'retry',
        reasoningEffort: 'auto',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const nodes = captured[0]?.nodes ?? [];
    // The composite node carries no tool loop, so a searching `auto` regenerate
    // takes the fan-out compile instead — the same routing the send path takes.
    expect(nodes.some((node) => node.type === 'smartModel')).toBe(false);
    const calls = nodes.filter((node) => node.type === 'modelCall');
    // ONE classifier for the turn. A turn that never classified would carry the
    // tool on its sole call too, so the tool claim below only says the search
    // survived classification while this holds.
    expect(calls.filter((node) => isTurnClassifierNode(node, nodes))).toHaveLength(1);
    const answer = calls.find((node) => !isTurnClassifierNode(node, nodes));
    if (answer?.type !== 'modelCall') throw new Error('expected a captured modelCall node');
    // The fan-out's one-model collapse keeps the answer under the id settlement
    // expects, so routing a regenerate through it changes no persisted shape.
    expect(answer.id).toBe(CHAT_TURN_NODE_ID);
    expect(answer.tools).toEqual(['webSearch']);
    // An auto turn declares the loop of the highest rung its menu funds: the
    // longest loop among the rungs the answer carries its own ceiling for.
    const rungs = answer.rungCeilings ?? {};
    const caps = ResolvedReasoningEffort.options
      .filter((rung) => rung in rungs)
      .map((rung) => toolCallCapFor(rung));
    expect(caps.length).toBeGreaterThan(1);
    expect(answer.maxSteps).toBe(toolLoopStepsFor(Math.max(...caps)));
  });

  it('scopes reasoningEffort into the regenerate dedup body hash (absent hashes the pre-feature shape)', async () => {
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const hashes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        hashes.push(body.bodyHash);
        return okAsync(STARTED);
      },
    });
    const userMessage = { content: 'again' };
    const shared = {
      conversationId,
      turnSources: [{ kind: 'model', id: model }],
      targetMessageId: anchor,
      action: 'retry',
    } as const;
    const absent = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, userMessage }
    );
    const engaged = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, userMessage, reasoningEffort: 'low' }
    );
    expect(absent.status).toBe(201);
    expect(engaged.status).toBe(201);
    // The effort is client intent that changes the answer, so it scopes the
    // dedup (same key + different effort drives the referee's body-mismatch
    // 409); an absent effort hashes exactly the pre-feature shape, so an old
    // client's retry never 409s against its own regenerate.
    expect(hashes[1]).not.toBe(hashes[0]);
    const regenerate = { action: 'retry', targetMessageId: anchor };
    expect(hashes[0]).toBe(
      hashRequestBody({
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        userMessage,
        regenerate,
        history: [],
      })
    );
    expect(hashes[1]).toBe(
      hashRequestBody({
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        reasoningEffort: 'low',
        userMessage,
        regenerate,
        history: [],
      })
    );
  });

  it('builds a media (image) regenerate carrying its config as node params (201)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: { definition: WorkflowDefinition; regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({
          definition: body.definition,
          regenerate: body.mode === 'paid' ? body.regenerate : undefined,
        });
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const first = captured[0];
    if (first === undefined) throw new Error('expected a captured run start');
    // The media-classed definition selects the whole media pipeline downstream
    // (pre-minted persistence plans, encrypt-and-store mappers, put barrier),
    // exactly like a media send; the regenerate identity rides alongside it.
    expect(first.definition.deadlineClass).toBe('media');
    const answer = first.definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.model).toBe(imageModel);
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ aspectRatio: '4:3' });
    expect(first.regenerate).toEqual({ action: 'retry', targetMessageId: anchor });
  });

  it('fans out a media regenerate over a multi-model list (201)', async () => {
    const imageA = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const imageB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageA);
    await seedImageGateModel(imageB);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: imageA },
          { kind: 'model', id: imageB },
        ],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    expect(definition.deadlineClass).toBe('media');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings.map((node) => node.model)).toEqual([imageA, imageB]);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
      expect(sibling.params).toEqual({ aspectRatio: '4:3' });
    }
  });

  it('builds a media (video) regenerate with its full config (201)', async () => {
    const videoModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedVideoGateModel(videoModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: videoModel }],
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'a drone shot' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.deadlineClass).toBe('media');
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({
      aspectRatio: '16:9',
      durationSeconds: 6,
      resolution: '720p',
    });
  });

  it('builds an image regenerate with empty params when no config is supplied (201)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({});
  });

  it('refuses a media regenerate over a text-only model with 400 (wrong modality)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        modality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MODALITY' });
  });

  /*
   * The mirror of the case above, in the other modality direction: a pinned
   * image model with NO `modality` field is a text regenerate over a descriptor
   * that produces no text. The regenerate route reaches the refusal through the
   * same shared model-resolution call a send does, so it inherits it — and
   * inheritance through a shared call site is not a pin. This case is what
   * holds the refusal on the regenerate money path if the gate is ever moved
   * into the `POST /chat` handler.
   */
  it('refuses a text regenerate over a pinned image model when the body asks for no modality (400)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const started: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        started.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MODALITY' });
    expect(started).toHaveLength(0);
  });

  it('includes the generation config in the regenerate body hash', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const hashes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        hashes.push(body.bodyHash);
        return okAsync(STARTED);
      },
    });
    // Two image regenerates identical but for the config — different bodyHashes
    // prove the generation config feeds the dedup hash (a re-run with a new
    // aspect ratio must never replay the old run's settled result).
    const userMessage = { content: 'a red cube' };
    const shared = {
      conversationId,
      turnSources: [{ kind: 'model', id: imageModel }],
      modality: 'image',
      targetMessageId: anchor,
      action: 'retry',
      userMessage,
    } as const;
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, imageConfig: { aspectRatio: '4:3' } }
    );
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, imageConfig: { aspectRatio: '1:1' } }
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('builds the classified smartModel definition for a smart-model regenerate (201)', async () => {
    // The regenerate resolves the sentinel through the SAME shared path as the
    // send — a Smart Model turn must be re-runnable, not refused as unknown.
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const node = definition.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    // Membership first: a fixture that stopped reaching the candidate pool names
    // the missing model here, rather than surfacing as an opaque node-type
    // mismatch on the shape assertion below.
    const candidateIds = node.candidates.map((candidate) => candidate.id);
    expect(candidateIds).toEqual(expect.arrayContaining([MODEL, MODEL_B]));
    expect(definition.nodes.map((one) => one.type)).toEqual(['modelCall', 'fanIn', 'smartModel']);
    expect(candidateIds).not.toContain(SMART_MODEL_ID);
  });

  // The contract matrix: every regenerate entry (retry/edit × linear/fork) must
  // resolve the smart-model sentinel without a VALIDATION refusal — the class
  // where one entrypoint misses the sentinel branch dies here.
  it.each([
    { action: 'retry' as const, onFork: false },
    { action: 'edit' as const, onFork: false },
    { action: 'retry' as const, onFork: true },
    { action: 'edit' as const, onFork: true },
  ])(
    'resolves the smart-model sentinel on a $action regenerate (fork: $onFork) with 201',
    async ({ action, onFork }) => {
      await seedModelId(MODEL);
      await seedModelId(MODEL_B);
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const forkId = onFork ? await seedFork(conversationId) : undefined;
      const anchor = await seedMessage(conversationId, {
        senderType: 'user',
        senderId: userId,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      if (forkId !== undefined) {
        await db
          .update(conversationForks)
          .set({ tipMessageId: anchor })
          .where(eq(conversationForks.id, forkId));
      }
      const res = await postRegenerate(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'smart' }],
          targetMessageId: anchor,
          action,
          ...(forkId === undefined ? {} : { forkId }),
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(201);
    }
  );
});
