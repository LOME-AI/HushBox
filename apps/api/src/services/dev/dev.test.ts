import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listDevPersonas, cleanupTestData, resetGuestUsage } from './dev.js';

describe('dev service', () => {
  describe('listDevPersonas', () => {
    let mockDb: {
      select: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockDb = {
        select: vi.fn(),
      };
    });

    it('returns empty array when no dev users exist', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await listDevPersonas(mockDb as never, 'dev');

      expect(result).toEqual([]);
    });

    it('returns personas with stats for dev users', async () => {
      // First call: get users
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: 'user-1',
                name: 'Test User',
                email: 'test@dev.lome-chat.test',
                emailVerified: true,
                image: null,
                balance: '10.00000000',
              },
            ]),
          }),
        })
        // Conversation count
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 5 }]),
          }),
        })
        // Message count
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 100 }]),
            }),
          }),
        })
        // Project count
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }]),
          }),
        });

      const result = await listDevPersonas(mockDb as never, 'dev');

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('Test User');
      expect(result[0]?.stats.conversationCount).toBe(5);
      expect(result[0]?.stats.messageCount).toBe(100);
      expect(result[0]?.stats.projectCount).toBe(2);
      expect(result[0]?.credits).toBe('$10.00');
    });
  });

  describe('cleanupTestData', () => {
    let mockDb: {
      select: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockDb = {
        select: vi.fn(),
        delete: vi.fn(),
      };
    });

    it('returns zeros when no test users exist', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await cleanupTestData(mockDb as never);

      expect(result).toEqual({ conversations: 0, messages: 0 });
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it('deletes messages and conversations for test users', async () => {
      // Get test users
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'test-user-1' }]),
          }),
        })
        // Get conversations for test users
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]),
          }),
        });

      // Delete messages returns rowCount
      mockDb.delete
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue({ rowCount: 10 }),
        })
        // Delete conversations
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue({ rowCount: 2 }),
        });

      const result = await cleanupTestData(mockDb as never);

      expect(result).toEqual({ conversations: 2, messages: 10 });
    });
  });

  describe('resetGuestUsage', () => {
    let mockDb: {
      delete: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockDb = {
        delete: vi.fn(),
      };
    });

    it('deletes all guest usage records and returns count', async () => {
      mockDb.delete.mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: 'record-1' }, { id: 'record-2' }, { id: 'record-3' }]),
      });

      const result = await resetGuestUsage(mockDb as never);

      expect(result).toEqual({ deleted: 3 });
    });

    it('returns zero when no guest usage records exist', async () => {
      mockDb.delete.mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      });

      const result = await resetGuestUsage(mockDb as never);

      expect(result).toEqual({ deleted: 0 });
    });
  });
});
