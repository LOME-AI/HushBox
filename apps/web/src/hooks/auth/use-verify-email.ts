import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import { idempotencyExempt } from '@/lib/api/idempotent-mutation';

export const verifyEmailKeys = {
  all: ['auth', 'verify-email'] as const,
};

/**
 * Sends an emailed verification token. A repeat of a request whose answer was
 * lost is harmless: the server consumes the token in the same transaction that
 * marks the email verified, so a second send can never apply twice. A repeat of
 * one the server already consumed answers as an invalid token.
 *
 * `onVerified` is a mutation option rather than a `mutate` option because the
 * mutation runs it itself. A `mutate` callback reaches the caller only through
 * this hook's observer, which StrictMode's effect cleanup detaches from the
 * mutation already sent.
 */
export function useVerifyEmail(onVerified: () => void): UseMutationResult<void, Error, string> {
  return useMutation({
    mutationKey: verifyEmailKeys.all,
    // Never collected: under StrictMode no observer holds the sent mutation, so its
    // cache entry is the page's only record of the outcome. The only input it holds
    // is the single-use token, which the page's URL already carries.
    gcTime: Infinity,
    meta: idempotencyExempt('token-is-key'),
    mutationFn: async (token: string): Promise<void> => {
      await fetchJson(client.auth['verify-email'].$post({ json: { token } }));
    },
    onSuccess: onVerified,
  });
}
