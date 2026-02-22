import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';
import { requirePrivilege } from './require-privilege.js';

const TEST_USER_ID = 'user-priv-123';
const TEST_CONVERSATION_ID = 'conv-priv-456';
const TEST_MEMBER_ID = 'member-priv-789';

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
  minLevel: 'read' | 'write' | 'admin' | 'owner';
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
    return c.json({ member }, 200);
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
      expect(body.code).toBe('NOT_FOUND');
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

  describe('sets member on context when privilege is sufficient', () => {
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
});
