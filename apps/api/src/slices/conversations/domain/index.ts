export { callerUserId } from './principal.js';
export {
  LINK_CREDENTIAL_HEADER,
  resolveCallerMember,
  resolveCallerPublicKey,
  resolveConversationCaller,
} from './shares/caller.js';
export type { ConversationCaller } from './shares/caller.js';
export {
  consumeUpgradeTicket,
  freshUpgradeTicketGrant,
  issueUpgradeTicket,
} from './shares/upgrade-ticket.js';
export { getMyName, setMyNameTransition } from './members/my-name.js';
export { isRefusal, refusalToWire } from './outcomes.js';
export { buildParentIndex, regenerableTailIds } from './forks/parent-chain.js';
export { reserveSequenceBlockWithinTx } from './messages/sequence-block.js';
export { advanceForkTipWithinTx, resolveForkTipWithinTx } from './forks/fork-tip.js';
export { assertWrapEpochByMemberWithinTx } from './epochs/wrap-epoch.js';
export { assertNoPendingDeparture } from './epochs/pending.js';
export {
  createConversation,
  createConversationOutcomeSchema,
  deleteConversation,
  deleteConversationOutcomeSchema,
  getConversation,
  listConversations,
  updateConversationTitle,
  updateTitleOutcomeSchema,
} from './conversations.js';
export {
  getConversationBudgets,
  setBudgetOutcomeSchema,
  setConversationBudget,
  setConversationBudgetBodySchema,
  setMemberBudget,
  setMemberBudgetBodySchema,
} from './budgets/budgets.js';
export type { BudgetBilling } from './budgets/budgets.js';
export { getGuestFunding } from './budgets/guest-funding.js';
export { evictPrincipals } from './members/eviction.js';
export {
  broadcastForkCreated,
  broadcastForkDeleted,
  broadcastForkRenamed,
} from './forks/fork-events.js';
export {
  broadcastMemberAdded,
  broadcastMemberPrivilegeChanged,
  broadcastMemberRemoved,
  broadcastRotationComplete,
} from './members/member-events.js';
export {
  acceptInviteTransition,
  addMember,
  addMemberOutcomeSchema,
  advanceLastReadSeqTransition,
  changeMemberPrivilege,
  changePrivilegeOutcomeSchema,
  declineInviteTransition,
  leaveConversation,
  leaveOutcomeSchema,
  listMembers,
  removeMember,
  removeMemberOutcomeSchema,
  setMutedTransition,
  setPinnedTransition,
} from './members/members.js';
export { getKeyChain, getKeyChainBatch } from './epochs/keychain.js';
export { rotateEpoch, rotateEpochDomainOutcomeSchema } from './epochs/rotate.js';
export { getMemberKeys } from './epochs/member-keys.js';
export { getMessageHistory } from './messages/history.js';
export {
  createFork,
  createForkOutcomeSchema,
  deleteFork,
  deleteForkOutcomeSchema,
  listForks,
  renameFork,
  renameForkOutcomeSchema,
  updateForkTip,
  updateForkTipOutcomeSchema,
} from './forks/forks.js';
export {
  addMemberBodySchema,
  changePrivilegeBodySchema,
  conversationIdParameterSchema,
  changeLinkNameBodySchema,
  changeLinkPrivilegeBodySchema,
  createLinkBodySchema,
  createSharedMessageBodySchema,
  forkParameterSchema,
  leaveBodySchema,
  linkParameterSchema,
  shareIdParameterSchema,
  setMyNameBodySchema,
  listConversationsQuerySchema,
  memberKeysBatchQuerySchema,
  memberParameterSchema,
  messageHistoryQuerySchema,
  muteBodySchema,
  pinBodySchema,
  readCursorBodySchema,
  removeMemberBodySchema,
  revokeLinkBodySchema,
  updateForkTipBodySchema,
} from './schemas.js';
export {
  adminRevokeSharedLink,
  adminUnrevokeSharedLink,
  changeLinkName,
  changeLinkNameOutcomeSchema,
  changeLinkPrivilege,
  changeLinkPrivilegeOutcomeSchema,
  createLinkOutcomeSchema,
  createSharedLink,
  createSharedMessage,
  createSharedMessageOutcomeSchema,
  listSharedLinks,
  readSharedMessage,
  revokeLinkOutcomeSchema,
  revokeSharedLink,
} from './shares/shares.js';
export type { Outcome, Refusal } from './outcomes.js';
export type { ForkMessageDeleter } from './forks/forks.js';
export type { AdminSharedLinkParams } from './shares/shares.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor, the
// fingerprint registry its captures name, and the idempotency machinery the
// mutation wrappers compose with — is published here rather than imported
// from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
export {
  idempotencyExempt,
  idempotent,
  readIdempotencyKey,
  runMutation,
} from '../../../lib/idempotency/index.js';
export type { DomainError } from '../../../lib/errors/index.js';
export type { DbWriter } from '../../../lib/idempotency/index.js';
export type { Result } from '../../../lib/result/index.js';
export type {
  ConversationEventNotification,
  ConversationsStoresFactory,
  MembershipRevoker,
  NotifyConversationEventFactory,
  RealtimeBroadcast,
  UpgradePrincipal,
} from '../ports/index.js';
// Re-exported so routes (which import only this barrel + middleware) can type
// the injected link-resolution dependency without reaching into identity.
export type { LinkResolutionPort } from '../../identity/index.js';
