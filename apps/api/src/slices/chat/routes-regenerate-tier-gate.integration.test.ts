// The regenerate route's premium-tier exemption and the premise it rests on: the
// model was already chosen on the turn being regenerated. The premise is checked
// against the replies this regenerate replaces rather than assumed, so a
// substituted model takes the send path's gate.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createBillingStores } from '../billing/index.js';
import { createConversationsStores } from '../conversations/index.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import { createChatManifest } from './index.js';
import {
  MODEL,
  STARTED,
  cookie,
  fakeRealtime,
  postRegenerate,
  recordingRealtime,
  seedAssistantReply,
  seedMessage,
  seedModel,
  seedZeroBalanceMember,
  testEnv,
  withPremiumModel,
} from '../../test-support/chat-routes.integration.setup.js';
import type { AppEnv } from '../../lib/context/index.js';

describe('chat regenerate: premium-tier exemption is earned, not assumed', () => {
  it('refuses a free-tier caller substituting a premium model for the free one the reply used', async () => {
    await seedModel();
    await withPremiumModel(async (premiumModel) => {
      const { userId, conversationId } = await seedZeroBalanceMember();
      const anchor = await seedMessage(conversationId, {
        senderType: 'user',
        senderId: userId,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      await seedAssistantReply(conversationId, {
        parentMessageId: anchor,
        sequenceNumber: 2,
        modelId: MODEL,
      });
      const { starts, realtime } = recordingRealtime();
      const res = await postRegenerate(
        realtime,
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          targetMessageId: anchor,
          action: 'retry',
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
      expect(starts).toHaveLength(0);
    });
  });

  it('admits a free-tier caller re-running the premium model the reply already used', async () => {
    await withPremiumModel(async (premiumModel) => {
      const { userId, conversationId } = await seedZeroBalanceMember();
      const anchor = await seedMessage(conversationId, {
        senderType: 'user',
        senderId: userId,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      await seedAssistantReply(conversationId, {
        parentMessageId: anchor,
        sequenceNumber: 2,
        modelId: premiumModel,
      });
      const res = await postRegenerate(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          targetMessageId: anchor,
          action: 'retry',
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(201);
    });
  });

  it("judges a retry-one against the reply it names rather than that reply's siblings", async () => {
    await seedModel();
    await withPremiumModel(async (premiumModel) => {
      const { userId, conversationId } = await seedZeroBalanceMember();
      const anchor = await seedMessage(conversationId, {
        senderType: 'user',
        senderId: userId,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      const freeReply = await seedAssistantReply(conversationId, {
        parentMessageId: anchor,
        sequenceNumber: 2,
        modelId: MODEL,
      });
      await seedAssistantReply(conversationId, {
        parentMessageId: anchor,
        sequenceNumber: 3,
        modelId: premiumModel,
      });
      const res = await postRegenerate(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          targetMessageId: anchor,
          action: 'retry',
          replaceAssistantId: freeReply,
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
    });
  });

  it('fails closed when the reply-model read is unavailable', async () => {
    // The premise cannot be established when the read behind it is down, and an
    // unestablished premise must never resolve to the exemption — that would
    // turn an outage into a free tier upgrade. The store error surfaces instead.
    await seedModel();
    const { userId, conversationId } = await seedZeroBalanceMember();
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const conversations: typeof createConversationsStores = (storeDb) => {
      const stores = createConversationsStores(storeDb);
      return {
        ...stores,
        messages: {
          ...stores.messages,
          assistantReplyModels: () => errAsync(unavailableError('reply model read down')),
        },
      };
    };
    const manifest = createChatManifest({
      conversations,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat/regenerate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          targetMessageId: anchor,
          action: 'retry',
          userMessage: { content: 'again' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
  });
});
