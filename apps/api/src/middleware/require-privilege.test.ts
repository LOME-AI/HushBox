import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { toBase64 } from '@hushbox/shared';
import type { MemberPrivilege } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';
import { requirePrivilege } from './require-privilege.js';

const TEST_USER_ID = 'user-priv-123';
const TEST_CONVERSATION_ID = 'conv-priv-456';
const TEST_MEMBER_ID = 'member-priv-789';
const TEST_LINK_ID = 'link-priv-101';
const TEST_LINK_PUBLIC_KEY = new Uint8Array([10, 20, 30, 40, 50]);

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

function createMockUser(): AppEnv['Variables']['user'] {
  return {
    id: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    publicKey: new Uint8Array(32),
  };
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createMockDb(
  memberRow: { id: string; privilege: string; visibleFromEpoch: number } | null
): unknown {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            then: (resolve: (v: unknown[]) => unknown) => {
              const result = memberRow ? [memberRow] : [];
              return Promise.resolve(resolve(result));
            },
          }),
        }),
      }),
    }),
  };
}
/* eslint-enable unicorn/no-thenable */

interface TestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  memberRow?: { id: string; privilege: string; visibleFromEpoch: number } | null;
  minLevel: MemberPrivilege;
}

function createTestApp(options: TestAppOptions): Hono<AppEnv> {
  const { user = createMockUser(), memberRow = null, minLevel } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createMockDb(memberRow) as AppEnv['Variables']['db']);
    await next();
  });

  app.get('/:conversationId/test', requirePrivilege(minLevel), (c) => {
    const member = c.get('member');
    const callerId = c.get('callerId');
    return c.json({ member, callerId }, 200);
  });

  return app;
}

