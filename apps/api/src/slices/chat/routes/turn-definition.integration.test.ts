// The paid route's refusal of an automatic-effort turn whose own menu marks no
// effort rung available: 402 before a run is claimed, as the browser's send gate
// refuses the same turn.
import { describe, expect, it } from 'vitest';
import {
  cookie,
  post,
  recordingRealtime,
  seedConversation,
  seedGateModel,
  seedModel,
  seedPurchasedWallet,
  seedUser,
} from '../../../test-support/chat-routes.integration.setup.js';

/**
 * A model whose every rung is mandatory reasoning and whose provider cap holds no
 * rung's reasoning budget beside a minimum answer: it offers two rungs and the
 * funding can buy neither, at any balance.
 */
async function seedUnrunnableLadder(behaviors: readonly string[]): Promise<string> {
  const model = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
  await seedGateModel(model, {
    behaviors,
    reasoning: { mandatory: true, supportedEfforts: ['low', 'high'] },
    limits: { contextLength: 1_000_000, maxOutputTokens: 1500 },
  });
  return model;
}

/** An automatic-effort send of `models`, returning its response and the run starts it made. */
async function autoSend(
  models: readonly string[],
  webSearchEnabled: boolean
): Promise<{ readonly res: Response; readonly starts: readonly number[] }> {
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
      turnSources: models.map((id) => ({ kind: 'model', id })),
      webSearchEnabled,
      reasoningEffort: 'auto',
      userMessage: { content: 'hello' },
    }
  );
  return { res, starts };
}

describe('an automatic-effort turn whose menu marks no rung available', () => {
  it('is refused with 402 before a run is claimed when it searches', async () => {
    const model = await seedUnrunnableLadder(['streaming', 'tools']);
    const { res, starts } = await autoSend([model], true);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'INSUFFICIENT_ADMISSION' });
    expect(starts).toEqual([]);
  });

  it('is refused with 402 before a run is claimed when it carries no tool', async () => {
    const first = await seedUnrunnableLadder(['streaming']);
    const second = await seedUnrunnableLadder(['streaming']);
    const { res, starts } = await autoSend([first, second], false);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'INSUFFICIENT_ADMISSION' });
    expect(starts).toEqual([]);
  });
});
