import { describe, it, expect, vi, beforeEach } from 'vitest';
import { conversations, epochs, epochMembers, conversationMembers, messages } from '@hushbox/db';
import {
  listDevPersonas,
  cleanupTestData,
  resetTrialUsage,
  resetAuthRateLimits,
  createDevGroupChat,
  setWalletBalance,
} from './dev.js';

vi.mock('../billing/index.js', () => ({
  checkUserBalance: vi.fn().mockResolvedValue({
    hasBalance: true,
    currentBalance: '10.00000000',
    freeAllowanceCents: 0,
  }),
}));

const mockCreateFirstEpoch = vi.fn();
const mockEncryptMessageForStorage = vi.fn();

vi.mock('@hushbox/crypto', () => ({
  createFirstEpoch: (...args: unknown[]) => mockCreateFirstEpoch(...args),
  encryptMessageForStorage: (...args: unknown[]) => mockEncryptMessageForStorage(...args),
}));

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
      // First call: get users (no longer includes balance - uses wallet-based checkUserBalance)
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: 'user-1',
                username: 'test_user',
                email: 'test@dev.hushbox.test',
                emailVerified: true,
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
      expect(result[0]?.username).toBe('test_user');
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

  describe('resetTrialUsage', () => {
    let mockRedis: {
      scan: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockRedis = {
        scan: vi.fn(),
        del: vi.fn().mockResolvedValue(0),
      };
    });

    it('deletes all trial usage keys and returns count', async () => {
      mockRedis.scan.mockResolvedValueOnce([
        '0',
        ['trial:token:abc', 'trial:ip:hash1', 'trial:token:def'],
      ]);

      const result = await resetTrialUsage(mockRedis as never);

      expect(result).toEqual({ deleted: 3 });
      expect(mockRedis.del).toHaveBeenCalledWith(
        'trial:token:abc',
        'trial:ip:hash1',
        'trial:token:def'
      );
    });

    it('returns zero when no trial usage keys exist', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      const result = await resetTrialUsage(mockRedis as never);

      expect(result).toEqual({ deleted: 0 });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('handles multi-page scan results', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['42', ['trial:token:abc', 'trial:ip:hash1']])
        .mockResolvedValueOnce(['0', ['trial:token:def']]);

      const result = await resetTrialUsage(mockRedis as never);

      expect(result).toEqual({ deleted: 3 });
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetAuthRateLimits', () => {
    let mockRedis: {
      scan: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockRedis = {
        scan: vi.fn(),
        del: vi.fn().mockResolvedValue(0),
      };
    });

    it('deletes auth rate limit keys across all prefixes and returns count', async () => {
      // 10 specific prefixes: ratelimit + lockout patterns only
      mockRedis.scan
        .mockResolvedValueOnce(['0', ['login:user:ratelimit:alice']]) // login:*:ratelimit:*
        .mockResolvedValueOnce(['0', ['login:lockout:alice']]) // login:lockout:*
        .mockResolvedValueOnce(['0', ['register:email:ratelimit:alice@test.com']]) // register:*:ratelimit:*
        .mockResolvedValueOnce(['0', ['2fa:user:ratelimit:user-1']]) // 2fa:*:ratelimit:*
        .mockResolvedValueOnce(['0', []]) // 2fa:lockout:*
        .mockResolvedValueOnce(['0', ['recovery:user:ratelimit:alice']]) // recovery:*:ratelimit:*
        .mockResolvedValueOnce(['0', []]) // recovery:lockout:*
        .mockResolvedValueOnce(['0', []]) // verify:*:ratelimit:*
        .mockResolvedValueOnce(['0', []]) // resend-verify:*:ratelimit:*
        .mockResolvedValueOnce(['0', ['totp:used:user-1:123456']]); // totp:used:*

      const result = await resetAuthRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 6 });
      expect(mockRedis.del).toHaveBeenCalledTimes(6);
    });

    it('returns zero when no auth rate limit keys exist', async () => {
      // All prefix scans return empty
      mockRedis.scan.mockResolvedValue(['0', []]);

      const result = await resetAuthRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 0 });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('handles multi-page scan results within a single prefix', async () => {
      mockRedis.scan
        // login:*:ratelimit:* — first page
        .mockResolvedValueOnce(['42', ['login:user:ratelimit:alice']])
        // login:*:ratelimit:* — second page
        .mockResolvedValueOnce(['0', ['login:ip:ratelimit:hash1']])
        // All other 9 prefixes empty
        .mockResolvedValue(['0', []]);

      const result = await resetAuthRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 2 });
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });
  });

  describe('createDevGroupChat', () => {
    const ALICE_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);
    const BOB_PUBLIC_KEY = new Uint8Array([5, 6, 7, 8]);
    const EPOCH_PUBLIC_KEY = new Uint8Array([10, 11, 12, 13]);
    const CONFIRMATION_HASH = new Uint8Array([20, 21, 22]);
    const ALICE_WRAP = new Uint8Array([30, 31]);
    const BOB_WRAP = new Uint8Array([40, 41]);
    const ENCRYPTED_BLOB = new Uint8Array([50, 51, 52]);

    let insertCalls: { table: unknown; values: unknown }[];

    function createGroupChatMockDb(
      userRows: {
        id: string;
        username: string;
        email: string;
        publicKey: Uint8Array;
      }[]
    ) {
      insertCalls = [];

      const mockSelect = vi.fn();
      const mockInsert = vi.fn();

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(userRows),
        }),
      });

      mockInsert.mockImplementation((table: unknown) => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertCalls.push({ table, values: vals });
          return Promise.resolve();
        }),
      }));

      const mockUpdate = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(null),
        }),
      }));

      const txMock = { select: mockSelect, insert: mockInsert, update: mockUpdate };
      return {
        select: mockSelect,
        insert: mockInsert,
        update: mockUpdate,
        transaction: vi
          .fn()
          .mockImplementation(async (function_: (tx: typeof txMock) => Promise<void>) =>
            function_(txMock)
          ),
      };
    }

    beforeEach(() => {
      mockCreateFirstEpoch.mockReset();
      mockEncryptMessageForStorage.mockReset();

      mockCreateFirstEpoch.mockReturnValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        confirmationHash: CONFIRMATION_HASH,
        memberWraps: [{ wrap: ALICE_WRAP }, { wrap: BOB_WRAP }],
      });
      mockEncryptMessageForStorage.mockReturnValue(ENCRYPTED_BLOB);
    });

    it('looks up users by email and returns conversationId and members', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      const result = await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
      });

      expect(result.conversationId).toBeDefined();
      expect(typeof result.conversationId).toBe('string');
      expect(result.members).toHaveLength(2);
      expect(result.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 'alice-id',
            username: 'alice',
            email: 'alice@test.hushbox.ai',
          }),
          expect.objectContaining({
            userId: 'bob-id',
            username: 'bob',
            email: 'bob@test.hushbox.ai',
          }),
        ])
      );
    });

    it('calls createFirstEpoch with all member public keys', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
      });

      expect(mockCreateFirstEpoch).toHaveBeenCalledWith([ALICE_PUBLIC_KEY, BOB_PUBLIC_KEY]);
    });

    it('inserts conversation, epoch, epochMembers, and conversationMembers rows', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
      });

      const tables = insertCalls.map((c) => c.table);
      expect(tables).toContain(conversations);
      expect(tables).toContain(epochs);
      expect(tables).toContain(epochMembers);
      expect(tables).toContain(conversationMembers);
    });

    it('sets owner privilege for owner and admin for other members', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
      });

      const memberInsert = insertCalls.find((c) => c.table === conversationMembers);
      const memberRows = memberInsert!.values as {
        userId: string;
        privilege: string;
        acceptedAt: Date;
      }[];

      const aliceRow = memberRows.find((r) => r.userId === 'alice-id');
      const bobRow = memberRows.find((r) => r.userId === 'bob-id');
      expect(aliceRow?.privilege).toBe('owner');
      expect(bobRow?.privilege).toBe('admin');
      expect(aliceRow?.acceptedAt).toBeInstanceOf(Date);
      expect(bobRow?.acceptedAt).toBeInstanceOf(Date);
    });

    it('encrypts and inserts messages when provided', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        messages: [
          { senderEmail: 'alice@test.hushbox.ai', content: 'Hello from Alice', senderType: 'user' },
          { content: 'Echo: Hello', senderType: 'ai' },
        ],
      });

      const msgInsert = insertCalls.find((c) => c.table === messages);
      expect(msgInsert).toBeDefined();
      expect(mockEncryptMessageForStorage).toHaveBeenCalledTimes(3);
      expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(EPOCH_PUBLIC_KEY, '');
      expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(
        EPOCH_PUBLIC_KEY,
        'Hello from Alice'
      );
      expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(EPOCH_PUBLIC_KEY, 'Echo: Hello');

      const msgRows = msgInsert!.values as {
        senderType: string;
        senderId: string | null;
        sequenceNumber: number;
      }[];
      expect(msgRows).toHaveLength(2);
      expect(msgRows[0]?.senderType).toBe('user');
      expect(msgRows[0]?.senderId).toBe('alice-id');
      expect(msgRows[0]?.sequenceNumber).toBe(1);
      expect(msgRows[1]?.senderType).toBe('ai');
      expect(msgRows[1]?.senderId).toBeNull();
      expect(msgRows[1]?.sequenceNumber).toBe(2);
    });

    it('does not insert messages when none provided', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
      });

      const msgInsert = insertCalls.find((c) => c.table === messages);
      expect(msgInsert).toBeUndefined();
      expect(mockEncryptMessageForStorage).toHaveBeenCalledTimes(1);
      expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(EPOCH_PUBLIC_KEY, '');
    });

    it('throws when owner email not found in database', async () => {
      const mockDb = createGroupChatMockDb([
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await expect(
        createDevGroupChat(mockDb as never, {
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
        })
      ).rejects.toThrow('Owner not found');
    });
  });

  describe('setWalletBalance', () => {
    function createSetWalletMockDb(options: {
      userRows: { id: string }[];
      updateRows: { id: string; balance: string }[];
    }) {
      const mockSelect = vi.fn();
      const mockUpdate = vi.fn();
      const mockInsert = vi.fn();

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(options.userRows),
        }),
      });

      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(options.updateRows),
          }),
        }),
      });

      const insertValuesSpy = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'ledger-1' }]),
      });
      mockInsert.mockReturnValue({
        values: insertValuesSpy,
      });

      return {
        db: { select: mockSelect, update: mockUpdate, insert: mockInsert },
        insertValuesSpy,
      };
    }

    it('updates wallet balance and creates ledger entry', async () => {
      const { db, insertValuesSpy } = createSetWalletMockDb({
        userRows: [{ id: 'user-1' }],
        updateRows: [{ id: 'wallet-1', balance: '10.00000000' }],
      });

      const result = await setWalletBalance(db as never, {
        email: 'test@test.hushbox.ai',
        walletType: 'purchased',
        balance: '10.00000000',
      });

      expect(result).toEqual({ newBalance: '10.00000000' });
      expect(db.update).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();

      const ledgerValues = insertValuesSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(ledgerValues['walletId']).toBe('wallet-1');
      expect(ledgerValues['balanceAfter']).toBe('10.00000000');
      expect(ledgerValues['entryType']).toBe('adjustment');
      expect(ledgerValues['sourceWalletId']).toBe('wallet-1');
    });

    it('throws when user not found', async () => {
      const { db } = createSetWalletMockDb({
        userRows: [],
        updateRows: [],
      });

      await expect(
        setWalletBalance(db as never, {
          email: 'unknown@test.hushbox.ai',
          walletType: 'purchased',
          balance: '10.00000000',
        })
      ).rejects.toThrow('User not found');
    });

    it('throws when wallet not found', async () => {
      const { db } = createSetWalletMockDb({
        userRows: [{ id: 'user-1' }],
        updateRows: [], // UPDATE returns 0 rows
      });

      await expect(
        setWalletBalance(db as never, {
          email: 'test@test.hushbox.ai',
          walletType: 'purchased',
          balance: '10.00000000',
        })
      ).rejects.toThrow('Wallet not found');
    });
  });
});
