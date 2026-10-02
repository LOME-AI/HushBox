import {
  InfrastructureUnavailableError,
  createRefusalChargingCommit,
} from '../../../workflows/index.js';
import { createConversationsStores } from '../../../conversations/index.js';
import { lockPrincipalAccounts } from './principal-accounts.js';
import { runChargeContext } from './run-charge-context.js';
import type { SettlementRefusalCommit } from '../../../workflows/index.js';
import type { SenderPrincipal } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { ChatSettlementDeps } from './settlement.js';

const REFUSAL_BILL_FAILURE_MESSAGE = 'chat settlement: the refused turn could not be billed';

type ConversationsStoresHandle = ReturnType<typeof createConversationsStores>;

/**
 * The chat turn's refusal commit, run by the fenced settlement hook after the
 * chat settlement commit refused and its savepoint rolled back. The answer
 * already streamed to the client, so every charge the run collected is billed to
 * the payer, with no storage fee because nothing is stored.
 *
 * The refusal's own cause may have deleted a row the bill would name, and a
 * usage row's foreign keys are checked at insert, so each is re-read first, the
 * accounts ahead of every other lock ({@link lockPrincipalAccounts} says why):
 *   - the payer's account: with it gone nobody can be billed, so nothing is
 *     written and the run is absorbed;
 *   - the conversation, under a FOR SHARE lock: only while it exists is the
 *     run's usage stamped with it;
 *   - the sender's row (a member's account, or a guest's link, which the
 *     conversation's deletion takes with it): with it gone the bill records the
 *     null sender, the pseudonymized state a hard deletion leaves.
 */
export function createChatRefusalCommit(deps: ChatSettlementDeps): SettlementRefusalCommit {
  return async (tx, request) => {
    const conversationsStores = deps.conversationsStores
      ? deps.conversationsStores(tx)
      : createConversationsStores(tx);
    const { identity } = deps;
    const accounts = await lockPrincipalAccounts(tx, deps);
    if (!accounts.has(identity.payerUserId)) return 'absorbed';
    const conversation = await readOrUnavailable(
      conversationsStores.conversations.lockForShare(identity.conversationId)
    );
    const context = await runChargeContext(tx, deps);
    const senderPresent = await senderRowExists(conversationsStores, identity.sender, accounts);
    const disposition = await createRefusalChargingCommit({
      stores: deps.billingStores,
      context: senderPresent ? context : { ...context, sender: null },
    })(tx, request);
    if (conversation !== null) {
      await deps.billingStores.stampRunConversationWithinTx(
        tx,
        identity.runId,
        identity.conversationId
      );
    }
    return disposition;
  };
}

/**
 * Whether the row a usage record's sender column would reference still exists:
 * a member's account, among those {@link lockPrincipalAccounts} found, or a
 * guest's link.
 */
async function senderRowExists(
  conversationsStores: ConversationsStoresHandle,
  sender: SenderPrincipal,
  accounts: ReadonlySet<string>
): Promise<boolean> {
  if (sender.kind === 'user') return accounts.has(sender.userId);
  const link = await readOrUnavailable(conversationsStores.sharedLinks.byId(sender.linkId));
  return link !== null;
}

/** A read the refusal bill depends on; one that did not answer fails the settlement as unavailable. */
function readOrUnavailable<T>(read: ResultAsync<T, DomainError>): Promise<T> {
  return read.match(
    (value) => value,
    (error) => {
      throw new InfrastructureUnavailableError(REFUSAL_BILL_FAILURE_MESSAGE, error.cause);
    }
  );
}