describe('requirePrivilege middleware', () => {
  describe('membership check', () => {
    it('returns 404 when user is not a member of the conversation', async () => {
      const app = createTestApp({ memberRow: null, minLevel: 'read' });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });
  });

  describe('privilege checks', () => {
    it('returns 403 when member has insufficient privilege (read trying admin-level)', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 },
        minLevel: 'admin',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 403 when member has insufficient privilege (write trying admin-level)', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 1 },
        minLevel: 'admin',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });
  });

  describe('sets member and callerId on context when privilege is sufficient', () => {
    it('sets member with correct fields when privilege check passes', async () => {
      const memberRow = { id: TEST_MEMBER_ID, privilege: 'admin', visibleFromEpoch: 3 };
      const app = createTestApp({ memberRow, minLevel: 'read' });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        member: { id: string; privilege: string; visibleFromEpoch: number };
      }>();
      expect(body.member).toEqual({
        id: TEST_MEMBER_ID,
        privilege: 'admin',
        visibleFromEpoch: 3,
      });
    });

    it('sets callerId to user.id for authenticated users', async () => {
      const memberRow = { id: TEST_MEMBER_ID, privilege: 'admin', visibleFromEpoch: 1 };
      const app = createTestApp({ memberRow, minLevel: 'read' });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
      const body = await res.json<{ callerId: string }>();
      expect(body.callerId).toBe(TEST_USER_ID);
    });
  });

  describe('requirePrivilege("read") level', () => {
    it('allows read privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 },
        minLevel: 'read',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });

    it('allows write privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 1 },
        minLevel: 'read',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });

    it('allows admin privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'admin', visibleFromEpoch: 1 },
        minLevel: 'read',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });

    it('allows owner privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'owner', visibleFromEpoch: 1 },
        minLevel: 'read',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });
  });

  describe('requirePrivilege("write") level', () => {
    it('rejects read privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 },
        minLevel: 'write',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
    });

    it('allows write privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 1 },
        minLevel: 'write',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });

    it('allows admin privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'admin', visibleFromEpoch: 1 },
        minLevel: 'write',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });

    it('allows owner privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'owner', visibleFromEpoch: 1 },
        minLevel: 'write',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });
  });

  describe('requirePrivilege("admin") level', () => {
    it('rejects read privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 },
        minLevel: 'admin',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
    });

    it('rejects write privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 1 },
        minLevel: 'admin',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
    });

    it('allows admin privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'admin', visibleFromEpoch: 1 },
        minLevel: 'admin',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });

    it('allows owner privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'owner', visibleFromEpoch: 1 },
        minLevel: 'admin',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });
  });

  describe('requirePrivilege("owner") level', () => {
    it('rejects read privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 },
        minLevel: 'owner',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
    });

    it('rejects write privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 1 },
        minLevel: 'owner',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
    });

    it('rejects admin privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'admin', visibleFromEpoch: 1 },
        minLevel: 'owner',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(403);
    });

    it('allows owner privilege', async () => {
      const app = createTestApp({
        memberRow: { id: TEST_MEMBER_ID, privilege: 'owner', visibleFromEpoch: 1 },
        minLevel: 'owner',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
    });
  });

  describe('allowLinkGuest option', () => {
    /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
    function createMockDbForLinkGuest(
      sharedLinkRow: { id: string } | null,
      linkMemberRow: { id: string; privilege: string; visibleFromEpoch: number } | null
    ): unknown {
      let queryCount = 0;
      return {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: sharedLinks (findActiveSharedLink)
                    const result = sharedLinkRow ? [sharedLinkRow] : [];
                    return Promise.resolve(resolve(result));
                  }
                  // Second query: conversationMembers by linkId
                  const result = linkMemberRow ? [linkMemberRow] : [];
                  return Promise.resolve(resolve(result));
                },
              }),
            }),
          }),
        }),
      };
    }
    /* eslint-enable unicorn/no-thenable */

    function createLinkGuestTestApp(options: {
      minLevel: MemberPrivilege;
      sharedLinkRow?: { id: string } | null;
      linkMemberRow?: { id: string; privilege: string; visibleFromEpoch: number } | null;
    }): Hono<AppEnv> {
      const { minLevel, sharedLinkRow = null, linkMemberRow = null } = options;
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', null);
        c.set('session', null);
        c.set('sessionData', null);
        c.set('linkGuest', null);
        const db = createMockDbForLinkGuest(sharedLinkRow, linkMemberRow);
        c.set('db', db as AppEnv['Variables']['db']);
        await next();
      });

      app.get(
        '/:conversationId/test',
        requirePrivilege(minLevel, { allowLinkGuest: true }),
        (c) => {
          const member = c.get('member');
          const linkGuest = c.get('linkGuest');
          const callerId = c.get('callerId');
          return c.json(
            { member, linkGuest: linkGuest ? { linkId: linkGuest.linkId } : null, callerId },
            200
          );
        }
      );

      return app;
    }

    it('returns 401 when no user and no link header provided', async () => {
      const app = createLinkGuestTestApp({ minLevel: 'read' });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 401 when no user and shared link not found', async () => {
      const app = createLinkGuestTestApp({
        minLevel: 'read',
        sharedLinkRow: null,
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 when no user and member row not found for shared link', async () => {
      const app = createLinkGuestTestApp({
        minLevel: 'read',
        sharedLinkRow: { id: TEST_LINK_ID },
        linkMemberRow: null,
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(401);
    });

    it('sets member and linkGuest on context when link guest resolves with sufficient privilege', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 2 };
      const app = createLinkGuestTestApp({
        minLevel: 'read',
        sharedLinkRow: { id: TEST_LINK_ID },
        linkMemberRow,
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        member: { id: string; privilege: string; visibleFromEpoch: number };
        linkGuest: { linkId: string } | null;
      }>();
      expect(body.member).toEqual(linkMemberRow);
      expect(body.linkGuest).toEqual({ linkId: TEST_LINK_ID });
    });

    it('sets callerId to linkId for link guests', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 2 };
      const app = createLinkGuestTestApp({
        minLevel: 'read',
        sharedLinkRow: { id: TEST_LINK_ID },
        linkMemberRow,
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ callerId: string }>();
      expect(body.callerId).toBe(TEST_LINK_ID);
    });

    it('returns 403 when link guest has insufficient privilege', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 };
      const app = createLinkGuestTestApp({
        minLevel: 'write',
        sharedLinkRow: { id: TEST_LINK_ID },
        linkMemberRow,
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 401 when allowLinkGuest is false and no user', async () => {
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', null);
        c.set('session', null);
        c.set('sessionData', null);
        c.set('linkGuest', null);
        c.set('db', createMockDb(null) as AppEnv['Variables']['db']);
        await next();
      });

      app.get('/:conversationId/test', requirePrivilege('read'), (c) => c.json({ ok: true }, 200));

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(401);
    });

    it('resolves as link guest when link key is present and allowLinkGuest is true', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 2 };

      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      let queryCount = 0;
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: sharedLinks (findActiveSharedLink)
                    return Promise.resolve(resolve([{ id: TEST_LINK_ID }]));
                  }
                  // Second query: conversationMembers by linkId
                  return Promise.resolve(resolve([linkMemberRow]));
                },
              }),
            }),
          }),
        }),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('linkGuest', null);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.get('/:conversationId/test', requirePrivilege('read', { allowLinkGuest: true }), (c) => {
        const member = c.get('member');
        const linkGuest = c.get('linkGuest');
        const callerId = c.get('callerId');
        return c.json(
          { member, linkGuest: linkGuest ? { linkId: linkGuest.linkId } : null, callerId },
          200
        );
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        member: { id: string; privilege: string; visibleFromEpoch: number };
        linkGuest: { linkId: string } | null;
        callerId: string;
      }>();
      expect(body.member).toEqual(linkMemberRow);
      expect(body.linkGuest).toEqual({ linkId: TEST_LINK_ID });
      expect(body.callerId).toBe(TEST_LINK_ID);
    });

    it('returns 404 when user not a member, allowLinkGuest true, but link resolution fails', async () => {
      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      let queryCount = 0;
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: conversationMembers for user — not found
                    return Promise.resolve(resolve([]));
                  }
                  // Second query: sharedLinks (findActiveSharedLink) — not found
                  return Promise.resolve(resolve([]));
                },
              }),
            }),
          }),
        }),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('linkGuest', null);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.get('/:conversationId/test', requirePrivilege('read', { allowLinkGuest: true }), (c) =>
        c.json({ ok: true }, 200)
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 403 when link guest resolves but privilege insufficient', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 };

      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      let queryCount = 0;
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: sharedLinks (findActiveSharedLink)
                    return Promise.resolve(resolve([{ id: TEST_LINK_ID }]));
                  }
                  // Second query: conversationMembers by linkId
                  return Promise.resolve(resolve([linkMemberRow]));
                },
              }),
            }),
          }),
        }),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('linkGuest', null);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.get('/:conversationId/test', requirePrivilege('write', { allowLinkGuest: true }), (c) =>
        c.json({ ok: true }, 200)
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('prioritizes link guest over session user when link key is present', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 2 };

      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      let queryCount = 0;
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: sharedLinks (findActiveSharedLink)
                    return Promise.resolve(resolve([{ id: TEST_LINK_ID }]));
                  }
                  // Second query: conversationMembers by linkId
                  return Promise.resolve(resolve([linkMemberRow]));
                },
              }),
            }),
          }),
        }),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('linkGuest', null);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.get('/:conversationId/test', requirePrivilege('read', { allowLinkGuest: true }), (c) => {
        const member = c.get('member');
        const linkGuest = c.get('linkGuest');
        return c.json({ member, linkGuest: linkGuest ? { linkId: linkGuest.linkId } : null }, 200);
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        member: { id: string; privilege: string };
        linkGuest: { linkId: string } | null;
      }>();
      // Link guest path should be used when link key is present
      expect(body.member.id).toBe(TEST_MEMBER_ID);
      expect(body.linkGuest).toEqual({ linkId: TEST_LINK_ID });
    });
  });

  describe('includeOwnerId option', () => {
    const TEST_OWNER_USER_ID = 'owner-user-456';

    /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
    function createMockDbWithOwner(
      memberRow: { id: string; privilege: string; visibleFromEpoch: number } | null,
      conversationRow: { userId: string } | null
    ): unknown {
      let queryCount = 0;
      return {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: conversationMembers
                    const result = memberRow ? [memberRow] : [];
                    return Promise.resolve(resolve(result));
                  }
                  // Second query: conversations (for ownerId)
                  const result = conversationRow ? [conversationRow] : [];
                  return Promise.resolve(resolve(result));
                },
              }),
            }),
          }),
        }),
      };
    }
    /* eslint-enable unicorn/no-thenable */

    function createOwnerIdTestApp(options: {
      memberRow?: { id: string; privilege: string; visibleFromEpoch: number } | null;
      conversationRow?: { userId: string } | null;
      minLevel: MemberPrivilege;
    }): Hono<AppEnv> {
      const { memberRow = null, conversationRow = null, minLevel } = options;
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('db', createMockDbWithOwner(memberRow, conversationRow) as AppEnv['Variables']['db']);
        await next();
      });

      app.get(
        '/:conversationId/test',
        requirePrivilege(minLevel, { includeOwnerId: true }),
        (c) => {
          const member = c.get('member');
          const callerId = c.get('callerId');
          const conversationOwnerId = c.get('conversationOwnerId');
          return c.json({ member, callerId, conversationOwnerId }, 200);
        }
      );

      return app;
    }

    it('sets conversationOwnerId on context when includeOwnerId is true', async () => {
      const memberRow = { id: TEST_MEMBER_ID, privilege: 'owner', visibleFromEpoch: 1 };
      const app = createOwnerIdTestApp({
        memberRow,
        conversationRow: { userId: TEST_OWNER_USER_ID },
        minLevel: 'read',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
      const body = await res.json<{ conversationOwnerId: string }>();
      expect(body.conversationOwnerId).toBe(TEST_OWNER_USER_ID);
    });

    it('returns 404 when conversation not found during owner lookup', async () => {
      const memberRow = { id: TEST_MEMBER_ID, privilege: 'owner', visibleFromEpoch: 1 };
      const app = createOwnerIdTestApp({
        memberRow,
        conversationRow: null,
        minLevel: 'read',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('still sets member and callerId alongside conversationOwnerId', async () => {
      const memberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 3 };
      const app = createOwnerIdTestApp({
        memberRow,
        conversationRow: { userId: TEST_OWNER_USER_ID },
        minLevel: 'read',
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        member: { id: string; privilege: string; visibleFromEpoch: number };
        callerId: string;
        conversationOwnerId: string;
      }>();
      expect(body.member).toEqual(memberRow);
      expect(body.callerId).toBe(TEST_USER_ID);
      expect(body.conversationOwnerId).toBe(TEST_OWNER_USER_ID);
    });

    it('does not set conversationOwnerId when includeOwnerId is false', async () => {
      const memberRow = { id: TEST_MEMBER_ID, privilege: 'owner', visibleFromEpoch: 1 };
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('db', createMockDb(memberRow) as AppEnv['Variables']['db']);
        await next();
      });

      app.get('/:conversationId/test', requirePrivilege('read'), (c) => {
        const conversationOwnerId = c.get('conversationOwnerId');
        return c.json({ conversationOwnerId }, 200);
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

      expect(res.status).toBe(200);
      const body = await res.json<{ conversationOwnerId: string | null }>();
      expect(body.conversationOwnerId).toBeUndefined();
    });

    it('sets conversationOwnerId when link key present and link guest resolves with includeOwnerId', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 2 };

      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      let queryCount = 0;
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: sharedLinks (findActiveSharedLink)
                    return Promise.resolve(resolve([{ id: TEST_LINK_ID }]));
                  }
                  if (queryCount === 2) {
                    // Second query: conversationMembers by linkId
                    return Promise.resolve(resolve([linkMemberRow]));
                  }
                  // Third query: conversations (for ownerId)
                  return Promise.resolve(resolve([{ userId: TEST_OWNER_USER_ID }]));
                },
              }),
            }),
          }),
        }),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('linkGuest', null);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.get(
        '/:conversationId/test',
        requirePrivilege('read', { allowLinkGuest: true, includeOwnerId: true }),
        (c) => {
          const conversationOwnerId = c.get('conversationOwnerId');
          const linkGuest = c.get('linkGuest');
          return c.json(
            {
              conversationOwnerId,
              linkGuest: linkGuest ? { linkId: linkGuest.linkId } : null,
            },
            200
          );
        }
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        conversationOwnerId: string;
        linkGuest: { linkId: string } | null;
      }>();
      expect(body.conversationOwnerId).toBe(TEST_OWNER_USER_ID);
      expect(body.linkGuest).toEqual({ linkId: TEST_LINK_ID });
    });

    it('sets conversationOwnerId for link guest path when includeOwnerId is true', async () => {
      const linkMemberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 2 };

      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      let queryCount = 0;
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                then: (resolve: (v: unknown[]) => unknown) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // First query: sharedLinks
                    return Promise.resolve(resolve([{ id: TEST_LINK_ID }]));
                  }
                  if (queryCount === 2) {
                    // Second query: conversationMembers by linkId
                    return Promise.resolve(resolve([linkMemberRow]));
                  }
                  // Third query: conversations (for ownerId)
                  return Promise.resolve(resolve([{ userId: TEST_OWNER_USER_ID }]));
                },
              }),
            }),
          }),
        }),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.set('user', null);
        c.set('session', null);
        c.set('sessionData', null);
        c.set('linkGuest', null);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.get(
        '/:conversationId/test',
        requirePrivilege('read', { allowLinkGuest: true, includeOwnerId: true }),
        (c) => {
          const conversationOwnerId = c.get('conversationOwnerId');
          const linkGuest = c.get('linkGuest');
          return c.json(
            {
              conversationOwnerId,
              linkGuest: linkGuest ? { linkId: linkGuest.linkId } : null,
            },
            200
          );
        }
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
        headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        conversationOwnerId: string;
        linkGuest: { linkId: string } | null;
      }>();
      expect(body.conversationOwnerId).toBe(TEST_OWNER_USER_ID);
      expect(body.linkGuest).toEqual({ linkId: TEST_LINK_ID });
    });
  });
});
