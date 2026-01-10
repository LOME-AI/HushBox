import { describe, expect, it, vi, beforeEach } from 'vitest';
import { creditUserBalance, processWebhookCredit } from './transaction-writer';

describe('transaction-writer', () => {
  describe('creditUserBalance', () => {
    let mockTx: {
      update: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
    };
    let mockDb: {
      transaction: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockTx = {
        update: vi.fn(),
        insert: vi.fn(),
      };

      mockDb = {
        transaction: vi
          .fn()
          .mockImplementation((callback: (tx: typeof mockTx) => Promise<unknown>) =>
            callback(mockTx)
          ),
      };
    });

    it('credits user balance and creates transaction record', async () => {
      // First update: claim payment (returns payment)
      // Second update: update user balance (returns user)
      mockTx.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'payment-123' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ balance: '110.00000000' }]),
            }),
          }),
        });

      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'tx-123' }]),
        }),
      });

      const result = await creditUserBalance(mockDb as never, {
        userId: 'user-123',
        amount: '10.00000000',
        paymentId: 'payment-123',
        description: 'Deposit of $10.00',
        transactionDetails: {
          helcimTransactionId: 'helcim-123',
          cardType: 'Visa',
          cardLastFour: '4242',
        },
      });

      expect(result?.newBalance).toBe('110.00000000');
      expect(result?.transactionId).toBe('tx-123');
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it('returns null when payment already confirmed (idempotent)', async () => {
      // Payment claim returns empty (already confirmed)
      mockTx.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await creditUserBalance(mockDb as never, {
        userId: 'user-123',
        amount: '10.00000000',
        paymentId: 'payment-123',
        description: 'Deposit of $10.00',
      });

      expect(result).toBeNull();
    });

    it('throws error when user update fails', async () => {
      // Payment claim succeeds
      // User update returns empty
      mockTx.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'payment-123' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      await expect(
        creditUserBalance(mockDb as never, {
          userId: 'user-123',
          amount: '10.00000000',
          paymentId: 'payment-123',
          description: 'Deposit of $10.00',
        })
      ).rejects.toThrow('Failed to update user balance');
    });

    it('throws error when transaction insert fails', async () => {
      mockTx.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'payment-123' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ balance: '110.00000000' }]),
            }),
          }),
        });

      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(
        creditUserBalance(mockDb as never, {
          userId: 'user-123',
          amount: '10.00000000',
          paymentId: 'payment-123',
          description: 'Deposit of $10.00',
        })
      ).rejects.toThrow('Failed to create balance transaction');
    });
  });

  describe('processWebhookCredit', () => {
    let mockTx: {
      update: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
    };
    let mockDb: {
      transaction: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockTx = {
        update: vi.fn(),
        insert: vi.fn(),
      };

      mockDb = {
        transaction: vi
          .fn()
          .mockImplementation((callback: (tx: typeof mockTx) => Promise<unknown>) =>
            callback(mockTx)
          ),
      };
    });

    it('processes webhook and credits user balance', async () => {
      mockTx.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([
                  { id: 'payment-123', userId: 'user-123', amount: '10.00000000' },
                ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ balance: '110.00000000' }]),
            }),
          }),
        });

      mockTx.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'tx-123' }]),
        }),
      });

      const result = await processWebhookCredit(mockDb as never, {
        helcimTransactionId: 'helcim-123',
      });

      expect(result?.newBalance).toBe('110.00000000');
      expect(result?.transactionId).toBe('tx-123');
      expect(result?.paymentId).toBe('payment-123');
    });

    it('returns null when payment not found (idempotent)', async () => {
      mockTx.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await processWebhookCredit(mockDb as never, {
        helcimTransactionId: 'non-existent',
      });

      expect(result).toBeNull();
    });

    it('throws error when user update fails', async () => {
      mockTx.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([
                  { id: 'payment-123', userId: 'user-123', amount: '10.00000000' },
                ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      await expect(
        processWebhookCredit(mockDb as never, {
          helcimTransactionId: 'helcim-123',
        })
      ).rejects.toThrow('Failed to update user balance');
    });
  });
});
