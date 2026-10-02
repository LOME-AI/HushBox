export { callerUserId } from './principal.js';
export {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  TRIAL_TURN_HOOKS,
} from './constants.js';
export {
  CHAT_CLASSIFIER_INPUT,
  CHAT_DECISION_DOMAIN_INPUT,
  CHAT_DECISION_NODE_ID,
} from './turn/classifier.js';
export { assertModelsProduceModality, buildMediaTurnDefinition } from './turn/media-turn.js';
export {
  buildMultiModelTurnDefinition,
  buildTurnDefinition,
  trialReasoningSelection,
  turnInputs,
} from './turn/definition.js';
export type { MultiModelTurnBuild, TurnBudget } from './turn/definition.js';
export {
  buildAutoEffortTurnDefinition,
  compileAutoEffortTurn,
  buildSmartModelTurnDefinition,
  buildTrialSmartModelTurnDefinition,
} from './smart-model/turn.js';
export { consumeTrialQuota, readTrialQuotaRemaining, trialQuotaIpKey } from './trial/quota.js';
export { compileTrialSingleTurn } from './trial/single-turn.js';
// The rate-limit registry is republished here, rather than straight off
// `./rate-limit.js` from the slice barrel, because this slice's route modules —
// `routes.ts` and the modules under `routes/` — call the counting functions and
// `packages/config/eslint-extensions/boundaries.config.mjs` does not admit a route to
// `./rate-limit.js` itself. A slice whose counting sits in `domain/` names no counting
// function in any of its route modules, so its slice barrel publishes `./rate-limit.js`
// directly: spending a counter during a request does not by itself put the registry in a
// domain barrel.
export {
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
  consumeChatStreamUserLimit,
  consumeTrialRemainingIpLimit,
  consumeTrialSendIpLimit,
} from './rate-limit.js';

// What the route seam needs from the models slice (single-writer), republished
// here because a route may import only this barrel: the exposed catalog read
// the trial send performs, the per-message cap the trial turn budget
// spends against, the kill switch, and the mock-provider directives. The
// gates' own producers are deliberately absent: `turn/pricing.ts`,
// `turn/tier-gate.ts` and `trial/gate.ts` compose the models barrel
// themselves, so `minTurnCost`, the premium-tier verdict and the trial
// eligibility/cost pair are derived in domain.
export {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  findAdminDisabledModel,
  listDescriptors,
  mockProviderEnabled,
  parseMockDirectives,
} from '../../models/index.js';
export { trialGateVerdict } from './trial/gate.js';
export type { TrialGateRefusal } from './trial/gate.js';

// The trial route needs the identity slice's trial-session resolver; the route
// may import only this barrel, so it is re-published here. (The realtime
// room-name helper is NOT re-exported: value-importing the `@hushbox/realtime`
// barrel drags in the workerd-only DO class, so it is injected via ChatRouteDeps
// instead — the same isolation the conversations adapters use.)
export { resolveTrialSessionPrincipal } from '../../identity/index.js';
export { canRegenerate } from './messages/regenerate-guard.js';
export type { RegenerateDecision } from './messages/regenerate-guard.js';
export { mediaTurnParams } from './turn/pricing.js';
export type { MediaTurnBody, TurnModality } from './turn/pricing.js';
// The payer freeze itself is deliberately NOT published: `gatedTurnContext` is
// the only door to a turn context, so a route cannot obtain one with the
// model-selection gates skipped.
export {
  gatedTurnContext,
  memberAdmits,
  regenerateTierGateMode,
} from './turn/gated-turn-context.js';
export type {
  GatedCallerAction,
  GatedTurnCaller,
  GatedTurnRefusal,
  GatedTurnRequest,
  PremiumTierGateMode,
  RegenerateTierGateRequest,
} from './turn/gated-turn-context.js';
export type { ChatRouteDeps, NotifyNewMessage, TurnContext } from './turn/context.js';
// The public guest-send seam resolves and gates the caller through the
// conversations barrel (routes may import only this barrel + middleware).
export {
  LINK_CREDENTIAL_HEADER,
  resolveCallerMember,
  resolveConversationCaller,
} from '../../conversations/index.js';
export { broadcastUserMessageNew, saveUserOnlyMessage } from './messages/user-message.js';
// The regenerate route stamps the storage the admission hold reserves, and
// settlement charges that same storage. Both read this ONE predicate rather
// than each testing the graft action for itself, so the reserve and the charge
// cannot drift about which turns store a new user message.
export { storesNewUserMessage } from './settlement/settlement.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs is published here rather than reached
// directly in routes.ts.
export { callerIpId } from '../../../lib/redis/index.js';
export { createErrorResponse } from '../../../lib/errors/index.js';
export {
  hashRequestBody,
  idempotencyExempt,
  idempotent,
  readIdempotencyKey,
  runMutation,
} from '../../../lib/idempotency/index.js';
export type { DomainErrorCode } from '../../../lib/errors/index.js';
