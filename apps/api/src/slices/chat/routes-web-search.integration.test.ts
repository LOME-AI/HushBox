// Web-search threading on both the send and the regenerate seam. Both suites mint
// fixtures under the shared `chat-route-search` prefix and the sweep below deletes
// every row carrying it.
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { modelCatalog } from '@hushbox/db';
import { ResolvedReasoningEffort } from '@hushbox/shared';
import { toolCallCapFor, toolLoopStepsFor } from '@hushbox/shared/affordability';
import { okAsync } from '../../lib/result/index.js';
import {
  MODEL,
  STARTED,
  WEB_SEARCH_MODEL_PREFIX,
  cookie,
  db,
  fakeRealtime,
  post,
  postRegenerate,
  seedConversation,
  seedGateModel,
  seedMessage,
  seedModel,
  seedPurchasedWallet,
  seedToolCapableModelId,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';
import { CHAT_CLASSIFIER_NODE_ID } from './domain/turn/classifier.js';
import type { WorkflowDefinition } from '@hushbox/shared';

// Clear any web-search fixture left by a retried earlier attempt of this file that
// was killed before its `finally` ran — the slot database outlives a watch re-run —
// so the trial premium-price percentile never sees a stale cheap decoy.
beforeAll(async () => {
  await db.delete(modelCatalog).where(like(modelCatalog.modelId, `${WEB_SEARCH_MODEL_PREFIX}%`));
});

/**
 * A tool-capable model that also offers a real effort ladder — what an automatic
 * effort turn needs, since the classifier is only bought when the turn presents
 * two or more rungs. Ingestion mints `tools` from the gateway's supported
 * parameters; the fixture states the minted behaviors directly because the
 * laddered seed is the one that takes descriptor overrides.
 */
async function seedAutoEffortSearchModel(modelId: string): Promise<void> {
  await seedGateModel(modelId, {
    behaviors: ['streaming', 'tools'],
    reasoning: { supportedEfforts: null },
    limits: { contextLength: 1_000_000 },
  });
}

/** The call cap of each rung an answer node carries its own ceiling for. */
function rungCallCaps(answer: WorkflowDefinition['nodes'][number] | undefined): readonly number[] {
  const rungs = answer?.type === 'modelCall' ? (answer.rungCeilings ?? {}) : {};
  return ResolvedReasoningEffort.options
    .filter((rung) => rung in rungs)
    .map((rung) => toolCallCapFor(rung));
}

/** The definition a 201 automatic-effort web-search send hands the room. */
async function captureAutoEffortSearchSend(model: string): Promise<WorkflowDefinition> {
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
  const definition = captured[0];
  if (definition === undefined) throw new Error('expected a captured definition');
  return definition;
}

describe('chat route: POST /chat', () => {
  it('threads web search onto the answer node for a tool-capable model (201)', async () => {
    const model = `${WEB_SEARCH_MODEL_PREFIX}/${crypto.randomUUID().slice(0, 8)}`;
    await seedToolCapableModelId(model);
    try {
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
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(201);
      const definition = captured[0];
      if (definition === undefined) throw new Error('expected a captured definition');
      const answer = definition.nodes.find((node) => node.type === 'modelCall');
      expect(answer?.type === 'modelCall' && answer.tools).toEqual(['webSearch']);
      // The model has no reasoning ladder, so the loop is the ceiling's.
      expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(
        toolLoopStepsFor(toolCallCapFor())
      );
    } finally {
      // Drop the seeded model so it never shifts the suite-shared catalog's
      // trial premium-price quartile for later trial tests.
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
    }
  });

  it('classifies the effort on an automatic-effort search send, keeping the tool (201)', async () => {
    const model = `${WEB_SEARCH_MODEL_PREFIX}/${crypto.randomUUID().slice(0, 8)}`;
    await seedAutoEffortSearchModel(model);
    try {
      const definition = await captureAutoEffortSearchSend(model);
      const classifier = definition.nodes.find((node) => node.id === CHAT_CLASSIFIER_NODE_ID);
      expect(classifier?.type).toBe('modelCall');
      const answer = definition.nodes.find(
        (node) => node.type === 'modelCall' && node.id !== CHAT_CLASSIFIER_NODE_ID
      );
      expect(answer?.type === 'modelCall' && answer.tools).toEqual(['webSearch']);
      // An auto turn declares the loop of the highest rung its menu funds: the
      // longest loop among the rungs the answer carries its own ceiling for.
      const caps = rungCallCaps(answer);
      expect(caps.length).toBeGreaterThan(1);
      expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(
        toolLoopStepsFor(Math.max(...caps))
      );
      // The answer searches and the classifier does not: the estimator adds the
      // reservation off each call's own tools, so arming the classifier would
      // reserve the allowance twice for one turn.
      expect(classifier?.type === 'modelCall' && classifier.tools).toEqual([]);
    } finally {
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
    }
  });

  it('refuses web search on a tool-incapable model with 400', async () => {
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
        webSearchEnabled: true,
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('chat route: POST /chat/regenerate', () => {
  it('threads web search onto the answer node for a tool-capable regenerate (201)', async () => {
    const model = `${WEB_SEARCH_MODEL_PREFIX}/${crypto.randomUUID().slice(0, 8)}`;
    await seedToolCapableModelId(model);
    try {
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
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(201);
      const definition = captured[0];
      if (definition === undefined) throw new Error('expected a captured definition');
      const answer = definition.nodes.find((node) => node.type === 'modelCall');
      expect(answer?.type === 'modelCall' && answer.tools).toEqual(['webSearch']);
      // The model has no reasoning ladder, so the loop is the ceiling's.
      expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(
        toolLoopStepsFor(toolCallCapFor())
      );
    } finally {
      // Drop the seeded model so it never shifts the suite-shared catalog's
      // trial premium-price quartile for later trial tests.
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
    }
  });
});
