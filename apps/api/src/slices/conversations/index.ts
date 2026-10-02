export { createConversationsManifest } from './routes.js';
export { CONVERSATIONS_ROUTE_POSTURES } from './rate-limit-posture.js';
export type { ConversationsRouteDeps } from './routes/deps.js';
export { createConversationsStores } from './adapters/stores.js';
// The composition root composes these with chat's content-item read to build
// media's PresignReaders (this slice owns epochs, epoch_members,
// conversation_members, shared_links, shared_messages).
export {
  findMessageShare,
  isActiveConversationMember,
  isEpochMember,
  resolveEpochRowId,
} from './adapters/presign-reads.js';
export { createMembershipRevoker } from './adapters/membership.js';
// The `epochs` wrap-key read (node-safe — no realtime graph): chat composes it
// as the default reader its settlement and user-only writer wrap content to.
export { createEpochPublicKeyReader } from './adapters/epoch-reads.js';
// The push side-band's active-user-member read over this slice's own
// `conversation_members` (single-writer). Node-safe by construction — it holds
// no realtime import — so the composition root binds it for the route-fired
// push capabilities without pulling the Durable Object runtime in behind it.
export { createPushMembershipReader } from './adapters/push-membership-reader.js';
export type { ConversationRoomNamespace } from './adapters/realtime-do.js';
export { createConversationRoomRealtime } from './adapters/realtime-binding.js';
export type { ConversationRoomEnv } from './adapters/realtime-binding.js';
// Dev/E2E sharing fixtures, published so the dev tooling never writes this
// slice's `shared_links` / `shared_messages` from outside it.
export { deleteSharedMessageById, insertRevokedSharedLink } from './adapters/dev-fixtures.js';
export {
  guestConversationIpRateLimit,
  linkCreateRateLimit,
  memberKeysBatchRateLimit,
  publicShareReadRateLimit,
  shareCreateRateLimit,
} from './domain/rate-limit.js';
// createRoomBindings is published by the `public/room-bindings.ts` door, not
// here: it value-imports the realtime barrel, so a barrel export would put the
// workerd-only Durable Object runtime in the graph of every consumer of this
// barrel — including other slices' domain layers, which cannot even load it in
// a node test.
// The admin-engine share-link write pair: authorization-only revocation
// (revokedAt flip + guest departure, NO epoch rotation — admins hold no key
// material) and its inverse. The admin slice composes these inside its
// operation transactions; live-socket eviction is the caller's best-effort
// follow-up via the returned evictee principal ids.
export { adminRevokeSharedLink, adminUnrevokeSharedLink } from './domain/index.js';
export type { AdminSharedLinkParams } from './domain/index.js';
// The unified parent-chain module — the published walk for message ancestry
// and epoch key chains; the chat slice consumes these instead of re-walking.
export {
  LINK_CREDENTIAL_HEADER,
  advanceForkTipWithinTx,
  assertNoPendingDeparture,
  assertWrapEpochByMemberWithinTx,
  buildParentIndex,
  regenerableTailIds,
  reserveSequenceBlockWithinTx,
  resolveCallerMember,
  resolveCallerPublicKey,
  resolveConversationCaller,
  resolveForkTipWithinTx,
} from './domain/index.js';
export type { ConversationCaller } from './domain/index.js';
export type { ConversationsStores, MemberRecord, SenderChainRow } from './ports/index.js';
export type { NotifyConversationEvent } from './ports/index.js';
export type { MembershipRevoker, RealtimeBroadcast } from './ports/index.js';
