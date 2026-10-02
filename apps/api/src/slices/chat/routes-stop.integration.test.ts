// POST /chat/stop: who may stop a run — members and link guests — the
// revocation, expiry and privilege edges of that permission, and the caller
// principal the route hands to the room, which authorizes it against the live
// run there.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { conversationMembers, sharedLinks } from '@hushbox/db';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { forbiddenError, unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createBillingStores } from '../billing/index.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import { createChatManifest } from './index.js';
import { LINK_CREDENTIAL_HEADER } from './domain/index.js';
import {
  STARTED,
  cookie,
  db,
  fakeRealtime,
  postPath,
  seedConversation,
  seedGuestLink,
  seedUser,
  testEnv,
} from '../../test-support/chat-routes.integration.setup.js';
import type { createConversationsStores } from '../conversations/index.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { SenderPrincipal } from '@hushbox/shared';

describe('chat route: POST /chat/stop', () => {
  it('rejects an anonymous request', async () => {
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED),
      { 'Idempotency-Key': 'k1' },
      {
        conversationId: crypto.randomUUID(),
      }
    );
    expect(res.status).toBe(401);
  });

  it('requires an Idempotency-Key', async () => {
    const userId = await seedUser();
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED),
      { cookie: await cookie(userId) },
      { conversationId: crypto.randomUUID() }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, false);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(403);
  });

  it('settles the run for a member and reports the stop result', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
  });

  it('reports no active run for a member when nothing was running', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(false) }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: false });
  });

  it("forwards the session member's principal so the room can authorize the stop", async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    let caller: SenderPrincipal | undefined;
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, {
        stopRun: (_conversationId, principal) => {
          caller = principal;
          return okAsync(true);
        },
      }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
    expect(caller).toEqual({ kind: 'user', userId });
  });

  it("forwards the link guest's principal so the room can authorize the stop", async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    let caller: SenderPrincipal | undefined;
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, {
        stopRun: (_conversationId, principal) => {
          caller = principal;
          return okAsync(true);
        },
      }),
      { [LINK_CREDENTIAL_HEADER]: guest.credential, 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
    expect(caller).toEqual({ kind: 'linkGuest', linkId: guest.linkId });
  });

  it('refuses with 403 when the room rejects the caller as neither sender nor payer', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, {
        stopRun: () => errAsync(forbiddenError('caller may not stop this run')),
      }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(403);
  });

  it('maps a realtime transport failure to 503', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, {
        stopRun: () => errAsync(unavailableError('conversation room unreachable')),
      }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(503);
  });

  it('maps a membership store failure to 503', async () => {
    const userId = await seedUser();
    const failingConversations = (() => ({
      members: new Proxy(
        {},
        { get: () => () => errAsync(unavailableError('membership store down')) }
      ),
    })) as unknown as typeof createConversationsStores;
    const manifest = createChatManifest({
      conversations: failingConversations,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat/stop',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ conversationId: crypto.randomUUID() }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
  });

  it('stops the run for a WRITE link guest holding only the link credential', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { [LINK_CREDENTIAL_HEADER]: guest.credential, 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
  });

  // Double-gated: the typed conversation match and the active-member lookup each
  // refuse this alone, so it goes red only when BOTH are removed (probe-verified).
  it('refuses a link guest of conversation A stopping conversation B', async () => {
    const ownerId = await seedUser();
    const conversationA = await seedConversation(ownerId, false);
    const conversationB = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationA, { privilege: 'write' });
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { [LINK_CREDENTIAL_HEADER]: guest.credential, 'Idempotency-Key': crypto.randomUUID() },
      { conversationId: conversationB }
    );
    expect(res.status).toBe(403);
  });

  it('refuses a link guest whose member row is marked left', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write', leftAt: true });
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { [LINK_CREDENTIAL_HEADER]: guest.credential, 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(403);
  });

  it('refuses a READ-only link guest, which could never have started the run', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'read' });
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { [LINK_CREDENTIAL_HEADER]: guest.credential, 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(403);
  });

  it('refuses a link guest whose link is revoked', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await db
      .update(sharedLinks)
      .set({ revokedAt: new Date() })
      .where(eq(sharedLinks.id, guest.linkId));
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { [LINK_CREDENTIAL_HEADER]: guest.credential, 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(401);
  });

  it('refuses a link guest whose link has expired', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await db
      .update(sharedLinks)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sharedLinks.id, guest.linkId));
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { [LINK_CREDENTIAL_HEADER]: guest.credential, 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(401);
  });

  it('keeps a READ-privileged session member able to stop a run started before demotion', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: ownerId, privilege: 'read', visibleFromEpoch: 1 });
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { cookie: await cookie(ownerId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
  });
});
