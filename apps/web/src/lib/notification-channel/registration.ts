import { ApiError } from '@/lib/api/api';
import { idempotencyExempt } from '@/lib/api/idempotent-mutation';
import { queryClient } from '@/providers/query-provider';
import type { RegistrationOutcome } from './types.js';

/** The status the server refuses a token already held by another account with. */
const CONFLICT_STATUS = 409;

/**
 * Sends one device-registration POST and says what became of it.
 *
 * The POST runs as a mutation on the app's query client, so it retries exactly
 * as every other mutation does. Registration carries no Idempotency-Key, which
 * leaves it on the policy's network-only arm: a status-bearing failure stays
 * terminal for this session, and the next app start is its recovery.
 *
 * It never throws. Push is the degradable class, so a failed registration is a
 * recorded outcome the settings surface reads, not an error the caller handles.
 */
export async function sendRegistration(post: () => Promise<unknown>): Promise<RegistrationOutcome> {
  try {
    await queryClient
      .getMutationCache()
      .build(queryClient, {
        meta: idempotencyExempt('naturally-idempotent'),
        mutationFn: (send: () => Promise<unknown>) => send(),
      })
      .execute(post);
    return 'succeeded';
  } catch (error) {
    // A token the server holds for another account is refused for as long as
    // that holds, so no later attempt in this session can change the answer.
    return error instanceof ApiError && error.status === CONFLICT_STATUS
      ? 'failed-terminal'
      : 'failed-retryable';
  }
}
