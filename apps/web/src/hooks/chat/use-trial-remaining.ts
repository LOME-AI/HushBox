import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { trialDailyMessageAllowance } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import { peekTrialToken } from '@/lib/chat/trial-token.js';

export const trialRemainingKeys = {
  all: ['trial', 'remaining'] as const,
};

interface TrialRemainingInput {
  /**
   * Whether the caller has a trial allowance at all. An authenticated principal
   * has none — the route refuses one — so the read never leaves the client.
   */
  readonly enabled: boolean;
  /**
   * Whether a run is streaming right now. Its END is the only event that moves
   * the count, and the composer stays mounted across sends, so without this the
   * first send would never change what the user is shown.
   */
  readonly runInFlight: boolean;
}

export interface TrialRemaining {
  /**
   * How many free-preview messages are left today. `undefined` means "no
   * answer", never "none left".
   */
  readonly remaining: number | undefined;
  /**
   * Whether today's allowance is still whole. It is the `apps/web` PUBLISHER of
   * the trial allowance: the comparison against the declared figure happens
   * here, once, so no surface holds a message count of its own to compare with.
   *
   * A read that answered nothing is untouched — the surface owes the user
   * silence, not a count it does not have.
   */
  readonly allowanceUntouched: boolean;
}

/**
 * How many free-preview messages the caller has left today, as the trial send's
 * own counters report it, and whether the day has been drawn on at all —
 * display only. The server refusal is what stops a send; a client gate on a
 * cached zero would lock a user out across the UTC rollover the server would
 * admit.
 */
export function useTrialRemaining({ enabled, runInFlight }: TrialRemainingInput): TrialRemaining {
  const { data, refetch } = useQuery({
    queryKey: trialRemainingKeys.all,
    queryFn: () => {
      // The non-minting read: `getTrialToken` would persist a fresh uuid for
      // every anonymous visitor. Absent, the server answers off the IP counter.
      const token = peekTrialToken();
      return fetchJson(
        client.chat.trial.remaining.$get(
          {},
          token === null ? {} : { headers: { 'x-trial-token': token } }
        )
      );
    },
    enabled,
    staleTime: 0,
  });

  const wasInFlight = React.useRef(runInFlight);
  React.useEffect(() => {
    const runEnded = wasInFlight.current && !runInFlight;
    wasInFlight.current = runInFlight;
    if (runEnded && enabled) void refetch();
  }, [runInFlight, enabled, refetch]);

  // A disabled query still serves whatever the cache holds, which after a
  // sign-up would be the visitor's old trial count.
  const remaining = enabled ? data?.remaining : undefined;

  return React.useMemo(
    (): TrialRemaining => ({
      remaining,
      allowanceUntouched: remaining === undefined || remaining >= trialDailyMessageAllowance(),
    }),
    [remaining]
  );
}
