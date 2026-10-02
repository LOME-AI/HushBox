// The two payer gates a send passes before admission: the payer freeze comparing the
// turn's minimum, and the premium-tier lock.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { allowanceSpending, conversations, memberBudgets, wallets } from '@hushbox/db';
import { charStorageNanoUsd, utcDayKey } from '@hushbox/shared';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { DAILY_ALLOWANCE_NANO_USD, createBillingStores } from '../billing/index.js';
import { createConversationsStores } from '../conversations/index.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import { createChatManifest } from './index.js';
import {
  MODEL,
  MODEL_B,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  post,
  postGuest,
  postPath,
  postRegenerate,
  seedConversation,
  seedAssistantReply,
  seedImageGateModel,
  seedGuestLink,
  seedMessage,
  seedModel,
  seedModelId,
  seedOwnerFundedGroup,
  seedOwnerFunding,
  seedPurchasedWallet,
  seedUnderfundedMemberGroup,
  seedUser,
  seedZeroBalanceMember,
  testEnv,
  withDearTrialCatalog,
  withPremiumModel,
} from '../../test-support/chat-routes.integration.setup.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { CapturedRunBody } from '../../test-support/chat-routes.integration.setup.js';

describe('chat route: the payer freeze compares the turn minimum', () => {
  it('charges the SENDER when the group headroom is positive but cannot cover the turn', async () => {
    await seedModel();
    // One nano of headroom is positive — the whole of the old comparison — and
    // nowhere near a turn. The owner can never fund this send, so admission
    // would refuse it against the member scope on this attempt and every retry.
    const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(1n);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(sender);
    expect(captured[0]?.userId).not.toBe(owner);
    const senderWallet = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.userId, sender));
    expect(captured[0]?.walletId).toBe(senderWallet[0]?.id);
  });

  it('still charges the OWNER when the headroom covers the turn', async () => {
    await seedModel();
    const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(10_000_000n);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(owner);
  });

  it('compares the minimum against storage for the new message alone', async () => {
    await seedModel();
    // The band this case sits in: headroom one nano under what the REPLAYED
    // history alone would cost to store. A minimum priced over the new message
    // sits far below it, so the owner funds the turn; a minimum priced over the
    // whole prompt reserves storage for history that was stored by the turns
    // that wrote it, outruns the headroom, and drops the payer to the sender.
    const REPLAYED_HISTORY_CHARS = 40_000;
    const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(
      charStorageNanoUsd(REPLAYED_HISTORY_CHARS) - 1n,
      1_000_000_000n
    );
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
        history: [{ role: 'user' as const, content: 'x'.repeat(REPLAYED_HISTORY_CHARS) }],
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(owner);
    expect(captured[0]?.userId).not.toBe(sender);
  });

  it('compares the guest-send minimum against storage for the new message alone', async () => {
    await seedModel();
    // The same band on the guest route, where the freeze's verdict decides the
    // send rather than the payer: a link guest holds no wallet to fall through
    // to, so headroom that cannot cover the minimum denies the send outright.
    // Priced over the new message the owner funds it; priced over the whole
    // prompt the replayed history's storage outruns the guest's cap.
    const REPLAYED_HISTORY_CHARS = 40_000;
    const GROUP_FUNDING_NANO_USD = 1_000_000_000n;
    const owner = await seedUser();
    const conversationId = await seedConversation(owner, false);
    await db
      .insert(wallets)
      .values({ userId: owner, type: 'purchased', balanceNanoUsd: GROUP_FUNDING_NANO_USD });
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: GROUP_FUNDING_NANO_USD })
      .where(eq(conversations.id, conversationId));
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    // The guest's own cap is the binding dimension, one nano under what the
    // replayed history alone would cost to store.
    await db.insert(memberBudgets).values({
      memberId: guest.memberId,
      budgetNanoUsd: charStorageNanoUsd(REPLAYED_HISTORY_CHARS) - 1n,
    });
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'hello' },
      history: [{ role: 'user' as const, content: 'x'.repeat(REPLAYED_HISTORY_CHARS) }],
    });
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(owner);
  });

  // Both arms of the predicate deciding whether a turn stores a user message: a
  // retry rests nowhere new and reserves nothing, an edit reserves its
  // replacement message. Neither reserves the resent history, which the turns
  // that wrote it already paid to store — so the freeze must reach the same
  // verdict on both, and priced over the whole prompt it reaches neither.
  for (const action of ['retry', 'edit'] as const) {
    it(`sizes a regenerate ${action}'s minimum by the storage it takes, not the resent prompt`, async () => {
      await seedModel();
      const REPLAYED_HISTORY_CHARS = 40_000;
      const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(
        charStorageNanoUsd(REPLAYED_HISTORY_CHARS) - 1n,
        1_000_000_000n
      );
      const anchor = await seedMessage(conversationId, {
        senderType: 'user',
        senderId: sender,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      const captured: CapturedRunBody[] = [];
      const realtime = fakeRealtime(STARTED, {
        startRun: (_conversationId, body) => {
          captured.push(body as unknown as CapturedRunBody);
          return okAsync(STARTED);
        },
      });
      const res = await postRegenerate(
        realtime,
        { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          targetMessageId: anchor,
          action,
          userMessage: { content: 'again' },
          history: [{ role: 'user' as const, content: 'x'.repeat(REPLAYED_HISTORY_CHARS) }],
        }
      );
      expect(res.status).toBe(201);
      expect(captured[0]?.userId).toBe(owner);
      expect(captured[0]?.userId).not.toBe(sender);
    });
  }

  it('charges the SENDER when the headroom cannot cover a media turn per-unit price', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    // Headroom an order of magnitude below one image's deterministic price plus
    // the bytes it will store — a band no per-token pricing can see, since a
    // media call has no token leg at all.
    const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(10_000_000n);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(sender);
    expect(captured[0]?.userId).not.toBe(owner);
  });

  it('still charges the OWNER for a media turn the headroom covers', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(
      1_000_000_000n,
      1_000_000_000n
    );
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: imageModel }],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(owner);
  });

  it('charges the SENDER when the headroom is below the Smart Model pool minimum', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    // One nano of headroom froze the owner as payer, and the slot then derived
    // its candidates from that same nano — an empty set, so the send answered
    // 402 on this attempt and on every retry.
    const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(1n);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(sender);
    expect(captured[0]?.userId).not.toBe(owner);
  });

  it('refuses a media send naming a model the catalog does not expose', async () => {
    // Nothing prices, so there is no minimum to compare — and an absent price
    // must not read as a free turn. The build refuses the selection, which is
    // why the freeze can leave the comparison inapplicable here.
    const { conversationId, sender } = await seedUnderfundedMemberGroup(10_000_000n);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: `no/such-${crypto.randomUUID().slice(0, 8)}` }],
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { content: 'a red cube' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('still charges the OWNER for a Smart Model turn the headroom covers', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const { conversationId, owner, sender } = await seedUnderfundedMemberGroup(10_000_000n);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(owner);
  });
});

