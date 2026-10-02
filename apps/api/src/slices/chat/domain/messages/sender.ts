import type { SenderPrincipal } from '@hushbox/shared';
import type { ConversationCaller } from '../../../conversations/index.js';

/**
 * The membership-gate caller for a sender. A link guest carries the
 * conversation its credential resolved to, so the shared `resolveCallerMember`
 * / `resolveCallerPublicKey` gates key on the active `conversation_members` row
 * (a user by `userId`, a guest by `linkId`) — never on a client-claimed id.
 */
export function senderCaller(sender: SenderPrincipal, conversationId: string): ConversationCaller {
  return sender.kind === 'user'
    ? { kind: 'user', userId: sender.userId }
    : { kind: 'linkGuest', linkId: sender.linkId, conversationId };
}

/**
 * The sender's own user id — a user sender's `userId`, or `undefined` for a link
 * guest (which holds no account, is never the owner, and can never self-fund).
 * Never the payer: on an owner-funded turn the payer names the owner instead.
 *
 * One derivation because admission and settlement both key the solo
 * (sender-is-owner) decision on it: admission skips the member and conversation
 * budget scopes for a solo turn, settlement skips the matching group accrual. A
 * second derivation that drifted would let a turn be admitted under a member
 * budget settlement never debits — a group cap that silently stops constraining.
 */
export function senderUserId(sender: SenderPrincipal): string | undefined {
  return sender.kind === 'user' ? sender.userId : undefined;
}
