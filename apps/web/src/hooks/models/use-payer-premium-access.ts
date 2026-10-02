import * as React from 'react';
import { tierCanAccessPremium } from '@hushbox/shared';
import { useSession } from '@/lib/auth/auth';
import { useFundingRead } from '@/hooks/billing/use-spendable.js';

/**
 * Premium reach, or the reason it is not known. The union is the point:
 * `canAccessPremium` is unreadable while the snapshot is outstanding, so a
 * surface cannot resolve a model at the wrong tier and then keep the answer.
 *
 * Absence has two meanings, and they are separate arms because a caller owes
 * the user different things: a read still in flight resolves itself, while an
 * exhausted one never will, so reporting the second as pending is an
 * indefinite silent wait rather than a truthful state.
 */
type PayerPremiumAccess =
  | { status: 'awaiting' }
  | { status: 'unavailable' }
  | { status: 'known'; canAccessPremium: boolean };

/**
 * Whether the PAYER of `conversationId` can reach premium models.
 *
 * Two facts make this one hook rather than a line in each caller. Premium is
 * decided by the served tier and never by a balance (`docs/BILLING.md`
 * §Affordability 4), and the tier that decides it belongs to whoever pays —
 * an owner-funded member or link guest reaches what the OWNER reaches
 * (§Group Funding 1). Model surfaces that derive that fact themselves drift
 * from the option sets the composer renders, which read the same snapshot
 * through the money layer's adapter hook.
 *
 * `conversationId` is required because omitting it is not a simpler question:
 * it reads the caller's own wallet in a conversation somebody else funds.
 * `null` is the honest answer only where there is no conversation, whose payer
 * is the caller.
 */
export function usePayerPremiumAccess(conversationId: string | null): PayerPremiumAccess {
  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const { status, snapshot } = useFundingRead(isAuthenticated, conversationId);

  return React.useMemo((): PayerPremiumAccess => {
    // Until the session lands the caller is unknown, so the read describes
    // somebody else's door.
    if (isSessionPending || status === 'awaiting') return { status: 'awaiting' };
    if (status === 'unavailable') return { status: 'unavailable' };
    // What is left is a door-holder's landed snapshot, or a caller with no door
    // at all (the trial) whose permanent absence is an answer at its own tier
    // rather than a wait.
    return {
      status: 'known',
      canAccessPremium: snapshot !== undefined && tierCanAccessPremium(snapshot.payerTier),
    };
  }, [isSessionPending, status, snapshot]);
}
