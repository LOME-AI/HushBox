import { describe, it, expect } from 'vitest';
import { canUserSendMessage } from './can-send.js';
import type { UserTierInfo } from '@lome-chat/shared';

describe('canUserSendMessage', () => {
  describe('with paid user', () => {
    const paidUser: UserTierInfo = {
      tier: 'paid',
      canAccessPremium: true,
      balanceCents: 1000,
      freeAllowanceCents: 0,
    };

    it('allows sending to basic model', () => {
      const result = canUserSendMessage(paidUser, false);
      expect(result.canSend).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows sending to premium model', () => {
      const result = canUserSendMessage(paidUser, true);
      expect(result.canSend).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('with free user', () => {
    const freeUser: UserTierInfo = {
      tier: 'free',
      canAccessPremium: false,
      balanceCents: 0,
      freeAllowanceCents: 500,
    };

    it('allows sending to basic model', () => {
      const result = canUserSendMessage(freeUser, false);
      expect(result.canSend).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('denies sending to premium model with reason', () => {
      const result = canUserSendMessage(freeUser, true);
      expect(result.canSend).toBe(false);
      expect(result.reason).toBe('premium_requires_balance');
    });
  });

  describe('with guest', () => {
    const guest: UserTierInfo = {
      tier: 'guest',
      canAccessPremium: false,
      balanceCents: 0,
      freeAllowanceCents: 0,
    };

    it('allows sending to basic model', () => {
      const result = canUserSendMessage(guest, false);
      expect(result.canSend).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('denies sending to premium model with reason', () => {
      const result = canUserSendMessage(guest, true);
      expect(result.canSend).toBe(false);
      expect(result.reason).toBe('premium_requires_balance');
    });
  });
});