describe('chat route: premium-tier gate', () => {
  it('refuses a premium model for a zero-balance caller with 403 MODEL_TIER_LOCKED', async () => {
    await withPremiumModel(async (premiumModel) => {
      const { userId, conversationId } = await seedZeroBalanceMember();
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
    });
  });

  it('admits a non-premium model for the same zero-balance caller (201)', async () => {
    const { userId, conversationId } = await seedZeroBalanceMember();
    // A zero-balance caller is admitted only because MODEL is non-premium, which
    // the gate decides by ranking MODEL's price against the exposed-catalog 75th
    // percentile. This file's own accumulated cheap fixtures collapse that
    // threshold onto MODEL's price and wrongly lock it (403). Pin a deterministic
    // spread (MODEL below the pricey decoys) so it stays non-premium regardless
    // of run order — the same percentile-determinism the trial refusal tests
    // rely on.
    const spreadModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const res = await withDearTrialCatalog(spreadModel, async () =>
      post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          userMessage: { content: 'hello' },
        }
      )
    );
    expect(res.status).toBe(201);
  });

  it('admits the same premium model for a caller with a positive purchased balance (201)', async () => {
    await withPremiumModel(async (premiumModel) => {
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(201);
    });
  });

  it('locks a multi-model send when any selected model is premium for a zero-balance caller (403)', async () => {
    await withPremiumModel(async (premiumModel) => {
      await seedModelId(MODEL);
      const { userId, conversationId } = await seedZeroBalanceMember();
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [
            { kind: 'model', id: MODEL },
            { kind: 'model', id: premiumModel },
          ],
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
    });
  });

  it('exempts a Smart-slot-only send from the tier gate (201)', async () => {
    // The slot names no model, so there is nothing to judge for entitlement —
    // its candidates come from the affordable set the payer can already reach.
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const { userId, conversationId } = await seedZeroBalanceMember();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'smart' }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
  });

  // The slot's presence must never exempt a model the user pinned by name, and
  // the gate must reach that verdict from EITHER selection order. Asserted over
  // HTTP, where the bypass would actually live: a pin on the gate's own input
  // would keep looking guarded while the route answered something else.
  for (const [label, order] of [
    ['slot first', [{ kind: 'smart' }, 'premium']],
    ['pinned first', ['premium', { kind: 'smart' }]],
  ] as const) {
    it(`locks a send carrying the Smart slot beside a premium model, ${label} (403)`, async () => {
      await withPremiumModel(async (premiumModel) => {
        await seedModelId(MODEL);
        const { userId, conversationId } = await seedZeroBalanceMember();
        const res = await post(
          fakeRealtime(STARTED),
          { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
          {
            conversationId,
            turnSources: order.map((entry) =>
              entry === 'premium' ? { kind: 'model', id: premiumModel } : entry
            ),
            userMessage: { content: 'hello' },
          }
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
      });
    });
  }

  it('does not tier-lock an owner-funded group turn (the caller is not the payer) (201)', async () => {
    await withPremiumModel(async (premiumModel) => {
      // The owner funds the group turn, so the payer is the OWNER's wallet. The
      // sending member has no wallet and could never access premium personally,
      // yet the gate must not fire — the caller is not the direct payer.
      const { conversationId, sender } = await seedOwnerFundedGroup();
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(201);
    });
  });

  it('does not read the sender wallet at the gate for an owner-funded turn (a sender-read failure is a no-op)', async () => {
    // The tier gate reuses the funding primitives the turn context already froze
    // — it makes no wallet read of its own. An owner-funded turn is premium-
    // exempt (the caller is not the payer), so the gate answers without
    // consulting the catalog. A failing SENDER wallet read must therefore
    // not affect the turn: the context reads only the owner (which succeeds),
    // and the gate reads nothing. The turn proceeds (201).
    const { conversationId, sender } = await seedOwnerFundedGroup();
    await seedModel();
    const billing = createBillingStores();
    const failingBilling: typeof billing = {
      ...billing,
      readWallets: (walletDb, userId) =>
        userId === sender
          ? errAsync(unavailableError('wallet read down'))
          : billing.readWallets(walletDb, userId),
    };
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: failingBilling,
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(sender),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          userMessage: { content: 'hello' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
  });

  it('refuses a premium model from a zero-balance FULL-SESSION sender on the guest route (403)', async () => {
    await withPremiumModel(async (premiumModel) => {
      // The guest route accepts a full session (the owner opening their own
      // share link), so a signed-in sender reaches it as a direct-billing
      // caller. The gate follows the payer, so it fires here exactly as it
      // does on the send route.
      const { userId, conversationId } = await seedZeroBalanceMember();
      const res = await postPath(
        '/chat/guest',
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          userMessage: { content: 'hello' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
    });
  });

  it('admits a premium model for an owner-funded link guest on the guest route (201)', async () => {
    await withPremiumModel(async (premiumModel) => {
      // A link guest never self-funds: the owner is the payer, so the gate
      // must stay a no-op however little the guest could afford personally.
      const ownerId = await seedUser();
      const conversationId = await seedConversation(ownerId, false);
      const guest = await seedGuestLink(conversationId, { privilege: 'write' });
      await seedOwnerFunding(ownerId, conversationId, guest.memberId);
      const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
        conversationId,
        turnSources: [{ kind: 'model', id: premiumModel }],
        userMessage: { content: 'hello' },
      });
      expect(res.status).toBe(201);
    });
  });

  it('refuses a premium model on a regenerate with no reply to have chosen it (403)', async () => {
    await withPremiumModel(async (premiumModel) => {
      // The regenerate exemption rests on the model having been chosen on the
      // turn being regenerated. This anchor carries no reply at all, so nothing
      // chose the premium model and the caller gets the same refusal a fresh
      // send gives — the exemption is earned, never granted by route identity.
      // The earned case is pinned by
      // 'routes-regenerate-tier-gate.integration.test.ts'.
      const { userId, conversationId } = await seedZeroBalanceMember();
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
          turnSources: [{ kind: 'model', id: premiumModel }],
          targetMessageId: anchor,
          action: 'retry',
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
    });
  });

  it('maps a not-started admission outcome on a premium regenerate to 402', async () => {
    await withPremiumModel(async (premiumModel) => {
      // Wiring, not money enforcement: the entitlement exemption must return
      // the resolved context rather than a refusal, so a premium regenerate
      // reaches run start at all and the run's not-started admission outcome
      // becomes the caller's 402. The verdict here is a constant supplied by
      // the realtime double, so no change to money enforcement can move it —
      // the money half is carried by 'refuses a smart-model regenerate when no
      // candidate is affordable', whose 402 comes from route code.
      const { userId, conversationId } = await seedZeroBalanceMember();
      const anchor = await seedMessage(conversationId, {
        senderType: 'user',
        senderId: userId,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      // The replaced reply used this same premium model, which is what earns
      // the entitlement exemption — without it the tier gate answers first and
      // the admission outcome under test is never reached.
      await seedAssistantReply(conversationId, {
        parentMessageId: anchor,
        sequenceNumber: 2,
        modelId: premiumModel,
      });
      const res = await postRegenerate(
        fakeRealtime({ started: false, code: 'INSUFFICIENT_ADMISSION' }),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: premiumModel }],
          targetMessageId: anchor,
          action: 'retry',
          userMessage: { content: 'again' },
        }
      );
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ code: 'INSUFFICIENT_ADMISSION' });
    });
  });

  it('refuses a smart-model regenerate when no candidate is affordable (402)', async () => {
    // The budget half, on the route's own affordability read rather than a
    // realtime verdict: Smart Model derives its candidates from the payer's
    // effective funding, so a spent daily allowance leaves an empty set on a
    // regenerate exactly as it does on a send.
    await seedModelId(MODEL);
    const { userId, conversationId } = await seedZeroBalanceMember();
    await db
      .insert(allowanceSpending)
      .values({ userId, day: utcDayKey(new Date()), spentNanoUsd: DAILY_ALLOWANCE_NANO_USD });
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
        turnSources: [{ kind: 'smart' }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_ADMISSION' });
  });
});
