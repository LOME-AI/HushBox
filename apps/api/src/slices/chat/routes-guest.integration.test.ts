// POST /chat/guest: server-side resolution of the link credential, owner funding, and
// the privilege edges of a link guest.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { conversations, memberBudgets, wallets } from '@hushbox/db';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { hmacRateLimitId } from '../../lib/rate-limit/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createBillingStores } from '../billing/index.js';
import { createConversationsStores } from '../conversations/index.js';
import { createChatManifest } from './index.js';
import { LINK_CREDENTIAL_HEADER } from './domain/index.js';
import {
  MODEL,
  STARTED,
  cookie,
  createApp,
  db,
  fakeRealtime,
  postGuest,
  redis,
  seedConversation,
  seedFork,
  seedGuestLink,
  seedImageGateModel,
  seedModel,
  seedOwnerFunding,
  seedPurchasedWallet,
  seedUser,
  testEnv,
} from '../../test-support/chat-routes.integration.setup.js';
import { mintLinkCredential } from '../../test-support/link-credential.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { RunStartBody } from '@hushbox/realtime';
import type { CapturedRunBody } from '../../test-support/chat-routes.integration.setup.js';

describe('chat route: POST /chat/guest (link-guest send)', () => {
  it('owner-funds a WRITE guest turn and resolves the sender server-side from the credential', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
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
      userMessage: { content: 'hello from a guest' },
    });
    expect(res.status).toBe(201);
    const body = captured[0];
    // The OWNER pays; the guest is the sender, named by the server-resolved linkId.
    expect(body?.userId).toBe(ownerId);
    expect(body?.sender).toEqual({ kind: 'linkGuest', linkId: guest.linkId });
  });

  it('refuses a guest send whose user message carries an id with 400', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const starts: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        starts.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { id: crypto.randomUUID(), content: 'a guest picks an id' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
    expect(starts).toEqual([]);
  });

  it('hands the room the user message id the guest run-start response returns', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const starts: RunStartBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        starts.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'hello from a guest' },
    });
    expect(res.status).toBe(201);
    const { userMessageId } = await res.json<{ userMessageId: unknown }>();
    expect(typeof userMessageId).toBe('string');
    const handed = starts[0];
    expect(handed?.mode === 'paid' ? handed.userMessage.id : undefined).toBe(userMessageId);
  });

  it('IGNORES a client-spoofed sender/memberId/userId in the body (server resolution wins)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
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
      userMessage: { content: 'spoof attempt' },
      // Attacker-supplied identity fields — must be dropped, never trusted.
      userId: 'attacker-owner',
      senderId: 'attacker-link',
      sender: { kind: 'linkGuest', linkId: 'attacker-link', memberId: 'attacker-member' },
      memberId: 'attacker-member',
    });
    expect(res.status).toBe(201);
    const body = captured[0];
    expect(body?.userId).toBe(ownerId);
    expect(body?.sender).toEqual({ kind: 'linkGuest', linkId: guest.linkId });
  });

  it('DENIES a guest turn the owner cannot fund (no member cap → no fall-through wallet)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    // Owner wallet + conversation cap, but NO member-budget row → zero headroom.
    await db
      .insert(wallets)
      .values({ userId: ownerId, type: 'purchased', balanceNanoUsd: 10_000_000n });
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 1_000_000n })
      .where(eq(conversations.id, conversationId));
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'no funds' },
    });
    expect(res.status).toBe(403);
    // The denial REASON, not just the refusal: the funding core's code is what
    // says the owner could not cover it and the guest had no wallet to fall
    // through to. Status alone reads the same as a privilege or revocation 403.
    expect(await res.json()).toEqual({ code: 'GROUP_BUDGET_EXHAUSTED' });
  });

  it('DENIES a guest whose owner headroom is positive but cannot cover the turn', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    // Owner wallet and both caps present, the member cap positive but far below
    // a turn: the guest boundary does not move — a guest holds no wallet, so it
    // is refused rather than fallen through (§Group Funding 2).
    await db
      .insert(wallets)
      .values({ userId: ownerId, type: 'purchased', balanceNanoUsd: 10_000_000n });
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 10_000_000n })
      .where(eq(conversations.id, conversationId));
    await db.insert(memberBudgets).values({ memberId: guest.memberId, budgetNanoUsd: 1n });
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'hello' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'GROUP_BUDGET_EXHAUSTED' });
  });

  it('refuses a READ-only guest', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'read' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'read only' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a REVOKED guest (its member row marked left)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write', leftAt: true });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'revoked' },
    });
    expect(res.status).toBe(403);
  });

  // Over-determined: the typed conversation match, the member lookup behind it, and
  // `requireSenderMember` downstream all key on the TARGET conversation, so a guest of
  // A holds no row on B and is refused three times over. This pins the 403, not a gate.
  it('refuses a guest of conversation A pointing its credential at conversation B', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationA = await seedConversation(ownerId, false);
    const conversationB = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationA, { privilege: 'write' });
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId: conversationB,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'wrong conversation' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a guest send with no link credential (401)', async () => {
    const conversationId = crypto.randomUUID();
    const res = await postGuest(fakeRealtime(STARTED), undefined, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'anon' },
    });
    expect(res.status).toBe(401);
  });

  it('lets a FULL-SESSION user send on the guest route, resolved as a user (not a guest)', async () => {
    await seedModel();
    const userId = await seedUser();
    // The user owns the conversation and is a member; a session cookie (no link
    // credential) resolves them as a user caller.
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await createApp(realtime).request(
      '/chat/guest',
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
          userMessage: { content: 'a user on the guest route' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(userId);
    expect(captured[0]?.sender?.kind).toBe('user');
  });

  it('carries a fork send through the guest seam (forkId bound to the run body)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const forkId = await seedFork(conversationId);
    const captured: Record<string, unknown>[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as Record<string, unknown>);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      forkId,
      userMessage: { content: 'onto a fork' },
    });
    expect(res.status).toBe(201);
    expect(captured[0]?.['forkId']).toBe(forkId);
  });

  it('fails closed (503) when the link-resolution store is unavailable', async () => {
    const conversationId = crypto.randomUUID();
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: () => ({
        resolveLinkCredential: () => errAsync(unavailableError('link store down')),
      }),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat/guest',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LINK_CREDENTIAL_HEADER]: mintLinkCredential().token,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          userMessage: { content: 'store down' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
  });

  it('refuses a guest send past the per-sender rate cap (429, keyed on the linkId)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    // Pre-fill the guest's 60s window to the cap (keyed on the linkId).
    await redis.set(`ratelimit:chat:stream:user:${hmacRateLimitId(guest.linkId)}`, 30, { ex: 60 });
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'flooding' },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('surfaces a guest build refusal (unknown model) from the shared pipeline', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: `chat-route/${crypto.randomUUID().slice(0, 8)}-absent` }],
      userMessage: { content: 'unknown model' },
    });
    // The build refuses before any run starts (never a 201) — the guest turn is
    // the SAME compile pipeline as an authenticated send.
    expect(res.status).toBe(400);
  });

  /*
   * The guest route reaches the paid model-resolution path through the same
   * call as an authenticated send, so it inherits that path's text-turn
   * modality refusal — a pinned media descriptor sent with no `modality` field.
   * Inheritance through a shared call site is not a pin: this case is what
   * holds the refusal on the guest money path if the gate is ever moved into
   * the `POST /chat` handler.
   */
  it('refuses a guest text turn over a pinned image model when the body asks for no modality (400)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedImageGateModel(imageModel);
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: imageModel }],
      userMessage: { content: 'hello' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MODALITY' });
    expect(captured).toHaveLength(0);
  });
});
