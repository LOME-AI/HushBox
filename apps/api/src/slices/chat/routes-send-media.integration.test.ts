// POST /chat's media turn construction: image and video config to node params, and
// the modality refusals in both directions — a media turn over a text model, and a
// text turn (no `modality` field) over a media model.
import { describe, expect, it } from 'vitest';
import { okAsync } from '../../lib/result/index.js';
import {
  MODEL,
  STARTED,
  cookie,
  fakeRealtime,
  post,
  seedConversation,
  seedImageGateModel,
  seedModel,
  seedModelId,
  seedPurchasedWallet,
  seedUser,
  seedVideoGateModel,
} from '../../test-support/chat-routes.integration.setup.js';
import type { WorkflowDefinition } from '@hushbox/shared';

describe('chat route: POST /chat', () => {
  it('builds a media (image) turn carrying its config as node params (201)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
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
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    // A media turn is deadline-classed 'media' and dispatches the image model
    // with its config as params (the image adapter reads them at execution).
    expect(definition.deadlineClass).toBe('media');
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.model).toBe(imageModel);
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ aspectRatio: '4:3' });
  });

  // Smart plus media generation is out by design at EVERY arrangement, not only
  // as the sole source. A body carrying the slot beside a pinned media model
  // would otherwise compile a one-model generation with the slot silently
  // dropped, leaving the client a tile no stream ever reaches. Each case is
  // paired with the same body minus the slot, so a green refusal cannot come
  // from a fixture that refuses everything.
  for (const [label, withSlot] of [
    ['slot first', (id: string) => [{ kind: 'smart' }, { kind: 'model', id }]],
    ['slot last', (id: string) => [{ kind: 'model', id }, { kind: 'smart' }]],
  ] as const) {
    it(`refuses an image turn carrying the Smart slot beside a pinned model, ${label} (400)`, async () => {
      const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
      await seedImageGateModel(imageModel);
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const send = async (turnSources: unknown): Promise<Response> =>
        post(
          fakeRealtime(STARTED),
          { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
          {
            conversationId,
            turnSources,
            modality: 'image',
            imageConfig: { aspectRatio: '4:3' },
            userMessage: { content: 'a red cube' },
          }
        );
      const refused = await send(withSlot(imageModel));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ code: 'VALIDATION' });
      // The control: the identical body with the slot removed still runs, so
      // the 400 above is the slot's presence and nothing else about the fixture.
      const control = await send([{ kind: 'model', id: imageModel }]);
      expect(control.status).toBe(201);
    });

    it(`refuses a video turn carrying the Smart slot beside a pinned model, ${label} (400)`, async () => {
      const videoModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
      await seedVideoGateModel(videoModel);
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const send = async (turnSources: unknown): Promise<Response> =>
        post(
          fakeRealtime(STARTED),
          { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
          {
            conversationId,
            turnSources,
            modality: 'video',
            videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
            userMessage: { content: 'a drone shot' },
          }
        );
      const refused = await send(withSlot(videoModel));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ code: 'VALIDATION' });
      const control = await send([{ kind: 'model', id: videoModel }]);
      expect(control.status).toBe(201);
    });
  }

  it('refuses an aspect ratio the selected image model does not offer with 400', async () => {
    // The build-time media-parameter gate. It reads the model's declared
    // `aspectRatio` domain and skips any axis the descriptor leaves unspecified,
    // so it can only fire against a fixture that declares one — which is why
    // the image fixture mints real ParamSpecs rather than an empty record.
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
        imageConfig: { aspectRatio: '9:16' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('builds one media sibling per model when a multi-model list is sent', async () => {
    const imageA = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const imageB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageA);
    await seedImageGateModel(imageB);
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
          { kind: 'model', id: imageA },
          { kind: 'model', id: imageB },
        ],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    expect(definition.deadlineClass).toBe('media');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    // One optional skip-on-error sibling per selected model, in the sent order,
    // each under its own node id (its own charge key and assistant message)
    // and each carrying the shared generation config as params.
    expect(siblings.map((node) => node.model)).toEqual([imageA, imageB]);
    expect(new Set(siblings.map((node) => node.id)).size).toBe(2);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
      expect(sibling.params).toEqual({ aspectRatio: '4:3' });
    }
  });

  it('builds an image turn with empty params when no config is supplied (201)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
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
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({});
  });

  it('builds a media (video) turn with its full config (201)', async () => {
    const videoModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedVideoGateModel(videoModel);
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
        turnSources: [{ kind: 'model', id: videoModel }],
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
        userMessage: { content: 'a drone shot' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({
      aspectRatio: '16:9',
      durationSeconds: 6,
      resolution: '720p',
    });
  });

  it('rejects a video turn missing its config with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        modality: 'video',
        userMessage: { content: 'a drone shot' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses an image turn whose only source is the Smart slot with 400', async () => {
    // Smart plus media generation is out by design. The slot names no model, so
    // this body selects nothing to generate with and would otherwise compile to
    // a turn with zero generations rather than fail.
    await seedImageGateModel(`chat-route/${crypto.randomUUID().slice(0, 8)}`);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses a video turn whose only source is the Smart slot with 400', async () => {
    await seedVideoGateModel(`chat-route/${crypto.randomUUID().slice(0, 8)}`);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
        userMessage: { content: 'a drone shot' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses a media turn over a text-only model with 400 (wrong modality)', async () => {
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
        modality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MODALITY' });
  });

  /*
   * The mirror of the wrong-modality refusal above — a media turn over a
   * text-only model — taken in the other direction: a body pinning a media
   * model with no `modality` field is a TEXT turn, and the pinned descriptor
   * produces no text. Both directions are one refusal at one code —
   * `assertModelProducesModality` in
   * `apps/api/src/slices/chat/domain/turn/definition.ts` — so a media descriptor
   * never reaches the single-turn text compile with a wallet behind it.
   */
  it('refuses a text turn over a pinned image model when the body asks for no modality (400)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const started: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        started.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MODALITY' });
    expect(started).toHaveLength(0);
  });

  /*
   * The same refusal reached through the fan-out rather than the single-model
   * arm: one non-text model among the pinned sources refuses the whole turn.
   * Literally the media path's own list gate — `assertModelsProduceModality` in
   * `apps/api/src/slices/chat/domain/turn/definition.ts` walks the list for both
   * modality directions — so this case and its media mirror cannot disagree on
   * what a mixed list does.
   */
  it('refuses a text fan-out whose pinned sources include a video model (400)', async () => {
    const videoModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedModel();
    await seedVideoGateModel(videoModel);
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
          { kind: 'model', id: videoModel },
        ],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MODALITY' });

    // "include" is a quantifier over POSITIONS, and the arrangement above places
    // the video model at the last one. Three sources so the offending entry gets
    // an INTERIOR position of its own: a two-element reorder only moves the
    // degeneracy to the other corner. Totalled into one object so a regression
    // names the position that stopped refusing, rather than surfacing as
    // whichever arrangement happened to run first.
    const textB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const textC = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedModelId(textB);
    await seedModelId(textC);
    const sendPinned = async (
      ids: readonly string[]
    ): Promise<{ status: number; body: unknown }> => {
      const arranged = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: ids.map((id) => ({ kind: 'model', id })),
          userMessage: { content: 'hello' },
        }
      );
      return { status: arranged.status, body: await arranged.json() };
    };
    const refusal = { status: 400, body: { code: 'UNSUPPORTED_MODALITY' } };
    expect({
      badFirst: await sendPinned([videoModel, textB, textC]),
      badMiddle: await sendPinned([textB, videoModel, textC]),
      badLast: await sendPinned([textB, textC, videoModel]),
    }).toEqual({ badFirst: refusal, badMiddle: refusal, badLast: refusal });
    // The control: the same three-wide shape with the video model swapped for a
    // text one still runs, so the three refusals above are the video model's
    // presence and not the width or the fixtures.
    const control = await sendPinned([MODEL, textB, textC]);
    expect(control.status).toBe(201);
  });
});
