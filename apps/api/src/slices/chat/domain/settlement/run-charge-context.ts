import { createConversationsStores, resolveCallerMember } from '../../../conversations/index.js';
import { okAsync } from '../../../../lib/result/index.js';
import { senderCaller, senderUserId } from '../messages/sender.js';
import type { RunChargeContext } from '../../../workflows/index.js';
import type { ChargeSender } from '../../../billing/index.js';
import type { SenderPrincipal } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { SettlementTx } from '../../../../lib/idempotency/index.js';

type ConversationsStoresHandle = ReturnType<typeof createConversationsStores>;

/** The run facts a chat turn's charges are written under, whichever way it settles. */
export interface RunChargeDeps {
  readonly identity: {
    readonly conversationId: string;
    readonly walletId: string;
    readonly payerUserId: string;
    readonly sender: SenderPrincipal;
    readonly runId: string;
  };
  /**
   * The run's funding decision, derived ONCE per run from its payer and sender:
   * `true` ⟺ owner-funded, so group spend accrues.
   */
  readonly ownerFunded: boolean;
  readonly now: () => Date;
  /** The conversations stores bound to the settlement transaction; the real factory by default. */
  readonly conversationsStores?: (tx: SettlementTx) => ConversationsStoresHandle;
}

/** The group spend an owner-funded turn accrues; `null` for any other turn. */
type GroupSpend = NonNullable<RunChargeContext['groupSpend']>;

/**
 * Who pays, who sent, and the group spend the run accrues: the context every
 * charge of a chat run carries, for a saved turn and a refused one alike.
 */
export async function runChargeContext(
  tx: SettlementTx,
  deps: RunChargeDeps
): Promise<RunChargeContext & { readonly sender: ChargeSender }> {
  const { identity } = deps;
  const groupSpend = await resolveGroupSpend(tx, deps);
  return {
    walletId: identity.walletId,
    payerUserId: identity.payerUserId,
    sender: chargeSender(identity.sender),
    runId: identity.runId,
    now: deps.now(),
    ...(groupSpend === null ? {} : { groupSpend }),
  };
}

/**
 * The sender recorded on every billed row ({@link ChargeSender}), independent of the
 * payer: a member sender by userId, a link guest by linkId.
 */
function chargeSender(sender: SenderPrincipal): ChargeSender {
  return sender.kind === 'user'
    ? { kind: 'user', userId: sender.userId }
    : { kind: 'linkGuest', linkId: sender.linkId };
}

/**
 * Resolves the group spend INSIDE the settlement transaction, so the member- and
 * conversation-spend writes commit atomically with the content and charges.
 * Group spend is accrued ONLY for an OWNER-FUNDED group turn: the owner's wallet
 * paid, so the durable per-conversation row accrues the charge, and so does the
 * sender's durable per-member row while the sender is still an active member.
 * Owner-funding is derived ONCE per run from the run identity's payer and sender
 * ({@link RunChargeDeps.ownerFunded}, threaded in), so attribution agrees with
 * the payer and with the admission scopes by construction, and no second
 * connection opens mid-settlement. Nothing is accrued for:
 *   - a SOLO turn (a USER sender who owns the conversation: the owner funds and
 *     is not member-capped; a link guest is never the owner);
 *   - a PERSONAL fall-through group turn (`ownerFunded` false: the sender
 *     self-funded on their own wallet);
 *   - a refused turn whose conversation was deleted, since both rows point into it.
 * A refused turn whose sender was removed still accrues the conversation's
 * spend: removal deletes the member's budget row, not the conversation's.
 * The per-member CAP is never resolved here: it is durable owner-set config the
 * admission gate already enforced; settlement only accrues cumulative spend
 * (member + conversation rows, keyed by id, no period). The member is re-resolved
 * SERVER-SIDE from the SENDER principal (a user by `userId`, a guest by `linkId`)
 * via the same {@link resolveCallerMember} gate the epoch check uses, never from a
 * client-supplied member id. An infra read failure throws, rolling the whole
 * settlement back.
 */
function resolveGroupSpend(tx: SettlementTx, deps: RunChargeDeps): Promise<GroupSpend | null> {
  const conversationsStores = deps.conversationsStores
    ? deps.conversationsStores(tx)
    : createConversationsStores(tx);
  const { identity } = deps;
  const { conversationId } = identity;
  const resolvedSenderUserId = senderUserId(identity.sender);
  return conversationsStores.conversations
    .get(conversationId)
    .andThen((conversation) => {
      if (conversation === null) {
        return okAsync<GroupSpend | null, DomainError>(null);
      }
      // Solo turn: the sender IS the owner (users only), so the owner funds and is
      // not attributed to a member budget.
      if (resolvedSenderUserId !== undefined && conversation.ownerUserId === resolvedSenderUserId) {
        return okAsync<GroupSpend | null, DomainError>(null);
      }
      // Personal fall-through: the sender self-funded on their own wallet, so
      // no group spend is written.
      if (!deps.ownerFunded) {
        return okAsync<GroupSpend | null, DomainError>(null);
      }
      return resolveCallerMember(
        conversationsStores,
        conversationId,
        senderCaller(identity.sender, conversationId)
      ).map(
        (member): GroupSpend =>
          member === null ? { conversationId } : { conversationId, memberId: member.id }
      );
    })
    .match(
      (groupSpend) => groupSpend,
      (error) => {
        throw new Error('chat settlement: member-budget read failed', { cause: error });
      }
    );
}
