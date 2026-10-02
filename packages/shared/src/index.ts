export * from './constants.ts';
// Named, not `export *`: the minimum-answer constant is behind the money
// layer's export wall (`docs/BILLING.md` §Where the Code Lives).
export {
  CAPACITY_RED_THRESHOLD,
  CAPACITY_YELLOW_THRESHOLD,
  charStorageDollars,
  CHARACTERS_PER_KILOBYTE,
  CREDIT_CARD_FEE_RATE,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  HUSHBOX_FEE_RATE,
  KILOBYTES_PER_GIGABYTE,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MEDIA_MONTHLY_COST_PER_GB,
  MEDIA_STORAGE_COST_PER_BYTE,
  MONTHLY_COST_PER_GB,
  MONTHS_PER_YEAR,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_1K_CHARS,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_YEARS,
  TOTAL_FEE_RATE,
} from './affordability/constants.ts';
export * from './platform/websocket.ts';
export {
  ALL_FEE_CATEGORIES,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  formatFeePercent,
  roundPreservingSum,
} from './affordability/money/fees.ts';
export type { FeeBucketId, FeeCategory, FeeCategoryId } from './affordability/money/fees.ts';
export * from './platform/routes.ts';
export * from './utils/formatting.ts';
export { applyFees } from './affordability/money/pricing.ts';
export { inputTokensOf } from './affordability/price/quantities.ts';
export {
  canUseModel,
  FREE_ALLOWANCE_CENTS_VALUE,
  getUserTier,
  tierCanAccessPremium,
  TRIAL_MESSAGE_LIMIT,
  USER_TIERS,
  WELCOME_CREDIT_CENTS,
} from './affordability/money/tiers.ts';
export type { UserBalanceState, UserTier, UserTierInfo } from './affordability/money/tiers.ts';
// Named: the output-token clamp is behind the wall; the notice generator is not.
export { composeComposerNotices, generateNotifications } from './affordability/budget.ts';
export type { BudgetError, MessageSegment, NotificationInput } from './affordability/budget.ts';
export { contextFillBand, isOverContextCapacity } from './affordability/capacity-band.ts';
export type { ContextFillBand } from './affordability/capacity-band.ts';
export {
  groupHeadroom,
  holdAwareGroupHeadroom,
  resolveFunding,
} from './affordability/billing/funding-decision.ts';
export type {
  FundingDecision,
  FundingInputs,
  HoldAwareGroupDimensions,
  PayerSwitchReason,
} from './affordability/billing/funding-decision.ts';
export {
  deriveClientFundingInputs,
  resolveClientBilling,
} from './affordability/billing/client-billing.ts';
export type {
  ClientBillingInput,
  ClientFundingContext,
  DenialReason,
  FundingSource,
  FundingVerdict,
  ResolveBillingResult,
} from './affordability/billing/client-billing.ts';
export * from './env/env.ts';
// Named re-exports from leaf modules rather than a star from `env/env.config.ts`:
// the backend env registry must stay off this barrel's module graph, which three
// browser bundles import. `env/env-types.ts` and `env/env-frontend-schema.ts` carry
// none of it; the registry's one door is the `@hushbox/shared/env.config` subpath.
export {
  Destination,
  getDestinations,
  getModeValue,
  isModeOverride,
  isProductionSecret,
  isRef,
  isSecret,
  Mode,
  ref,
  resolveRaw,
  resolveValue,
  secret,
} from './env/env-types.ts';
export type { EnvMode, EnvValue, ModeValue, Ref, Secret, VariableConfig } from './env/env-types.ts';
export { frontendEnvSchema } from './env/env-frontend-schema.ts';
export { BRAVE_SEARCH_API_KEY_PLACEHOLDER } from './env/local-placeholders.ts';
export * from './schemas/dev-persona.ts';
export * from './schemas/dev-admin-token.ts';
export * from './schemas/cf-access-jwt-header.ts';
export * from './schemas/accessibility-preferences.ts';
export * from './schemas/api/index.ts';
export * from './prompt/index.ts';
export * from './utils/date.ts';
export * from './utils/pagination.ts';
export * from './utils/username.ts';
export * from './schemas/username.ts';
export * from './utils/random.ts';
export * from './utils/retry.ts';
export * from './utils/map-with-concurrency.ts';
export * from './utils/text-encoder.ts';
export * from './utils/privileges.ts';
export * from './utils/base64.ts';
export { levenshtein } from './affordability/levenshtein.ts';
export * from './utils/assert-never.ts';
export * from './legal/index.ts';
export * from './linear/index.ts';
export * from './errors/error-messages.ts';
export * from './platform/mobile.ts';
export * from './testing/demo-bridge.ts';
export * from './platform/platform.ts';
export { PRODUCT_TAGLINE, PRODUCT_TAGLINE_SENTENCES } from './brand/tagline.ts';
export { isStaleClientVersion } from './platform/stale-client-version.ts';
export * from './documents/index.ts';
export * from './models/index.ts';
export * from './affordability/smart-model/index.ts';
// The canonical estimator's published surface. Named (not `export *`) so the
// barrel's surface stays explicit and cannot collide with the money/pricing
// re-exports below. The pricing machinery itself — rates, manifests, the two
// reducers, the ceiling solvers, the ladder, the characters-per-token ratios —
// is behind the wall and is not re-exported by the estimator's own barrel
// either.
export {
  charStorageNanoUsd,
  estimateErr,
  estimateOk,
  getCushionNano,
  getEffectiveBalanceNano,
  isExpensiveModelNano,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  mediaOutputBytes,
  mediaStorageNanoUsd,
  nanoPricePer1k,
  nanoPriceRangePer1k,
  nanoUnitPriceUsd,
  outputTokensOf,
  PAID_CUSHION_NANO_USD,
  planReasoning,
  planReasoningOff,
  REASONING_OFF_WIRE,
  ReasoningWire,
  reasoningBudgetForTurn,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
  spendableFundsNanoUsd,
  STORAGE_COST_PER_CHARACTER_NANO,
} from './affordability/estimate/index.ts';
export type {
  CallUsage,
  EffortChoice,
  EstimateError,
  EstimateErrorCode,
  EstimateResult,
  ReasoningPlanDescriptorInput,
  ReasoningPlanModel,
  StoredMediaModality,
} from './affordability/estimate/index.ts';
export {
  CANONICAL_REASONING_EFFORTS,
  CanonicalReasoningEffort,
  REASONING_EFFORT_DESCRIPTIONS,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_SELECTIONS,
  REASONING_OFF,
  ReasoningEffortSelection,
  RESOLVED_REASONING_EFFORTS,
  ResolvedReasoningEffort,
} from './affordability/reasoning-effort.ts';
export type { ReasoningOff } from './affordability/reasoning-effort.ts';
// Premium classification and the narrow money projection it reads — two of the
// named structural seams of `docs/BILLING.md` §Where the Code Lives.
export {
  combinedRateNanoUsd,
  exceedsTrialBudget,
  isPremiumModel,
  MIN_POOL_FOR_PRICE_PERCENTILE,
  PREMIUM_PRICE_PERCENTILE,
  PREMIUM_RECENCY_MS,
  premiumPriceThresholdNanoUsd,
  TRIAL_AFFORDABILITY_MULTIPLIER,
} from './affordability/money/premium.ts';
export type { PremiumClassificationInput } from './affordability/money/premium.ts';
export { priceableModelFrom, reasoningPlanModelOf } from './affordability/model/priceable-model.ts';
export type { PriceableModel } from './affordability/model/priceable-model.ts';
export { classifierEngineOf } from './affordability/classifier-engine.ts';
export { poolModelFrom } from './affordability/model/pool-projection.ts';
export { poolModelFromWire } from './affordability/model/wire-pool-row.ts';
export { mediaModelFromWire } from './affordability/model/wire-media-row.ts';
export { modelPriceDisplay } from './affordability/price/display.ts';
export type { ModelPriceDisplay } from './affordability/price/display.ts';
export { trialFundingSnapshot } from './affordability/trial-funding.ts';
export { freeDailyAllowanceNanoUsd } from './affordability/free-allowance.ts';
export { trialDailyMessageAllowance } from './affordability/trial-allowance.ts';
export { dimensionOptionAvailability } from './affordability/media-option-availability.ts';
export type { PoolCandidateRow } from './affordability/model/pool-projection.ts';
// The feature surface of `docs/BILLING.md` §The public surface, published at the
// package root as well: one surface, two entry points, so a consumer cannot find
// a producer at one and its absence at the other.
export { getTurnOptions } from './affordability/turn/turn-options.ts';
export { getAffordableOptions } from './affordability/turn/turn-options.ts';
export type { AffordableOptions } from './affordability/turn/turn-options.ts';
export { smartSlotAvailability } from './affordability/turn/turn-options.ts';
export { getMediaTurnOptions } from './affordability/turn/turn-options.ts';
export type {
  MediaDimensionAvailability,
  MediaModelEntry,
  MediaOptionSet,
  MediaSelection,
  MediaTurnOptions,
} from './affordability/turn/turn-options.ts';
export {
  minTurnCostNanoUsd,
  smartSlotMinTurnCostNanoUsd,
} from './affordability/money/min-turn-cost.ts';
export type {
  MinTurnCostInput,
  SmartSlotMinTurnCostInput,
} from './affordability/money/min-turn-cost.ts';
// The three coarse producers of the same section. They declare in the estimator
// rather than beside their siblings above, so they are published from its barrel
// here — the surface is defined by the doc section, not by the directory a
// producer happens to live in.
export {
  effortSelectionForTurn,
  mediaTurnCostNanoUsd,
  textTurnBudget,
} from './affordability/estimate/index.ts';
export type {
  MediaTurnCostInput,
  TextTurnBudget,
  TextTurnBudgetInput,
  TurnEffortSelectionInput,
} from './affordability/estimate/index.ts';
export { modelId, ModelId } from './affordability/model/model-id.ts';
export {
  EMPTY_PROMPT_BASIS,
  promptBasisFromTotal,
  promptCharsOf,
  REFUSAL_CODES,
  refusalPrecedence,
} from './affordability/turn/turn-types.ts';
export type {
  Activation,
  AddAvailability,
  AnswerSources,
  Availability,
  CandidateModelEntry,
  CatalogSnapshot,
  DimensionAvailability,
  FundingSnapshot,
  ModelEntry,
  NonEmpty,
  OptionAvailability,
  OptionSet,
  PinnedModelEntry,
  PromptBasis,
  RefusalCode,
  Selection,
  SelectionCausedReason,
  TurnOptions,
} from './affordability/turn/turn-types.ts';
export {
  NOTICE_COPY,
  NOTICE_REASONS,
  SELECTION_CAUSED_COPY,
  TRIAL_REMAINING_MESSAGE_ID,
  isTransientBlock,
  notices,
  noticeText,
  noticeTextOf,
  refusesRegenerate,
} from './affordability/notices.ts';
export type {
  ComposerNoticeId,
  Notice,
  NoticeCopy,
  NoticeReason,
} from './affordability/notices.ts';

