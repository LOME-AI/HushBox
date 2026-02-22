import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { devRoute } from './dev.js';
import { WELCOME_CREDIT_BALANCE } from '@hushbox/shared';
import type { DevPersonasResponse } from '@hushbox/shared';
import type { AppEnv } from '../types.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Mock checkUserBalance used by listDevPersonas (wallet-based balance)
const mockCheckUserBalance = vi.fn();
vi.mock('../services/billing/index.js', () => ({
  checkUserBalance: (...args: unknown[]) => mockCheckUserBalance(...args),
}));

const mockCreateDevGroupChat = vi.fn();
vi.mock('../services/dev/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/dev/index.js')>();
  return {
    ...original,
    createDevGroupChat: (...args: unknown[]) => mockCreateDevGroupChat(...args),
  };
});

interface MockUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface TestDataDeleteResponse {
  success: boolean;
  deleted: { conversations: number; messages: number };
}

interface TrialUsageResetResponse {
  success: boolean;
  deleted: number;
}

function createMockDb(devUsers: MockUser[], counts?: { conv: number; msg: number; proj: number }) {
  const actualCounts = counts ?? { conv: 0, msg: 0, proj: 0 };

  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockInnerJoin = vi.fn();

  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockImplementation(() => ({
    where: mockWhere,
    innerJoin: mockInnerJoin,
  }));
  mockInnerJoin.mockReturnValue({ where: mockWhere });

  let callCount = 0;
  mockWhere.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(devUsers);
    }
    const countType = (callCount - 2) % 3;
    if (countType === 0) return Promise.resolve([{ count: actualCounts.conv }]);
    if (countType === 1) return Promise.resolve([{ count: actualCounts.msg }]);
    return Promise.resolve([{ count: actualCounts.proj }]);
  });

  return { select: mockSelect };
}

function createTestAppWithMockDb(mockDb: unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', mockDb as AppEnv['Variables']['db']);
    await next();
  });
  app.route('/dev', devRoute);
  return app;
}

