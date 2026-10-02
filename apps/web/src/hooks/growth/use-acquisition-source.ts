import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { acquisitionSourceViewSchema } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';
import { idempotencyExempt } from '@/lib/api/idempotent-mutation';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import type { AcquisitionSourceView, SelfReportAction } from '@hushbox/shared';
import type { UseQueryResult } from '@tanstack/react-query';

export const acquisitionSourceKeys = {
  all: ['acquisition-source'] as const,
  due: () => [...acquisitionSourceKeys.all, 'due'] as const,
};

/**
 * The payload is re-validated with the shared schema, so a drifting API shape
 * degrades to "no prompt" rather than rendering a card for a context the server
 * never named.
 */
async function fetchDuePrompt(): Promise<AcquisitionSourceView> {
  const raw = await fetchJson<unknown>(client.auth.account['acquisition-source'].$get());
  return acquisitionSourceViewSchema.parse(raw);
}

/**
 * Which channel prompt this account is owed, as the server computes it.
 *
 * The predicate is not mirrored here and there is nothing to mirror it with:
 * the skip lives on the account rather than the device, precisely so that
 * skipping on a phone still holds on a laptop. The client renders what this
 * returns and nothing else.
 *
 * The question is asked of the account, so it is gated on a session: the route
 * answers 401 without one, and the sidebar prompt slot mounts for signed-out
 * visitors too.
 */
export function useAcquisitionSource(): UseQueryResult<AcquisitionSourceView> {
  const { isAuthenticated } = useStableSession();
  return useQuery({
    queryKey: acquisitionSourceKeys.due(),
    queryFn: fetchDuePrompt,
    staleTime: 1000 * 60 * 5,
    enabled: isAuthenticated,
  });
}

export interface SelfReportMutation {
  readonly submit: (action: SelfReportAction) => void;
  readonly isSubmitting: boolean;
}

/**
 * Sends one of the prompt's two verbs and adopts the view the server answers
 * with, so what is due next comes from the same predicate that decided what was
 * due now — never from the client inferring the next state from its own action.
 */
export function useSelfReport(): SelfReportMutation {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    // No `Idempotency-Key`: both verbs are conditional writes that land the
    // same end state on repeat — the answer is guarded on there being none
    // yet, and the skip only ever moves forward through the two contexts.
    meta: idempotencyExempt('naturally-idempotent'),
    mutationFn: async (action: SelfReportAction): Promise<AcquisitionSourceView> => {
      const raw = await fetchJson<unknown>(
        client.auth.account['acquisition-source'].$patch({ json: action })
      );
      return acquisitionSourceViewSchema.parse(raw);
    },
    onSuccess: (view) => {
      queryClient.setQueryData(acquisitionSourceKeys.due(), view);
    },
  });
  return { submit: mutation.mutate, isSubmitting: mutation.isPending };
}
