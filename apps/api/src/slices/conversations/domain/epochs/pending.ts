import { ERROR_CODES } from '@hushbox/shared';
import { conflictError } from '../../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import type { ConversationsStores } from '../../ports/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';

/**
 * The gate every server-side encryption to the current epoch passes: it
 * refuses while a seat that is no longer live still holds a current-epoch
 * wrap, because that seat could open whatever is written next. The refusal
 * clears only when a remaining member's client rotates the departed key out.
 * The caller supplies the transaction and any lock it needs held.
 */
export function assertNoPendingDeparture(
  stores: ConversationsStores,
  conversationId: string
): ResultAsync<void, DomainError> {
  return stores.epochs
    .conversationsWithDepartedHolders([conversationId])
    .andThen(
      (pending): ResultAsync<void, DomainError> =>
        pending.has(conversationId)
          ? errAsync(
              conflictError(
                'conversations: a departed seat still holds the current epoch',
                undefined,
                ERROR_CODES.ROTATION_PENDING
              )
            )
          : okAsync()
    );
}
