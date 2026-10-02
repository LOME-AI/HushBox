/**
 * The conversations slice's published surface for identity's account-deletion
 * transaction. This slice stays the single writer of `conversations` and
 * `conversation_members`: identity supplies the settlement transaction and
 * these functions perform the writes.
 */
export {
  deleteOwnedConversationsWithinTx,
  leaveAllMembershipsWithinTx,
  ownedConversationIdsWithinTx,
  revokeLinksCreatedByWithinTx,
} from '../adapters/account-deletion.js';
