// POST /chat/regenerate's anchor selection: forks, the edit and retry actions, and
// cross-member authorization over another member's message.
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { conversationForks, conversationMembers, messages } from '@hushbox/db';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { okAsync } from '../../lib/result/index.js';
import { hashCanonicalJson } from './domain/index.js';
import {
  MODEL,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  postRegenerate,
  seedConversation,
  seedFork,
  seedMessage,
  seedModel,
  seedPurchasedWallet,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';

describe('chat route: POST /chat/regenerate', () => {
  it('threads a regenerate onto an existing fork (201)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const forkId = await seedFork(conversationId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    // Point the fork tip at the anchor so the guard's observed tip is a real id;
    // the route must carry exactly it into the run body (the settlement fence).
    await db
      .update(conversationForks)
      .set({ tipMessageId: anchor })
      .where(eq(conversationForks.id, forkId));

    const captured: { forkId: unknown; regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({
          forkId: body.mode === 'paid' ? body.forkId : undefined,
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
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        forkId,
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([
      {
        forkId,
        regenerate: { action: 'retry', targetMessageId: anchor, observedForkTipId: anchor },
      },
    ]);
  });

  it('keeps the bodyHash identical when only the observed fork tip moved between same-key retries', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const forkId = await seedFork(conversationId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: anchor })
      .where(eq(conversationForks.id, forkId));

    const captured: { bodyHash: string; regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        if (body.mode === 'paid') {
          captured.push({ bodyHash: body.bodyHash, regenerate: body.regenerate });
        }
        return okAsync(STARTED);
      },
    });
    // One client intent, retried under one Idempotency-Key. Between the two
    // sends the fork tip legitimately advances (an assistant reply landed), so
    // the server-derived observedForkTipId differs — the hash the DO compares
    // for same-key dedup must not, or a benign retry would 409 body-mismatch.
    const idempotencyKey = crypto.randomUUID();
    const clientBody = {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      targetMessageId: anchor,
      action: 'retry',
      forkId,
      userMessage: { content: 'again' },
    };
    const headers = { cookie: await cookie(userId), 'Idempotency-Key': idempotencyKey };

    const first = await postRegenerate(realtime, headers, clientBody);
    expect(first.status).toBe(201);

    const reply = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: anchor,
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: reply })
      .where(eq(conversationForks.id, forkId));

    const second = await postRegenerate(realtime, headers, clientBody);
    expect(second.status).toBe(201);

    expect(captured).toHaveLength(2);
    // The tip really moved between the two run bodies …
    expect(captured[0]?.regenerate).toEqual({
      action: 'retry',
      targetMessageId: anchor,
      observedForkTipId: anchor,
    });
    expect(captured[1]?.regenerate).toEqual({
      action: 'retry',
      targetMessageId: anchor,
      observedForkTipId: reply,
    });
    // … yet the dedup hash is unchanged: the tip is excluded from client intent.
    expect(captured[1]?.bodyHash).toBe(captured[0]?.bodyHash);
    // Non-vacuity: folding the moved tip into the same hash input would have
    // produced a different digest, so the equality above is a real exclusion.
    const hashWithTip = await hashCanonicalJson({
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      forkId,
      userMessage: clientBody.userMessage,
      regenerate: {
        action: 'retry',
        targetMessageId: anchor,
        observedForkTipId: reply,
      },
    });
    expect(hashWithTip).not.toBe(captured[0]?.bodyHash);
  });

  it("blocks a regenerate across another member's message with 403", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: other, visibleFromEpoch: 1 });
    // owner → a1 → other → a2(tip). Regenerating from the owner's message would
    // delete the other member's intervening message.
    const u1 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const a1 = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: u1,
    });
    const u2 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: other,
      sequenceNumber: 3,
      parentMessageId: a1,
    });
    await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 4,
      parentMessageId: u2,
    });

    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: u1,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
  });

  it('threads the regenerate action into the run for a solo retry (201)', async () => {
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
    const replaceAssistantId = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: anchor,
    });

    const captured: { regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ regenerate: body.mode === 'paid' ? body.regenerate : undefined });
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
        replaceAssistantId,
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([
      { regenerate: { action: 'retry', targetMessageId: anchor, replaceAssistantId } },
    ]);
  });

  it("refuses a retry-one whose replaceAssistantId is a co-member's message (arbitrary delete) with 404", async () => {
    await seedModel();
    const owner = await seedUser();
    const other = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: other, visibleFromEpoch: 1 });
    // The victim is the co-member's message; the owner's own message is the tip,
    // so the tip→target walk is empty (no cross-member 403), which is exactly
    // where the unguarded replaceAssistantId delete slipped through.
    const victim = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: other,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 2,
      parentMessageId: null,
    });

    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        replaceAssistantId: victim,
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
    // The paid run never started, so the settlement's unscoped delete never runs.
    expect(captured).toEqual([]);
  });

  it('refuses a no-forkId regenerate once the conversation has a fork with 409', async () => {
    await seedModel();
    const owner = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await seedFork(conversationId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 1,
      parentMessageId: null,
    });

    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'FORK_ID_REQUIRED' });
    // The unsafe linear sequence-delete never started.
    expect(captured).toEqual([]);
  });

  it('threads an edit action into the run for a solo edit (201)', async () => {
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

    const captured: { regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ regenerate: body.mode === 'paid' ? body.regenerate : undefined });
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
        userMessage: { content: 'edited' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([{ regenerate: { action: 'edit', targetMessageId: anchor } }]);
  });

  // A member must not regenerate/edit ANOTHER member's turn: the anchor must be
  // the caller's own user message. attacker(m1) → assistant(m2) → victim(m3) →
  // assistant(m4, tip); anchoring on m3 with the tip m4 above it makes the
  // tip→target walk empty, so only the ownership gate stops the settlement's
  // sequence-scoped delete from destroying the victim's m3 + m4.
  async function seedCrossMemberTurn(): Promise<{
    readonly attacker: string;
    readonly conversationId: string;
    readonly m3: string;
    readonly m4: string;
  }> {
    await seedModel();
    const attacker = await seedUser();
    const victim = await seedUser();
    const conversationId = await seedConversation(attacker, true);
    await seedPurchasedWallet(attacker);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: victim, visibleFromEpoch: 1 });
    const m1 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: attacker,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const m2 = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: m1,
    });
    const m3 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: victim,
      sequenceNumber: 3,
      parentMessageId: m2,
    });
    const m4 = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 4,
      parentMessageId: m3,
    });
    return { attacker, conversationId, m3, m4 };
  }

  async function expectVictimSurvives(m3: string, m4: string): Promise<void> {
    const survivors = await db
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.id, [m3, m4]));
    expect(new Set(survivors.map((row) => row.id))).toEqual(new Set([m3, m4]));
  }

  it("refuses editing another member's message (foreign anchor) — 403, no run, victim survives", async () => {
    const { attacker, conversationId, m3, m4 } = await seedCrossMemberTurn();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: m3,
        action: 'edit',
        userMessage: { content: 'hijacked' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(m3, m4);
  });

  it("refuses retry-all on another member's message (foreign anchor) — 403, no run, victim survives", async () => {
    const { attacker, conversationId, m3, m4 } = await seedCrossMemberTurn();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: m3,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(m3, m4);
  });

  it("refuses retry-one on another member's turn even with the anchor's own assistant reply — 403, no run, victim survives", async () => {
    const { attacker, conversationId, m3, m4 } = await seedCrossMemberTurn();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: m3,
        action: 'retry',
        replaceAssistantId: m4,
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(m3, m4);
  });

  /**
   * The graph a retry-one leaves behind in a fork-less group chat: the
   * co-member's reply keeps its low sequence but hangs below the FRESH reply,
   * which is the conversation's highest-sequence row and a direct child of the
   * anchor. Every ancestry walk from that tip reaches the anchor in one hop and
   * never inspects the victim, while the sequence-scoped delete would sweep it.
   */
  async function seedReparentedVictim(): Promise<{
    readonly attacker: string;
    readonly conversationId: string;
    readonly anchor: string;
    readonly victim: string;
  }> {
    await seedModel();
    const attacker = await seedUser();
    const victim = await seedUser();
    const conversationId = await seedConversation(attacker, true);
    await seedPurchasedWallet(attacker);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: victim, visibleFromEpoch: 1 });
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: attacker,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: anchor,
    });
    const fresh = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 4,
      parentMessageId: anchor,
    });
    const victimMessage = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: victim,
      sequenceNumber: 3,
      parentMessageId: fresh,
    });
    return { attacker, conversationId, anchor, victim: victimMessage };
  }

  it('refuses a retry-all whose sequence delete would sweep a re-parented co-member message — 403, no run', async () => {
    const { attacker, conversationId, anchor, victim } = await seedReparentedVictim();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(victim, anchor);
  });

  it('refuses the edit variant of that same graph — 403, no run', async () => {
    const { attacker, conversationId, anchor, victim } = await seedReparentedVictim();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'edit',
        userMessage: { content: 'edited' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(victim, anchor);
  });

  /**
   * A member who has left, been removed, or had their share link revoked keeps
   * every `messages.senderId` they wrote — only `conversation_members.leftAt`
   * moves. `listActive` therefore reports the caller alone while the delete's
   * blast radius still holds the departed member's rows.
   */
  async function seedDepartedMemberMessage(): Promise<{
    readonly attacker: string;
    readonly conversationId: string;
    readonly anchor: string;
    readonly victim: string;
  }> {
    await seedModel();
    const attacker = await seedUser();
    const departed = await seedUser();
    const conversationId = await seedConversation(attacker, true);
    await seedPurchasedWallet(attacker);
    await db.insert(conversationMembers).values({
      conversationId,
      userId: departed,
      visibleFromEpoch: 1,
      leftAt: new Date(TEST_DAY_START),
    });
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: attacker,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const victimMessage = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: departed,
      sequenceNumber: 2,
      parentMessageId: anchor,
    });
    return { attacker, conversationId, anchor, victim: victimMessage };
  }

  it("refuses a retry-all whose delete set holds a departed member's message — 403, no run", async () => {
    const { attacker, conversationId, anchor, victim } = await seedDepartedMemberMessage();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(victim, anchor);
  });

  it("refuses the edit variant over a departed member's message — 403, no run", async () => {
    const { attacker, conversationId, anchor, victim } = await seedDepartedMemberMessage();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'edit',
        userMessage: { content: 'edited' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(victim, anchor);
  });

  it("allows editing the caller's OWN message in a group turn they own (201)", async () => {
    await seedModel();
    const owner = await seedUser();
    const other = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: other, visibleFromEpoch: 1 });
    // owner(m1) → assistant(m2, tip); no co-member message after the anchor.
    const m1 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: m1,
    });

    const captured: { regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ regenerate: body.mode === 'paid' ? body.regenerate : undefined });
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: m1,
        action: 'edit',
        userMessage: { content: 'edited' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([{ regenerate: { action: 'edit', targetMessageId: m1 } }]);
  });
});