describe('devRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /personas', () => {
    it('returns 200 with personas array', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice_developer',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      expect(res.status).toBe(200);

      const body: DevPersonasResponse = await res.json();
      expect(body.personas).toBeDefined();
      expect(Array.isArray(body.personas)).toBe(true);
    });

    it('returns empty array when no dev users exist', async () => {
      const mockDb = createMockDb([]);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas).toEqual([]);
    });

    it('includes user fields in response', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice_developer',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]).toMatchObject({
        id: 'user-1',
        username: 'alice_developer',
        email: 'alice@dev.hushbox.ai',
        emailVerified: true,
      });
    });

    it('returns credits based on wallet balance', async () => {
      mockCheckUserBalance.mockResolvedValue({ hasBalance: true, currentBalance: '1.50000000' });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]?.credits).toBe('$1.50');
    });

    it('returns $0.00 for users with zero balance', async () => {
      mockCheckUserBalance.mockResolvedValue({ hasBalance: false, currentBalance: '0.00000000' });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'bob',
          email: 'bob@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]?.credits).toBe('$0.00');
    });

    it('returns default welcome credits for new users', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'newuser',
          email: 'newuser@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]?.credits).toBe('$0.20');
    });

    it('includes stats for each persona', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb(
        [
          {
            id: 'user-1',
            username: 'alice',
            email: 'alice@dev.hushbox.ai',
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        { conv: 3, msg: 12, proj: 2 }
      );

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      const persona = body.personas[0];
      expect(persona?.stats).toBeDefined();
      expect(typeof persona?.stats.conversationCount).toBe('number');
      expect(typeof persona?.stats.messageCount).toBe('number');
      expect(typeof persona?.stats.projectCount).toBe('number');
    });

    it('handles multiple personas', async () => {
      mockCheckUserBalance.mockResolvedValue({ hasBalance: true, currentBalance: '1.50000000' });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'user-2',
          username: 'bob',
          email: 'bob@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas).toHaveLength(2);
    });

    it('filters by type=dev (default)', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas?type=dev');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@dev.hushbox.ai');
    });

    it('filters by type=test to get test personas', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'test-user-1',
          username: 'test_alice',
          email: 'test-alice@test.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas?type=test');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@test.hushbox.ai');
    });

    it('returns dev personas by default when no type param', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');

      expect(res.status).toBe(200);
      // Default behavior should query dev domain
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('returns 400 for invalid type query parameter', async () => {
      const mockDb = createMockDb([]);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/personas?type=invalid');

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /test-data', () => {
    function createDeleteMockDb(options: {
      testUsers: { id: string }[];
      conversations: { id: string }[];
      deleteMessagesRowCount?: number;
      deleteConversationsRowCount?: number;
    }) {
      const mockSelect = vi.fn();
      const mockFrom = vi.fn();
      const mockWhere = vi.fn();
      const mockDelete = vi.fn();
      const mockDeleteWhere = vi.fn();

      let selectCallCount = 0;
      mockSelect.mockReturnValue({ from: mockFrom });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve(options.testUsers);
        }
        return Promise.resolve(options.conversations);
      });

      let deleteCallCount = 0;
      mockDelete.mockReturnValue({ where: mockDeleteWhere });
      mockDeleteWhere.mockImplementation(() => {
        deleteCallCount++;
        if (deleteCallCount === 1) {
          return Promise.resolve({ rowCount: options.deleteMessagesRowCount ?? 0 });
        }
        return Promise.resolve({ rowCount: options.deleteConversationsRowCount ?? 0 });
      });

      return { select: mockSelect, delete: mockDelete };
    }

    it('returns success with zero counts when no test users exist', async () => {
      const mockDb = createDeleteMockDb({
        testUsers: [],
        conversations: [],
      });

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/test-data', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TestDataDeleteResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted.conversations).toBe(0);
      expect(body.deleted.messages).toBe(0);
    });

    it('returns success with zero counts when test users have no conversations', async () => {
      const mockDb = createDeleteMockDb({
        testUsers: [{ id: 'test-user-1' }],
        conversations: [],
      });

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/test-data', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TestDataDeleteResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted.conversations).toBe(0);
      expect(body.deleted.messages).toBe(0);
    });

    it('deletes messages and conversations for test users', async () => {
      const mockDb = createDeleteMockDb({
        testUsers: [{ id: 'test-user-1' }, { id: 'test-user-2' }],
        conversations: [{ id: 'conv-1' }, { id: 'conv-2' }],
        deleteMessagesRowCount: 5,
        deleteConversationsRowCount: 2,
      });

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/test-data', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TestDataDeleteResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted.messages).toBe(5);
      expect(body.deleted.conversations).toBe(2);
    });

    it('calls delete on messages before conversations (FK constraint)', async () => {
      const deleteCalls: string[] = [];
      const mockSelect = vi.fn();
      const mockFrom = vi.fn();
      const mockWhere = vi.fn();
      const mockDelete = vi.fn();
      const mockDeleteWhere = vi.fn();

      mockSelect.mockReturnValue({ from: mockFrom });
      mockFrom.mockReturnValue({ where: mockWhere });

      let selectCallCount = 0;
      mockWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve([{ id: 'test-user-1' }]);
        }
        return Promise.resolve([{ id: 'conv-1' }]);
      });

      mockDelete.mockImplementation((table: Record<string, unknown>) => {
        // Track which table is being deleted from based on the table object
        const tableName = Object.keys(table).includes('conversationId')
          ? 'messages'
          : 'conversations';
        deleteCalls.push(tableName);
        return { where: mockDeleteWhere };
      });
      mockDeleteWhere.mockResolvedValue({ rowCount: 1 });

      const mockDb = { select: mockSelect, delete: mockDelete };
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', devRoute);

      await app.request('/dev/test-data', { method: 'DELETE' });

      // Delete should be called twice - messages first, then conversations
      expect(mockDelete).toHaveBeenCalledTimes(2);
      expect(deleteCalls).toEqual(['messages', 'conversations']);
    });
  });

  describe('GET /verify-token/:email', () => {
    function createVerifyTokenMockDb(user: { emailVerifyToken: string | null } | null) {
      const mockSelect = vi.fn();
      const mockFrom = vi.fn();
      const mockWhere = vi.fn();

      mockSelect.mockReturnValue({ from: mockFrom });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockWhere.mockResolvedValue(user ? [user] : []);

      return { select: mockSelect };
    }

    it('returns token for user with pending verification', async () => {
      const mockDb = createVerifyTokenMockDb({ emailVerifyToken: 'test-token-123' });
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/test@example.com');

      expect(res.status).toBe(200);
      const body = await jsonBody<{ token: string }>(res);
      expect(body.token).toBe('test-token-123');
    });

    it('returns 404 when user not found', async () => {
      const mockDb = createVerifyTokenMockDb(null);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/nonexistent@example.com');

      expect(res.status).toBe(404);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 404 when user has no verify token', async () => {
      const mockDb = createVerifyTokenMockDb({ emailVerifyToken: null });
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/verified@example.com');

      expect(res.status).toBe(404);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 400 for invalid email format', async () => {
      const mockDb = createVerifyTokenMockDb(null);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/not-an-email');

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /trial-usage', () => {
    function createTrialUsageApp(keys: string[]) {
      const mockRedis = {
        scan: vi.fn().mockResolvedValue(['0', keys]),
        del: vi.fn().mockResolvedValue(keys.length),
      };

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('db', {} as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', devRoute);
      return app;
    }

    it('returns success with count of deleted keys', async () => {
      const app = createTrialUsageApp(['trial:token:abc', 'trial:ip:hash1']);
      const res = await app.request('/dev/trial-usage', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
    });

    it('returns success with zero when no keys exist', async () => {
      const app = createTrialUsageApp([]);
      const res = await app.request('/dev/trial-usage', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });

  describe('DELETE /auth-rate-limits', () => {
    function createAuthRateLimitsApp(keys: string[]) {
      const mockRedis = {
        scan: vi.fn().mockResolvedValue(['0', keys]),
        del: vi.fn().mockResolvedValue(keys.length),
      };

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('db', {} as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', devRoute);
      return { app, mockRedis };
    }

    it('returns success with count of deleted keys', async () => {
      const { app } = createAuthRateLimitsApp([
        'login:user:ratelimit:alice',
        'login:lockout:alice',
      ]);
      const res = await app.request('/dev/auth-rate-limits', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(typeof body.deleted).toBe('number');
    });

    it('returns success with zero when no keys exist', async () => {
      const { app } = createAuthRateLimitsApp([]);
      const res = await app.request('/dev/auth-rate-limits', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });

  describe('POST /group-chat', () => {
    function createGroupChatApp() {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', {} as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', devRoute);
      return app;
    }

    beforeEach(() => {
      mockCreateDevGroupChat.mockReset();
    });

    it('returns 201 with conversationId and members on success', async () => {
      mockCreateDevGroupChat.mockResolvedValue({
        conversationId: 'conv-123',
        members: [
          { userId: 'alice-id', username: 'alice', email: 'alice@test.hushbox.ai' },
          { userId: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai' },
        ],
      });

      const app = createGroupChatApp();
      const res = await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
        }),
      });

      expect(res.status).toBe(201);
      const body = await jsonBody<{ conversationId: string; members: unknown[] }>(res);
      expect(body.conversationId).toBe('conv-123');
      expect(body.members).toHaveLength(2);
    });

    it('passes messages to service when provided', async () => {
      mockCreateDevGroupChat.mockResolvedValue({
        conversationId: 'conv-456',
        members: [],
      });

      const app = createGroupChatApp();
      await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
          messages: [
            { senderEmail: 'alice@test.hushbox.ai', content: 'Hello', senderType: 'user' },
            { content: 'Echo: Hello', senderType: 'ai' },
          ],
        }),
      });

      expect(mockCreateDevGroupChat).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
          messages: [
            { senderEmail: 'alice@test.hushbox.ai', content: 'Hello', senderType: 'user' },
            { content: 'Echo: Hello', senderType: 'ai' },
          ],
        })
      );
    });

    it('returns 400 when ownerEmail is missing', async () => {
      const app = createGroupChatApp();
      const res = await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberEmails: ['bob@test.hushbox.ai'],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when memberEmails is missing', async () => {
      const app = createGroupChatApp();
      const res = await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
