import { describe, expect, it } from 'vitest';
import {
  MESSAGE_ROLES,
  messageRoleSchema,
  PAYMENT_STATUSES,
  paymentStatusSchema,
  BALANCE_TRANSACTION_TYPES,
  balanceTransactionTypeSchema,
} from './enums';

describe('enums', () => {
  describe('MESSAGE_ROLES', () => {
    it('contains user, assistant, and system roles', () => {
      expect(MESSAGE_ROLES).toEqual(['user', 'assistant', 'system']);
    });

    it('validates valid roles', () => {
      expect(messageRoleSchema.safeParse('user').success).toBe(true);
      expect(messageRoleSchema.safeParse('assistant').success).toBe(true);
      expect(messageRoleSchema.safeParse('system').success).toBe(true);
    });

    it('rejects invalid roles', () => {
      expect(messageRoleSchema.safeParse('admin').success).toBe(false);
      expect(messageRoleSchema.safeParse('').success).toBe(false);
      expect(messageRoleSchema.safeParse(null).success).toBe(false);
    });
  });

  describe('PAYMENT_STATUSES', () => {
    it('contains all payment statuses', () => {
      expect(PAYMENT_STATUSES).toEqual(['pending', 'awaiting_webhook', 'confirmed', 'failed']);
    });

    it('validates valid statuses', () => {
      expect(paymentStatusSchema.safeParse('pending').success).toBe(true);
      expect(paymentStatusSchema.safeParse('awaiting_webhook').success).toBe(true);
      expect(paymentStatusSchema.safeParse('confirmed').success).toBe(true);
      expect(paymentStatusSchema.safeParse('failed').success).toBe(true);
    });

    it('rejects invalid statuses', () => {
      expect(paymentStatusSchema.safeParse('processing').success).toBe(false);
      expect(paymentStatusSchema.safeParse('cancelled').success).toBe(false);
    });
  });

  describe('BALANCE_TRANSACTION_TYPES', () => {
    it('contains all transaction types', () => {
      expect(BALANCE_TRANSACTION_TYPES).toEqual(['deposit', 'usage', 'adjustment']);
    });

    it('validates valid types', () => {
      expect(balanceTransactionTypeSchema.safeParse('deposit').success).toBe(true);
      expect(balanceTransactionTypeSchema.safeParse('usage').success).toBe(true);
      expect(balanceTransactionTypeSchema.safeParse('adjustment').success).toBe(true);
    });

    it('rejects invalid types', () => {
      expect(balanceTransactionTypeSchema.safeParse('refund').success).toBe(false);
      expect(balanceTransactionTypeSchema.safeParse('withdrawal').success).toBe(false);
    });
  });
});
