/**
 * The limit an owner-funded snapshot names is the dimension its served figure
 * comes from: over every combination of remaining allowances, holds and owner
 * balance, the named dimension's clamped, hold-adjusted value is the hold-aware
 * headroom, and no other dimension is smaller.
 *
 * The generator is `groupDimensionsArb`. It draws every figure from a pool
 * weighted onto negative, zero and positive amounts, with small magnitudes so
 * that ties between dimensions, which the tie-break order must settle, are
 * common rather than vanishingly rare.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { spendableFundsNanoUsd } from '../estimate/pre-adapters.ts';
import {
  bindingGroupLimit,
  holdAwareGroupHeadroom,
  type HoldAwareGroupDimensions,
  type OwnerFundingLimit,
} from './funding-decision.ts';

/** Negative, zero and positive nano-USD, small enough that dimensions often tie. */
const nanoArb: fc.Arbitrary<bigint> = fc.oneof(
  fc.bigInt({ min: -5n, max: 5n }),
  fc.constant(0n),
  fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n })
);

const groupDimensionsArb: fc.Arbitrary<HoldAwareGroupDimensions> = fc.record({
  memberRemainingNanoUsd: nanoArb,
  memberHeldNanoUsd: nanoArb,
  conversationRemainingNanoUsd: nanoArb,
  conversationHeldNanoUsd: nanoArb,
  ownerPurchasedBalanceNanoUsd: nanoArb,
});

function clamp(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/** Each dimension's clamped, hold-adjusted value, stated from the funding rule. */
function clampedDimensions(
  dimensions: HoldAwareGroupDimensions
): Readonly<Record<OwnerFundingLimit, bigint>> {
  return {
    owner_balance: clamp(spendableFundsNanoUsd(dimensions.ownerPurchasedBalanceNanoUsd)),
    member_allocation: clamp(dimensions.memberRemainingNanoUsd - dimensions.memberHeldNanoUsd),
    conversation_budget: clamp(
      dimensions.conversationRemainingNanoUsd - dimensions.conversationHeldNanoUsd
    ),
  };
}

describe('the named owner-funding limit', () => {
  it('names a dimension whose clamped value is the hold-aware headroom', () => {
    fc.assert(
      fc.property(groupDimensionsArb, (dimensions) => {
        const named = clampedDimensions(dimensions)[bindingGroupLimit(dimensions)];
        expect(named).toBe(holdAwareGroupHeadroom(dimensions));
      })
    );
  });

  it('names a dimension no other dimension is smaller than', () => {
    fc.assert(
      fc.property(groupDimensionsArb, (dimensions) => {
        const values = clampedDimensions(dimensions);
        const named = values[bindingGroupLimit(dimensions)];
        for (const value of Object.values(values)) {
          expect(value).toBeGreaterThanOrEqual(named);
        }
      })
    );
  });
});
