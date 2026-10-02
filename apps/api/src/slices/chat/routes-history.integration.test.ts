// Client-supplied history threading across the send, regenerate and trial seams, and
// what it contributes to the dedup body hash.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildTurnSystemPrompt,
  historyCharacterCount,
  promptCharacterCount,
  serializeSegments,
  stripReplayHistory,
  utcDayKey,
} from '@hushbox/shared';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { okAsync } from '../../lib/result/index.js';
import { CHAT_CLASSIFIER_INPUT } from './domain/index.js';
import { prepareStartRequest } from './domain/runtime.js';
import { promptInputTokensFor } from './domain/turn/definition.js';
import {
  MODEL,
  STARTED,
  cookie,
  fakeRealtime,
  pinTrialCatalogBaseline,
  post,
  postRegenerate,
  postTrial,
  seedConversation,
  seedGateModel,
  seedInheritedCatalogRows,
  seedMessage,
  seedModel,
  seedPurchasedWallet,
  seedUser,
  trialHeaders,
  withDearTrialCatalog,
} from '../../test-support/chat-routes.integration.setup.js';
import type { HeldStartRequest } from './domain/runtime.js';
import type { RealtimeBroadcast } from '../conversations/index.js';

describe('chat routes: client-supplied history threading', () => {
  // Cheap text rows standing in for what an earlier test file leaves in this
  // worker slot's catalog — the pool the trial premium percentile is taken over.
  beforeAll(seedInheritedCatalogRows);

  const HISTORY = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];

  interface CapturedRun {
    readonly history: unknown;
    readonly bodyHash: string;
  }

  /** Records every run body the routes hand to the (faked) conversation room. */
  function capturingRealtime(runs: CapturedRun[]): RealtimeBroadcast {
    return fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        runs.push({ history: body.history, bodyHash: body.bodyHash });
        return okAsync(STARTED);
      },
    });
  }

  it('round-trips history from a paid send into the run body', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const runs: CapturedRun[] = [];
    const res = await post(
      capturingRealtime(runs),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'and now?' },
        history: HISTORY,
      }
    );
    expect(res.status).toBe(201);
    expect(runs[0]?.history).toEqual(HISTORY);
  });

  it('round-trips history from a regenerate into the run body', async () => {
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
    const runs: CapturedRun[] = [];
    const res = await postRegenerate(
      capturingRealtime(runs),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
        history: HISTORY,
      }
    );
    expect(res.status).toBe(201);
    expect(runs[0]?.history).toEqual(HISTORY);
  });

  it('round-trips history from a trial send into the run body', async () => {
    // Pinned rather than seeded onto whatever the slot holds: this verdict is
    // taken over the whole exposed text pool, so inherited cheap rows sink the
    // percentile onto one of themselves and the send is refused as premium.
    await pinTrialCatalogBaseline();
    const runs: CapturedRun[] = [];
    const res = await postTrial(capturingRealtime(runs), trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'and now?',
      history: HISTORY,
    });
    expect(res.status).toBe(201);
    expect(runs[0]?.history).toEqual(HISTORY);
  });

  it('hashes an absent history identically to an empty one (no spurious body-mismatch 409)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const userMessage = { content: 'same turn' };
    const runs: CapturedRun[] = [];
    const realtime = capturingRealtime(runs);
    const absent = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, turnSources: [{ kind: 'model', id: MODEL }], userMessage }
    );
    const empty = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, turnSources: [{ kind: 'model', id: MODEL }], userMessage, history: [] }
    );
    expect(absent.status).toBe(201);
    expect(empty.status).toBe(201);
    expect(runs[1]?.bodyHash).toBe(runs[0]?.bodyHash);
  });

  it('hashes a different history to a different body (drives the referee body-mismatch 409)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const userMessage = { content: 'same turn' };
    const runs: CapturedRun[] = [];
    const realtime = capturingRealtime(runs);
    const first = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, turnSources: [{ kind: 'model', id: MODEL }], userMessage, history: HISTORY }
    );
    const second = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage,
        history: [{ role: 'user', content: 'a different past' }],
      }
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(runs[1]?.bodyHash).not.toBe(runs[0]?.bodyHash);
  });

  it('blocks a trial send whose history pushes the message past 1¢ with 402', async () => {
    const dearId = `chat-route-dear/${crypto.randomUUID().slice(0, 8)}`;
    // The dear model is eligible on the model legs, and the prompt alone is
    // affordable — the resent history is what makes this send cost more than 1¢.
    // Its refusal class is percentile-dependent, so pin a deterministic catalog.
    const res = await withDearTrialCatalog(dearId, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: dearId }],
        prompt: 'hi',
        history: [
          { role: 'user', content: 'x'.repeat(18_750) },
          { role: 'assistant', content: 'y'.repeat(18_750) },
        ],
      })
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  // ---------------------------------------------------------------------
  // Resent assistant turns may carry the model's reasoning as a segment of the
  // stored message. The route is the single seam that strips it, which is
  // what makes the counted prompt, the classified prompt and the sent prompt
  // one and the same bytes.
  // ---------------------------------------------------------------------

  const REASONING = 'chain of thought that the model must never be fed back';
  const ANSWER = 'first answer';
  const REASONING_HISTORY = [
    { role: 'user', content: 'first question' },
    {
      role: 'assistant',
      content: serializeSegments([
        { kind: 'reasoning', children: [{ kind: 'text', text: REASONING }] },
        { kind: 'text', text: ANSWER },
      ]),
    },
  ];
  /** The same conversation as `REASONING_HISTORY`, already trimmed by the client. */
  const STRIPPED_HISTORY = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: ANSWER },
  ];

  interface CapturedTurn {
    readonly history: readonly { readonly role: string; readonly content: string }[];
    readonly bodyHash: string;
    readonly inputs: Record<string, { readonly text?: string }>;
    /** The stamped storage basis: the new user message's own length. */
    readonly inputChars: number | undefined;
    /** The stamped input-token estimate, taken over the whole assembled prompt. */
    readonly promptInputTokens: number | undefined;
  }

  /** Records the whole run body each route hands the (faked) conversation room. */
  function capturingTurns(turns: CapturedTurn[]): RealtimeBroadcast {
    return fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        turns.push({
          history: body.history,
          bodyHash: body.bodyHash,
          inputs: body.inputs as Record<string, { readonly text?: string }>,
          inputChars: body.definition.storage?.inputChars,
          promptInputTokens: body.definition.nodes.find(
            (node): node is typeof node & { readonly promptInputTokens?: number } =>
              node.type === 'modelCall'
          )?.promptInputTokens,
        });
        return okAsync(STARTED);
      },
    });
  }

  it('keeps embedded reasoning out of the classifier excerpt', async () => {
    // An `auto` effort turn on a laddered model is the cheapest send that
    // compiles a classifier, whose excerpt is built route-side from the last
    // assistant turn.
    const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(model, {
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 1_000_000 },
    });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const turns: CapturedTurn[] = [];
    const res = await post(
      capturingTurns(turns),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: model }],
        reasoningEffort: 'auto',
        userMessage: { content: 'and now?' },
        history: REASONING_HISTORY,
      }
    );
    expect(res.status).toBe(201);
    const excerpt = turns[0]?.inputs[CHAT_CLASSIFIER_INPUT]?.text;
    expect(excerpt).toContain(ANSWER);
    expect(excerpt).not.toContain(REASONING);
  });

  it('hands the run body a history stripped of embedded reasoning (paid send)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const turns: CapturedTurn[] = [];
    const res = await post(
      capturingTurns(turns),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'and now?' },
        history: REASONING_HISTORY,
      }
    );
    expect(res.status).toBe(201);
    expect(turns[0]?.history).toEqual(STRIPPED_HISTORY);
  });

  it('hands the run body a history stripped of embedded reasoning (regenerate)', async () => {
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
    const turns: CapturedTurn[] = [];
    const res = await postRegenerate(
      capturingTurns(turns),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
        history: REASONING_HISTORY,
      }
    );
    expect(res.status).toBe(201);
    expect(turns[0]?.history).toEqual(STRIPPED_HISTORY);
  });

  it('hands the run body a history stripped of embedded reasoning (trial send)', async () => {
    await pinTrialCatalogBaseline();
    const turns: CapturedTurn[] = [];
    const res = await postTrial(capturingTurns(turns), trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'and now?',
      history: REASONING_HISTORY,
    });
    expect(res.status).toBe(201);
    expect(turns[0]?.history).toEqual(STRIPPED_HISTORY);
  });

  it('hashes a reasoning-bearing history identically to its stripped equivalent', async () => {
    // A client that trims before sending and one that does not are posting the
    // same turn, so the dedup referee must not see two different bodies.
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const userMessage = { content: 'same turn' };
    const turns: CapturedTurn[] = [];
    const realtime = capturingTurns(turns);
    const raw = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage,
        history: REASONING_HISTORY,
      }
    );
    const trimmed = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage,
        history: STRIPPED_HISTORY,
      }
    );
    expect(raw.status).toBe(201);
    expect(trimmed.status).toBe(201);
    expect(turns[1]?.bodyHash).toBe(turns[0]?.bodyHash);
  });

  it('hashes a history with a search nested in reasoning identically to its stripped equivalent', async () => {
    // The whole reasoning span goes, with every row nested in it, so this turn
    // hashes as its own stripped form rather than hashing the same turn two ways.
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const userMessage = { content: 'same turn' };
    const nestedSearch = [
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        content: serializeSegments([
          {
            kind: 'reasoning',
            children: [
              { kind: 'text', text: REASONING },
              {
                kind: 'webSearch',
                row: {
                  v: 1,
                  searches: [
                    {
                      query: 'a query',
                      status: 'done',
                      sources: [{ title: 'A page', url: 'https://a.example/' }],
                    },
                  ],
                  notRun: { limit: 0, invalidQuery: 0 },
                },
              },
            ],
          },
          { kind: 'text', text: ANSWER },
        ]),
      },
    ];
    const turns: CapturedTurn[] = [];
    const realtime = capturingTurns(turns);
    const nested = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage,
        history: nestedSearch,
      }
    );
    const trimmed = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage,
        history: STRIPPED_HISTORY,
      }
    );
    expect(nested.status).toBe(201);
    expect(trimmed.status).toBe(201);
    expect(turns[0]?.history).toEqual(STRIPPED_HISTORY);
    expect(turns[1]?.bodyHash).toBe(turns[0]?.bodyHash);
  });

  it('hashes and forwards a model-authored framed answer identically whether cleaned once or twice', async () => {
    // The answer text is itself a serialized message, so it begins with the
    // frame marker. The client cleans history before sending it and the route
    // cleans it again; both paths must reach the same bytes.
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const userMessage = { content: 'same turn' };
    const authored = serializeSegments([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'reasoning-looking text' }] },
      { kind: 'text', text: 'visible' },
    ]);
    const raw = [
      { role: 'user' as const, content: 'first question' },
      {
        role: 'assistant' as const,
        content: serializeSegments([
          { kind: 'reasoning', children: [{ kind: 'text', text: REASONING }] },
          { kind: 'text', text: authored },
        ]),
      },
    ];
    const clientCleaned = [...stripReplayHistory(raw)];
    const turns: CapturedTurn[] = [];
    const realtime = capturingTurns(turns);
    const once = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, turnSources: [{ kind: 'model', id: MODEL }], userMessage, history: raw }
    );
    const twice = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage,
        history: clientCleaned,
      }
    );
    expect(once.status).toBe(201);
    expect(twice.status).toBe(201);
    expect(turns[0]?.history).toEqual(clientCleaned);
    expect(turns[1]?.history).toEqual(clientCleaned);
    expect(turns[1]?.bodyHash).toBe(turns[0]?.bodyHash);
    expect(JSON.stringify(turns[0]?.history)).not.toContain(REASONING);
  });

  it('prices the prompt the run actually sends, from a reasoning-bearing history', async () => {
    // The definition carries the two counts the turn is priced from, and each
    // is checked against what the run will really do with it. The bytes that
    // reach the provider are the run body's history carried through the start
    // path (`prepareStartRequest`) and mapped verbatim onto the wire by the
    // language adapter, which its own parity test pins — so counting the
    // prepared history closes the loop from the priced input leg to the send.
    // The storage basis closes a different loop: it is the one row this turn
    // will persist, so it is the new message and nothing the history carries.
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const prompt = 'and now?';
    const turns: CapturedTurn[] = [];
    const res = await post(
      capturingTurns(turns),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: prompt },
        history: REASONING_HISTORY,
      }
    );
    expect(res.status).toBe(201);
    const captured = turns[0];
    if (captured === undefined) throw new Error('expected a captured run body');
    const prepared = await prepareStartRequest({
      history: captured.history,
      hooks: {},
    } as unknown as HeldStartRequest);
    const sent = promptCharacterCount({
      // The rendered date line is fixed-width, so the count is clock-independent.
      systemPrompt: buildTurnSystemPrompt({ utcDay: utcDayKey(new Date(TEST_DAY_START)) }),
      historyCharacters: historyCharacterCount(prepared.history ?? []),
      prompt,
    });
    // The provider leg is priced over every character the run sends.
    expect(captured.promptInputTokens).toBe(
      promptInputTokensFor({
        promptCharacterCount: sent,
        inputCharacterCount: prompt.length,
        funding: { kind: 'purchased', spendableNanoUsd: 1n },
      })
    );
    // The same leg priced over the history the client POSTED. `sent` is counted
    // over the run body's own history, so on its own that equality holds for
    // whatever the route put there — including an unstripped copy of the post.
    // The posted array is longer by the reasoning the route removes, so pricing
    // it lands elsewhere, and that is what makes the equality above a claim
    // about the prompt the run assembled rather than about one array twice.
    const posted = promptCharacterCount({
      systemPrompt: buildTurnSystemPrompt({ utcDay: utcDayKey(new Date(TEST_DAY_START)) }),
      historyCharacters: historyCharacterCount(REASONING_HISTORY),
      prompt,
    });
    expect(captured.promptInputTokens).not.toBe(
      promptInputTokensFor({
        promptCharacterCount: posted,
        inputCharacterCount: prompt.length,
        funding: { kind: 'purchased', spendableNanoUsd: 1n },
      })
    );
    // The storage leg is priced over the one message the run will store, which
    // the resent history cannot inflate.
    expect(captured.inputChars).toBe(prompt.length);
    expect(sent).toBeGreaterThan(prompt.length);
  });

  it('admits a trial send whose short history stays within the 1¢ cap', async () => {
    // The known-eligible cheap model: a short history adds a handful of input
    // tokens, nowhere near the cap (the exact price boundary is unit-tested on
    // trialMessageBillableNanoUsd).
    await pinTrialCatalogBaseline();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      turnSources: [{ kind: 'model', id: MODEL }],
      prompt: 'hi',
      history: [{ role: 'user', content: 'short past' }],
    });
    expect(res.status).toBe(201);
  });
});
