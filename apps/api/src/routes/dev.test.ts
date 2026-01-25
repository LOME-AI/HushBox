import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createDevRoute } from './dev.js';
import { WELCOME_CREDIT_BALANCE } from '@lome-chat/shared';
import type { DevPersonasResponse } from '@lome-chat/shared';
import type { AppEnv } from '../types.js';

interface MockUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  balance: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TestDataDeleteResponse {
  success: boolean;
  deleted: { conversations: number; messages: number };
}

interface GuestUsageResetResponse {
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
  app.route('/dev', createDevRoute());
  return app;
}

describe('createDevRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /personas', () => {
    it('returns 200 with personas array', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice Developer',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: WELCOME_CREDIT_BALANCE,
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
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice Developer',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: 'https://example.com/alice.png',
          balance: WELCOME_CREDIT_BALANCE,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]).toMatchObject({
        id: 'user-1',
        name: 'Alice Developer',
        email: 'alice@dev.lome-chat.com',
        emailVerified: true,
        image: 'https://example.com/alice.png',
      });
    });

    it('returns credits based on actual user balance', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: '1.50000000',
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
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Bob',
          email: 'bob@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: '0.00000000',
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
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'NewUser',
          email: 'newuser@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: WELCOME_CREDIT_BALANCE, // Default welcome credit
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
      const mockDb = createMockDb(
        [
          {
            id: 'user-1',
            name: 'Alice',
            email: 'alice@dev.lome-chat.com',
            emailVerified: true,
            image: null,
            balance: WELCOME_CREDIT_BALANCE,
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
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: '1.50000000',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'user-2',
          name: 'Bob',
          email: 'bob@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: '0.00000000',
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
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: WELCOME_CREDIT_BALANCE,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas?type=dev');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@dev.lome-chat.com');
    });

    it('filters by type=test to get test personas', async () => {
      const mockDb = createMockDb([
        {
          id: 'test-user-1',
          name: 'Test Alice',
          email: 'test-alice@test.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: WELCOME_CREDIT_BALANCE,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas?type=test');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@test.lome-chat.com');
    });

    it('returns dev personas by default when no type param', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          balance: WELCOME_CREDIT_BALANCE,
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
      app.route('/dev', createDevRoute());

      await app.request('/dev/test-data', { method: 'DELETE' });

      // Delete should be called twice - messages first, then conversations
      expect(mockDelete).toHaveBeenCalledTimes(2);
      expect(deleteCalls).toEqual(['messages', 'conversations']);
    });
  });

  describe('DELETE /guest-usage', () => {
    function createGuestUsageMockDb(recordsToDelete: { id: string }[]) {
      const mockDelete = vi.fn();
      const mockReturning = vi.fn();

      mockDelete.mockReturnValue({ returning: mockReturning });
      mockReturning.mockResolvedValue(recordsToDelete);

      return { delete: mockDelete };
    }

    it('returns success with count of deleted records', async () => {
      const mockDb = createGuestUsageMockDb([{ id: 'record-1' }, { id: 'record-2' }]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/guest-usage', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: GuestUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
    });

    it('returns success with zero when no records exist', async () => {
      const mockDb = createGuestUsageMockDb([]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/guest-usage', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: GuestUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });
});
