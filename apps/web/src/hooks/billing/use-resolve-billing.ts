import * as React from 'react';
import { resolveClientBilling, type ResolveBillingResult } from '@hushbox/shared';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info.js';
import { useFundingRead } from '@/hooks/billing/use-spendable.js';

export interface UseResolveBillingInput {
  /**
   * Estimated minimum cost in exact nano-USD (shared estimator output), or
   * `undefined` when there is NO turn to price — no model selected, or a
   * selected model the catalog has not delivered yet.
   *
   * The absence is a distinct state and must stay one. A zero substituted for it
   * is not a cheap turn, it is an unanswerable question wearing an answer's
   * shape: the funding core clears any minimum at or below headroom, so a payer
   * with any funds at all comes back FUNDED for a turn that cannot be priced.
   */
  estimatedMinimumCostNanoUsd: bigint | undefined;
  /** Whether the selected model is premium */
  isPremiumModel: boolean;
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /**
   * The conversation being composed in, which NAMES the payer. It is required
   * rather than optional because omitting it does not ask a simpler question —
   * it asks the WRONG one, against a second cache entry for the same payer's
   * figure while every sibling hook reads the scoped one. `null` for a solo
   * composer, whose payer is the caller.
   */
  conversationId: string | null;
}

/**
 * Hook that resolves billing for the current message.
 *
 * Delegates the who-pays + premium decision to the shared
 * `resolveClientBilling()`, which routes through the same `resolveFunding`
 * core the server uses. No group dimension is passed, so the core resolves the
 * solo arm here and the payer of a group turn is the SERVED one; the send path
 * is where priority 1's comparison is made, against the minimum it prices. It
 * layers the client-only affordability / trial vocabulary on top. The affordability input
 * for every tier with a funding door is the SERVED spendable (`useSpendable`) —
 * cushion- and hold-aware, never re-derived from the raw balance and never
 * composed with a second figure; the raw balance feeds only the
 * negative-balance hard block and tier derivation.
 *
 * Returns a `ResolveBillingResult`: a `fundingSource`, a denial with its reason,
 * or `no_verdict` when the payer holds a funding door and no snapshot has been
 * read for it.
 */
export function useResolveBilling(input: UseResolveBillingInput): ResolveBillingResult {
  const tierInfo = useUserTierInfo(input.isAuthenticated);
  // The same funding read every affordability caller keys on, so this cannot
  // resolve against a snapshot a sibling hook does not have. The `0n` below
  // belongs to the doorless trial, the only payer §Affordability documents it
  // for: it is that payer's real figure, not a stand-in for an unread one.
  const funding = useFundingRead(input.isAuthenticated, input.conversationId);
  // A caller with no door never gets a snapshot and never needs one; every
  // other status without a snapshot is an absence, and absence is what has no
  // verdict. Keyed on the status rather than on the snapshot so the two cannot
  // be conflated again.
  const hasFundingFigure = funding.status === 'no-door' || funding.status === 'served';
  const spendableNanoUsd = funding.snapshot ? BigInt(funding.snapshot.spendableNanoUsd) : 0n;
  // An unpriceable turn never reaches the core: passing the absence THROUGH it
  // would be answered, and the answer would be affordable. `no_verdict` is the
  // right word for both ways a verdict can be missing — the funding read has
  // none, or the turn has no price to check one against — because every
  // consumer owes the user the same thing for both: no money claim, and no send.

  return React.useMemo(
    () =>
      hasFundingFigure && input.estimatedMinimumCostNanoUsd !== undefined
        ? resolveClientBilling({
            tier: tierInfo.tier,
            purchasedBalanceNanoUsd: tierInfo.purchasedBalanceNanoUsd,
            spendableNanoUsd,
            isPremiumModel: input.isPremiumModel,
            estimatedMinimumCostNanoUsd: input.estimatedMinimumCostNanoUsd,
          })
        : { fundingSource: 'no_verdict' },
    [
      hasFundingFigure,
      tierInfo.tier,
      tierInfo.purchasedBalanceNanoUsd,
      spendableNanoUsd,
      input.isPremiumModel,
      input.estimatedMinimumCostNanoUsd,
    ]
  );
}
