// The admin kill switch, on every entry path that takes a client model selection.
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { modelCatalog } from '@hushbox/db';
import {
  MODEL,
  STARTED,
  cookie,
  createApp,
  db,
  fakeRealtime,
  post,
  postGuest,
  postRegenerate,
  postTrial,
  seedConversation,
  seedGuestLink,
  seedMessage,
  seedModel,
  seedModelId,
  seedOwnerFunding,
  seedPurchasedWallet,
  seedUser,
  testEnv,
  trialHeaders,
} from '../../test-support/chat-routes.integration.setup.js';

/**
 * Seeds a fresh catalog model with the admin kill switch set, runs the test,
 * and drops the row in a finally — a leaked disabled row would otherwise stay
 * visible to every later test in the file.
 */
async function withDisabledModel(run: (modelId: string) => Promise<void>): Promise<void> {
  const modelId = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
  await seedModelId(modelId);
  await db
    .update(modelCatalog)
    .set({ adminDisabledAt: new Date() })
    .where(eq(modelCatalog.modelId, modelId));
  try {
    await run(modelId);
  } finally {
    await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
  }
}

// The admin kill-switch gate: a disabled model must answer the SPECIFIC
// MODEL_DISABLED code (not the generic unknown-model refusal it fails closed
// to without the gate) on every entry path that takes a client model
// selection. The enabled-model counterpart of each path is its existing
// 201 test above (paid, guest, and trial run-handle tests).
describe('chat route: admin-disabled model gate', () => {
  it('refuses a paid send selecting a disabled model with 403 MODEL_DISABLED', async () => {
    await withDisabledModel(async (disabledModel) => {
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: disabledModel }],
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_DISABLED' });
    });
  });

  it('refuses a multi-model send containing one disabled model with 403 MODEL_DISABLED', async () => {
    await withDisabledModel(async (disabledModel) => {
      await seedModel();
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
            { kind: 'model', id: disabledModel },
          ],
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_DISABLED' });
    });
  });

  it('refuses a guest send selecting a disabled model with 403 MODEL_DISABLED', async () => {
    await withDisabledModel(async (disabledModel) => {
      const ownerId = await seedUser();
      const conversationId = await seedConversation(ownerId, false);
      const guest = await seedGuestLink(conversationId, { privilege: 'write' });
      await seedOwnerFunding(ownerId, conversationId, guest.memberId);
      const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
        conversationId,
        turnSources: [{ kind: 'model', id: disabledModel }],
        userMessage: { content: 'hello' },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_DISABLED' });
    });
  });

  it('refuses a regenerate selecting a disabled model with 403 MODEL_DISABLED', async () => {
    await withDisabledModel(async (disabledModel) => {
      // Availability is not entitlement: a regenerate can earn an exemption
      // from the premium-tier gate but never from the kill switch, and it
      // answers the specific refusal rather than the generic unknown-model one.
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
          turnSources: [{ kind: 'model', id: disabledModel }],
          targetMessageId: anchor,
          action: 'retry',
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_DISABLED' });
    });
  });

  it('refuses a trial send selecting a disabled model with 403 MODEL_DISABLED', async () => {
    await withDisabledModel(async (disabledModel) => {
      const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
        turnSources: [{ kind: 'model', id: disabledModel }],
        prompt: 'hi',
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_DISABLED' });
    });
  });

  it('answers 503 UNAVAILABLE when the catalog read behind the gate fails', async () => {
    // The trial send's first Postgres touch is the disabled-model gate, so a
    // dead database surfaces the gate's own read failure as the typed 503 —
    // never a defect 500.
    const deadDbEnv = {
      ...testEnv,
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox',
    };
    const res = await createApp(fakeRealtime(STARTED)).request(
      '/chat/trial',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...trialHeaders() },
        body: JSON.stringify({ turnSources: [{ kind: 'model', id: MODEL }], prompt: 'hi' }),
      },
      deadDbEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});