export * from './affordability/dimensions/index.ts';
export * from './platform/features.ts';
export * from './comparison.ts';
export * from './testing/test-ids.ts';
export * from './testing/test-signals.ts';
export * from './platform/storage-keys.ts';
export * from './usage-stats-windows.ts';
export * from './admin/index.ts';
export * from './notifications/index.ts';

export {
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  FeedbackKind,
  FeedbackStatus,
} from './enums/feedback.ts';
export {
  NEWSLETTER_CONFIRM_TTL_MS,
  NEWSLETTER_CONSENT_SOURCES,
  NEWSLETTER_CONSENT_TEXT_VERSION,
  NEWSLETTER_DEFAULT_TOPIC,
  NEWSLETTER_DELIVERY_STATUSES,
  NEWSLETTER_ISSUE_STATUSES,
  NEWSLETTER_POSTAL_ADDRESS,
  NEWSLETTER_STATUSES,
  NEWSLETTER_SUPPRESS_REASONS,
  NewsletterConsentSource,
  NewsletterDeliveryStatus,
  NewsletterIssueStatus,
  NewsletterStatus,
  NewsletterSuppressReason,
} from './enums/newsletter.ts';
export { LEDGER_ENTRY_KINDS, PAYMENT_STATUSES } from './enums/billing-enums.ts';
export { IMAGE_MIME_TYPES } from './enums/media-mime.ts';
export { MEMBER_PRIVILEGES, MemberPrivilege } from './enums/member-privilege.ts';
export { MODALITIES, Modality } from './affordability/model/modality.ts';
// Fee-seam: this barrel PUBLISHES the fee helpers to the sanctioned
// cross-package application seams; the vendored fee-seams lint rule confines
// who may import them (seam list in fee-seams.config.mjs).
export {
  MARKUP_BASIS_POINTS,
  applyMarkup,
  applyMarkupCeil,
  applyMarkupCeilFromUsdDecimal,
  applyMarkupFromPicoUsd,
  applyMarkupInverseFloorToPicoUsd,
  roundHalfEvenDiv,
  usdToNanoUsd,
  usdToPicoUsd,
} from './affordability/money/money.ts';
export {
  NanoUSD,
  NANO_USD_PER_CENT,
  NANO_USD_PER_DOLLAR,
  nanoUSD,
  nanoUsdToCents,
  nanoUsdToDollarString,
  nanoUsdToFullDollarString,
  centsToNanoUsd,
  dollarsToCents,
  dollarsToNanoUsd,
  parseNanoUSD,
  PRICEABLE_AMOUNT,
  serializeNanoUSD,
} from './affordability/money/nano-usd.ts';
export {
  DOMAIN_ERROR_CODE_TO_WIRE_CODE,
  asErrorCode,
  friendlyErrorMessage,
  ERROR_CODES,
  ERROR_MESSAGES,
  errorCodeSchema,
  errorResponseSchema,
  noticeReasonForCode,
} from './errors/error-codes.ts';
export type { ErrorCode, ErrorResponse } from './errors/error-codes.ts';
export { ContentValue, MediaValue } from './workflow/content-value.ts';
export {
  deriveNodeSchemas,
  Edge,
  END_NODE_ID,
  formatTypeTag,
  isAssignable,
  jsonTag,
  listTag,
  MEDIA_TAG_MODALITIES,
  mediaTag,
  NodeId,
  optionalTag,
  PortId,
  PortRef,
  textTag,
  TYPE_TAG_LAWS,
  TypeTagSchema,
  zodFor,
} from './workflow/type-tag.ts';
export type {
  DerivedNodeSchemas,
  JsonTag,
  ListTag,
  MediaTag,
  MediaTagModality,
  NodePortDeclaration,
  OptionalTag,
  SchemaNameRegistry,
  TextTag,
  TypeTag,
} from './workflow/type-tag.ts';
export {
  compileParamSpec,
  PARAM_TYPES,
  PARAM_WIRES,
  ParamSpec,
} from './affordability/model/param-spec.ts';
export type { ParamType, ParamWire } from './affordability/model/param-spec.ts';
export { CONSTRAINT_KINDS } from './workflow/constraint-registry.ts';
export type {
  ConstraintEntryOf,
  ConstraintKind,
  NamedConstraintEntry,
  NamedConstraintRegistry,
  ParameterConstraintEntry,
  PredicateConstraintEntry,
  ReducerConstraintEntry,
  SchemaConstraintEntry,
} from './workflow/constraint-registry.ts';
export {
  CALL_SHAPE_FAMILIES,
  ModelDescriptor,
  ModelReasoning,
  PRICING_KIND_BY_FAMILY,
  callShapeFamilyFor,
  isExposedModel,
  isRunnableModelShape,
} from './affordability/model/model-descriptor.ts';
export type { CallShapeFamily } from './affordability/model/model-descriptor.ts';
export {
  ChatHistoryMessage,
  FilePart,
  FINISH_REASONS,
  FinishReason,
  InferenceEvent,
  InferenceRequest,
  InputPart,
  MediaRef,
  ProviderMetadata,
  TOOL_ERROR_REASONS,
  ToolCall,
  ToolErrorReason,
  ToolResult,
  Usage,
} from './workflow/inference.ts';
export type { FilePartMapper, FilePartMediaEvents } from './workflow/inference.ts';
export { toWireInferenceEvent, WireInferenceEvent } from './workflow/wire-inference-event.ts';
export {
  AdmissionHookName,
  candidateAnsweringAt,
  consumedProducerIds,
  DEADLINE_CLASS_MS,
  DEADLINE_CLASSES,
  isTurnClassifierNode,
  MAX_RUN_HARD_STOP_MS,
  Node,
  NODE_TYPES,
  PolicyHooks,
  RUN_DRAIN_GRACE_MS,
  runTimeBounds,
  SettlementHookName,
  smartModelClassifierDimensions,
  StorageStamp,
  TURN_DECISION_REDUCER,
  WorkflowDefinition,
} from './workflow/workflow.ts';
export type { DeadlineClass, NodeType } from './workflow/workflow.ts';
export type {
  AdmissionDecision,
  AdmissionHook,
  AdmissionRequest,
  ClaimRun,
  FlowAbortReason,
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowHoldIdentity,
  FlowHookBindings,
  FlowInputs,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  FlowStreamEvent,
  MediaPersistPlan,
  PaidRunIdentity,
  RegenerateAction,
  RunClaim,
  RunClaimRequest,
  RunContext,
  RunFence,
  RunIdentity,
  CompletionTokens,
  MediaGenerationFacts,
  SettlementCharge,
  TrialRunIdentity,
  SettlementHook,
  SettlementRequest,
} from './workflow/flow-executor.ts';
export { mockDirectivesSchema } from './testing/mock-directives.ts';
export type { MockDirectives } from './testing/mock-directives.ts';
export { senderPrincipalId, senderPrincipalSchema } from './principal-id.ts';
export type { SenderPrincipal } from './principal-id.ts';
export * from './assistant-text/index.ts';
export * from './web-search/index.ts';
export * from './platform/ort-runtime.ts';
export * from './platform/tts-model-download.ts';
export * from './growth/index.ts';
