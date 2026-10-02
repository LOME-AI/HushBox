import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/auth';
import { getLinkGuestAuth } from '@/lib/auth/link-guest-auth.js';
import { client, fetchJson } from '@/lib/api-client.js';
import { billingKeys } from '@/hooks/billing/billing.js';
import { REFETCH_FUNDING_ON_FOCUS } from '@/hooks/billing/funding-freshness.js';
import type { GetSpendableResponse } from '@hushbox/shared';

/**
 * Whether a funding read exists for this caller and scope — the one predicate
 * behind both the query's `enabled` flag and every caller's pending gate, so a
 * surface cannot wait forever on a read that was never issued.
 *
 * A signed-in caller always has one. A link guest has one only inside the
 * conversation its credential grants, because its payer is that conversation's
 * owner. A trial session has none at all, which is the whole reason the fixed
 * per-message ceiling stays client-side (BILLING §Affordability 8).
 */
function hasServedFunding(isAuthenticated: boolean, conversationId: string | null): boolean {
  if (isAuthenticated) return true;
  return getLinkGuestAuth() !== null && conversationId !== null;
}

/**
 * What is known about the payer's funding, as one closed answer.
 *
 * `awaiting` and `unavailable` are the two halves absence used to be collapsed
 * into. They differ in what the surface owes the user: a read still in flight
 * resolves itself, while an exhausted one never will, and rendering the neutral
 * pending state for the second is an indefinite silent wait rather than a
 * truthful state.
 */
export type FundingReadStatus = 'no-door' | 'awaiting' | 'unavailable' | 'served';

export interface FundingRead {
  readonly status: FundingReadStatus;
  /** The payer's snapshot, present only on `served` — never composed, never defaulted. */
  readonly snapshot: GetSpendableResponse | undefined;
}

/**
 * THE funding read every affordability caller keys on. Absence is the question
 * all of them ask, and asking it in one place is what keeps their answers
 * consistent: three parallel `data === undefined` gates could not disagree
 * about whether a snapshot exists, but they did disagree about what an
 * exhausted read means, and each corrected one of them separately.
 *
 * A caller with no funding door (the trial) never resolves the query, so its
 * permanent absence is `no-door` rather than a wait. A door-holder is
 * `awaiting` only while the query can still land — the retry policy has already
 * run by the time `isError` is set, so `unavailable` means the read is
 * exhausted, not merely slow. A failed refetch that still holds an earlier
 * snapshot stays `served`: real numbers already in hand beat a fresh failure.
 */
export function useFundingRead(
  isAuthenticated: boolean,
  conversationId: string | null
): FundingRead {
  const query = useSpendable(conversationId);
  if (!hasServedFunding(isAuthenticated, conversationId)) {
    return { status: 'no-door', snapshot: undefined };
  }
  if (query.data !== undefined) return { status: 'served', snapshot: query.data };
  return { status: query.isError ? 'unavailable' : 'awaiting', snapshot: undefined };
}

/**
 * The PAYER's funding snapshot: hold-aware spendable, what holds took off it,
 * and the tier and identity of the wallet those figures describe (BILLING
 * §Affordability 1, §Group Funding 1). This is THE affordability input for
 * every caller that has a funding door — the client never re-derives spendable
 * from the raw balance (the served number bakes the cushion exactly once;
 * re-adding it client-side is the double-cushion bug), and never re-derives the
 * payer's tier either. `useBalance` remains for payment-confirmation polling
 * and display only.
 *
 * **Two doors, one shape, one producer.** `/billing/spendable` is
 * billing-token-classed and refuses a link guest, so a guest reads the same
 * snapshot through the conversation's own guest funding route. Which door is
 * used is a transport detail; the numbers are produced once, server-side, by
 * the code the admission gate runs. A guest never composes a funding figure
 * from a second response, which is why both doors land on one cache entry.
 *
 * `conversationId` is what makes the answer the payer's: in a group
 * conversation the owner's funds and tier price the turn, so a
 * conversation-blind read serves a member the wrong wallet AND the wrong tier.
 * Each payer caches under its own key, all under one family prefix.
 *
 * Freshness rides the WS frames (`run-started`, `run-finished`, ws-ready
 * catch-up) invalidating the `billingKeys.spendable()` prefix, plus window
 * focus for the surfaces those frames cannot reach — zero per-keystroke calls.
 */
export function useSpendable(conversationId?: string | null): UseQueryResult<GetSpendableResponse> {
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const scope = conversationId ?? null;
  const isLinkGuest = !isAuthenticated && getLinkGuestAuth() !== null;

  return useQuery({
    queryKey: billingKeys.spendableFor(scope),
    queryFn: () =>
      isLinkGuest && scope !== null
        ? fetchJson(
            client.conversations[':conversationId'].funding.$get({
              param: { conversationId: scope },
            })
          )
        : fetchJson(
            client.billing.spendable.$get({
              query: scope === null ? {} : { conversationId: scope },
            })
          ),
    enabled: hasServedFunding(isAuthenticated, scope),
    refetchOnWindowFocus: REFETCH_FUNDING_ON_FOCUS,
  });
}
