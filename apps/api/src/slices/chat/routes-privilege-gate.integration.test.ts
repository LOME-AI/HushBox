// The send-privilege gate the two PAID turn routes apply: a read-only member may
// see a conversation but may not spend against it. The cheaper surfaces (guest
// send, plain message, stop) keep their own long-standing behavior and are
// pinned in their own suites.
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import {
  MODEL,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  post,
  postRegenerate,
  recordingRealtime,
  seedMessage,
  seedModel,
  seedOwnerFundedGroup,
} from '../../test-support/chat-routes.integration.setup.js';

/** Demotes an existing member to read privilege — the case demotion exists to prevent. */
async function demoteToRead(conversationId: string, userId: string): Promise<void> {
  await db
    .update(conversationMembers)
    .set({ privilege: 'read' })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId)
      )
    );
}

describe('chat paid routes: send privilege', () => {
  it('refuses a read-only member on POST /chat before the run starts', async () => {
    await seedModel();
    const { conversationId, sender } = await seedOwnerFundedGroup();
    await demoteToRead(conversationId, sender);
    const { starts, realtime } = recordingRealtime();
    const res = await post(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FORBIDDEN' });
    expect(starts).toHaveLength(0);
  });

  it('refuses a read-only member on POST /chat/regenerate before the run starts', async () => {
    await seedModel();
    const { conversationId, sender } = await seedOwnerFundedGroup();
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: sender,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    await demoteToRead(conversationId, sender);
    const { starts, realtime } = recordingRealtime();
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FORBIDDEN' });
    expect(starts).toHaveLength(0);
  });

  it('drops a demoted member mid-session, on the next request and with no reconnect', async () => {
    await seedModel();
    const { conversationId, sender } = await seedOwnerFundedGroup();
    // One session cookie, reused across both requests: the privilege is read
    // per request from the member row, never carried on the credential, so the
    // demotion takes effect without the caller reconnecting.
    const session = await cookie(sender);
    const admitted = await post(
      fakeRealtime(STARTED),
      { cookie: session, 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'while still write' },
      }
    );
    expect(admitted.status).toBe(201);

    await demoteToRead(conversationId, sender);
    const refused = await post(
      fakeRealtime(STARTED),
      { cookie: session, 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'after demotion' },
      }
    );
    expect(refused.status).toBe(403);
  });
});
