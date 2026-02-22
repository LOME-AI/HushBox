/**
 * Parameterized consistency tests for resolveBilling() ↔ generateNotifications().
 *
 * For every ResolveBillingInput combination, calls BOTH resolveBilling() AND
 * generateNotifications(), asserting:
 * - If resolveBilling() → denied → notifications MUST include a blocking error
 * - If resolveBilling() → approved → notifications MUST NOT include afford-blocking errors
 *
 * Parameterized across: tier × balance × isPremium × group/solo × privilege
 */

import { describe, it, expect } from 'vitest';
import { resolveBilling, type ResolveBillingInput } from './resolve-billing.js';
import { generateNotifications, type NotificationInput } from './budget.js';

// ============================================================================
// Helpers
// ============================================================================

/** IDs of notifications that are billing-denial errors (block send) */
const DENIAL_NOTIFICATION_IDS = new Set([
  'premium_requires_balance',
  'insufficient_balance',
  'insufficient_free_allowance',
  'guest_limit_exceeded',
]);

function isDenialNotification(id: string): boolean {
  return DENIAL_NOTIFICATION_IDS.has(id);
}

/** Run resolveBilling + generateNotifications and check consistency */
function assertConsistency(
  input: ResolveBillingInput,
  notificationOverrides: Partial<NotificationInput> = {}
): void {
  const billingResult = resolveBilling(input);

  const notifInput: NotificationInput = {
    billingResult,
    capacityPercent: 20, // default: not over capacity
    maxOutputTokens: 50_000, // default: plenty of tokens
    ...notificationOverrides,
  };

  const notifications = generateNotifications(notifInput);

  if (billingResult.fundingSource === 'denied') {
    // Denied → notifications MUST include a blocking denial error
    const hasDenialError = notifications.some(
      (n) => n.type === 'error' && isDenialNotification(n.id)
    );
    expect(hasDenialError).toBe(true);
  } else {
    // Approved → notifications MUST NOT include afford-blocking errors
    const hasDenialError = notifications.some(
      (n) => n.type === 'error' && isDenialNotification(n.id)
    );
    expect(hasDenialError).toBe(false);
  }
}

// ============================================================================
// Parameterized Tests
// ============================================================================

describe('resolveBilling ↔ generateNotifications consistency', () => {
  describe('personal: paid tier', () => {
    it('paid + sufficient balance + non-premium → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
      });
    });

    it('paid + sufficient balance + premium → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        isPremiumModel: true,
        estimatedMinimumCostCents: 10,
      });
    });

    it('paid + insufficient balance + non-premium → denied, has denial notification', () => {
      assertConsistency({
        tier: 'paid',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 200,
      });
    });

    it('paid + insufficient balance + premium → denied, has denial notification', () => {
      assertConsistency({
        tier: 'paid',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: true,
        estimatedMinimumCostCents: 200,
      });
    });
  });

  describe('personal: free tier', () => {
    it('free + allowance + non-premium → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 100,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
      });
    });

    it('free + allowance depleted + non-premium → denied, has denial notification', () => {
      assertConsistency({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
      });
    });

    it('free + premium model → denied, has denial notification', () => {
      assertConsistency({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 100,
        isPremiumModel: true,
        estimatedMinimumCostCents: 10,
      });
    });
  });

  describe('personal: trial tier', () => {
    it('trial + cheap message → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 1,
      });
    });

    it('trial + expensive message → denied, has denial notification', () => {
      assertConsistency({
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
      });
    });

    it('trial + premium model → denied, has denial notification', () => {
      assertConsistency({
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: true,
        estimatedMinimumCostCents: 1,
      });
    });
  });

  describe('personal: guest tier', () => {
    it('guest + cheap message → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'guest',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 1,
      });
    });

    it('guest + expensive message → denied, has denial notification', () => {
      assertConsistency({
        tier: 'guest',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
      });
    });
  });

  describe('group paths', () => {
    it('group + owner can use model → approved via owner, no denial notifications', () => {
      assertConsistency({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
        group: { effectiveCents: 500, ownerTier: 'paid', ownerBalanceCents: 5000 },
      });
    });

    it('group + owner cannot use premium → falls through to personal, consistency holds', () => {
      assertConsistency({
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        isPremiumModel: true,
        estimatedMinimumCostCents: 10,
        group: { effectiveCents: 500, ownerTier: 'free', ownerBalanceCents: 0 },
      });
    });

    it('group budget exhausted → falls through to personal, consistency holds', () => {
      assertConsistency({
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
        group: { effectiveCents: 0, ownerTier: 'paid', ownerBalanceCents: 5000 },
      });
    });

    it('group budget exhausted + personal insufficient → denied, has denial notification', () => {
      assertConsistency({
        tier: 'paid',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 200,
        group: { effectiveCents: 0, ownerTier: 'paid', ownerBalanceCents: 5000 },
      });
    });
  });

  describe('with privilege context', () => {
    it('read privilege + approved → no denial notifications', () => {
      assertConsistency(
        {
          tier: 'paid',
          balanceCents: 1000,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 10,
        },
        { privilege: 'read' }
      );
    });

    it('write privilege + denied → has denial notification', () => {
      assertConsistency(
        {
          tier: 'paid',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 200,
        },
        { privilege: 'write' }
      );
    });

    it('delegated budget active + owner pays → approved, no denial notifications', () => {
      assertConsistency(
        {
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 10,
          group: { effectiveCents: 500, ownerTier: 'paid', ownerBalanceCents: 5000 },
        },
        { hasDelegatedBudget: true }
      );
    });

    it('delegated budget exhausted + personal insufficient → denied, has notification', () => {
      assertConsistency(
        {
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 10,
          group: { effectiveCents: 0, ownerTier: 'paid', ownerBalanceCents: 5000 },
        },
        { hasDelegatedBudget: true }
      );
    });
  });

  describe('capacity interaction', () => {
    it('approved billing + over capacity → capacity error present (not billing denial)', () => {
      const input: ResolveBillingInput = {
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 10,
      };
      const billingResult = resolveBilling(input);
      expect(billingResult.fundingSource).not.toBe('denied');

      const notifications = generateNotifications({
        billingResult,
        capacityPercent: 150,
        maxOutputTokens: 50_000,
      });

      // Has capacity error but NOT billing denial
      expect(notifications.some((n) => n.id === 'capacity_exceeded')).toBe(true);
      expect(notifications.some((n) => isDenialNotification(n.id))).toBe(false);
    });

    it('denied billing + over capacity → both denial and capacity errors present', () => {
      const input: ResolveBillingInput = {
        tier: 'paid',
        balanceCents: 0,
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 200,
      };
      const billingResult = resolveBilling(input);
      expect(billingResult.fundingSource).toBe('denied');

      const notifications = generateNotifications({
        billingResult,
        capacityPercent: 150,
        maxOutputTokens: 0,
      });

      expect(notifications.some((n) => n.id === 'capacity_exceeded')).toBe(true);
      expect(notifications.some((n) => isDenialNotification(n.id))).toBe(true);
    });
  });
});
