// A turn naming one model more than once is refused at the wire boundary, on
// every paid route, before the run reaches the DO — which is where the
// admission hold is placed and where the fan-out that would bill the repeat is
// built. The refusal is the shared turn-source schema's, so it is uniform
// across text and media and needs no per-route guard.
import { describe, expect, it } from 'vitest';
import {
  MODEL,
  MODEL_B,
  cookie,
  recordingRealtime,
  post,
  postRegenerate,
  seedConversation,
  seedImageGateModel,
  seedMessage,
  seedModel,
  seedModelId,
  seedPurchasedWallet,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';

describe('chat paid routes: repeated turn sources', () => {
  it('refuses POST /chat naming the same model twice, before the run starts', async () => {
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
        turnSources: [
          { kind: 'model', id: MODEL },
          { kind: 'model', id: MODEL },
        ],
        userMessage: { content: 'twice over' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
    expect(starts).toHaveLength(0);
  });

  it('still admits the same turn with two distinct models', async () => {
    await seedModel();
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const { starts, realtime } = recordingRealtime();
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: MODEL },
          { kind: 'model', id: MODEL_B },
        ],
        userMessage: { content: 'two of them' },
      }
    );
    expect(res.status).toBe(201);
    expect(starts).toHaveLength(1);
  });

  it('refuses POST /chat/regenerate naming the same model twice', async () => {
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
    const { starts, realtime } = recordingRealtime();
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: MODEL },
          { kind: 'model', id: MODEL },
        ],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
    expect(starts).toHaveLength(0);
  });

  it('refuses a media turn naming the same model twice', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const { starts, realtime } = recordingRealtime();
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [
          { kind: 'model', id: imageModel },
          { kind: 'model', id: imageModel },
        ],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
    expect(starts).toHaveLength(0);
  });
});
