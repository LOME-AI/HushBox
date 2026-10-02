/**
 * The money layer's barrel — the only sanctioned way into this directory.
 *
 * Everything under `affordability/` is pure: no database, no cache, no clock,
 * no randomness, no network, and content-free (counts, rates and identifiers
 * only, never a prompt, a message or a history array).
 *
 * The pricing machinery is deliberately absent (`docs/BILLING.md` §Where the
 * Code Lives): the minimum-answer constant, the characters-per-token ratios,
 * the reasoning-budget ladder, rates, manifests, reducers, per-candidate
 * ceiling solvers and clamping do not appear on this barrel or on the package
 * root. A consumer
 * that needs one of them is evidence the producer is missing a function.
 *
 * `zod` is the only import any production file here makes. The directory's own
 * tests additionally reach for `vitest`, `node:fs`/`node:url`, the seeded-PRNG
 * test helper, the non-money constants half, and the root barrel (the identity
 * pin in `index.test.ts` compares the two barrels' bindings). Anything joining
 * either list is a deliberate, visible edit.
 */

// Named, not `export *`: the minimum-answer constant is behind the wall
// (`docs/BILLING.md` §Where the Code Lives), and a star here would republish it.
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
  MAX_MODEL_AGE_MS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MIN_PRICE_PER_1K_TOKENS_NANO,
  MEDIA_MONTHLY_COST_PER_GB,
  MEDIA_STORAGE_COST_PER_BYTE,
  MONTHLY_COST_PER_GB,
  MONTHS_PER_YEAR,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_1K_CHARS,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_YEARS,
  TOP_CONTEXT_PERCENTILE,
  TOTAL_FEE_RATE,
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
} from './constants.ts';
export {
  exceedsModelAgeLimit,
  priceFloorVerdict,
  topContextExemptionTokens,
} from './catalog-admission.ts';
export type { PriceFloorVerdict } from './catalog-admission.ts';
export {
  ALL_FEE_CATEGORIES,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  formatFeePercent,
  roundPreservingSum,
} from './money/fees.ts';
export type { FeeBucketId, FeeCategory, FeeCategoryId } from './money/fees.ts';
// `applyFees` is deliberately absent: it applies the customer fee, and the root
// barrel is the one sanctioned publication site for a fee applier (fee-seams).
export { inputTokensOf } from './price/quantities.ts';
// Tier derivation and its constants — the tier half of the tier-and-premium
// classification seam (`docs/BILLING.md` §The public surface).
export {
  canUseModel,
  FREE_ALLOWANCE_CENTS_VALUE,
  getUserTier,
  tierCanAccessPremium,
  TRIAL_MESSAGE_LIMIT,
  USER_TIERS,
  WELCOME_CREDIT_CENTS,
} from './money/tiers.ts';
export type { UserBalanceState, UserTier, UserTierInfo } from './money/tiers.ts';
// Named: the output-token clamp is behind the wall; the notice generator is not.
export { generateNotifications } from './budget.ts';
export type { BudgetError, MessageSegment, NotificationInput } from './budget.ts';
// The context-fill verdict, beside the notice generator that reads it: the
// thresholds themselves stay behind the wall, so a surface asking how full the
// window is takes the band rather than the two fractions.
export { contextFillBand, isOverContextCapacity } from './capacity-band.ts';
export type { ContextFillBand } from './capacity-band.ts';
export { levenshtein } from './levenshtein.ts';
export { MODALITIES, Modality } from './model/modality.ts';
// Named, not `export *`: star re-exporting the money module would republish the
// fee-application helpers (`applyMarkup*`) through a second barrel, which the
// fee-seams rule forbids. The root barrel is the one sanctioned publication
// site for those two helpers; everything else here prices over already-billable
// rates.
export { MARKUP_BASIS_POINTS, roundHalfEvenDiv, usdToNanoUsd } from './money/money.ts';
export {
  nanoUsdToFourPlaceDollarString,
  nanoUsdToTwoPlaceDollarString,
} from './money/fixed-place-dollars.ts';
export {
  centsToNanoUsd,
  dollarsToCents,
  dollarsToNanoUsd,
  NANO_USD_PER_CENT,
  NANO_USD_PER_DOLLAR,
  nanoUSD,
  NanoUSD,
  nanoUsdToCents,
  nanoUsdToDollarString,
  nanoUsdToFullDollarString,
  parseNanoUSD,
  serializeNanoUSD,
} from './money/nano-usd.ts';
export { compileParamSpec, PARAM_TYPES, PARAM_WIRES, ParamSpec } from './model/param-spec.ts';
export type { ParamType, ParamWire } from './model/param-spec.ts';
export {
  CALL_SHAPE_FAMILIES,
  callShapeFamilyFor,
  isRunnableModelShape,
  ModelDescriptor,
  ModelReasoning,
} from './model/model-descriptor.ts';
export type { CallShapeFamily } from './model/model-descriptor.ts';
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
} from './reasoning-effort.ts';
export type { ReasoningOff } from './reasoning-effort.ts';
export {
  combinedRateNanoUsd,
  exceedsTrialBudget,
  isPremiumModel,
  MIN_POOL_FOR_PRICE_PERCENTILE,
  PREMIUM_PRICE_PERCENTILE,
  PREMIUM_RECENCY_MS,
  premiumPriceThresholdNanoUsd,
  TRIAL_AFFORDABILITY_MULTIPLIER,
} from './money/premium.ts';
export type { PremiumClassificationInput } from './money/premium.ts';
export { priceableModelFrom, reasoningPlanModelOf } from './model/priceable-model.ts';
// The §Math & Terms vocabulary stays behind the money layer; this one predicate
// is published because the server's pinned+auto compile and the client's send
// gate must answer "can this payer run any rung that reasons" identically
// (§Reasoning Effort 3, One Implementation Shared).
export type { PriceableModel } from './model/priceable-model.ts';
export { classifierEngineOf } from './classifier-engine.ts';
export { poolModelFrom, poolModelFromDescriptor } from './model/pool-projection.ts';
export { poolModelFromWire } from './model/wire-pool-row.ts';
export { mediaModelFromWire } from './model/wire-media-row.ts';
// What a surface shows of a served row's price, read off its anchor: every
// display surface asks this one producer rather than reading a rate field.
export { modelPriceDisplay } from './price/display.ts';
export type { ModelPriceDisplay } from './price/display.ts';
export { trialFundingSnapshot } from './trial-funding.ts';
export { freeDailyAllowanceNanoUsd } from './free-allowance.ts';
export { trialDailyMessageAllowance } from './trial-allowance.ts';
export { dimensionOptionAvailability } from './media-option-availability.ts';
export type { PoolCandidateRow } from './model/pool-projection.ts';
// The dimension registry as data — one of the named structural seams. Its
// derivations stay behind the sub-barrel (see `dimensions/index.ts`).
export * from './dimensions/index.ts';
export * from './smart-model/index.ts';
export {
  bindingGroupLimit,
  groupHeadroom,
  holdAwareGroupHeadroom,
  resolveFunding,
} from './billing/funding-decision.ts';
export type {
  FundingDecision,
  FundingInputs,
  HoldAwareGroupDimensions,
  OwnerFundingLimit,
  PayerSwitchReason,
} from './billing/funding-decision.ts';
export { deriveClientFundingInputs, resolveClientBilling } from './billing/client-billing.ts';
export type {
  ClientBillingInput,
  ClientFundingContext,
  DenialReason,
  FundingSource,
  FundingVerdict,
  ResolveBillingResult,
} from './billing/client-billing.ts';
export * from './estimate/index.ts';
// The tool loop: the tools and what each declares, the effort-scaled call cap,
// the step relation and the bound the estimator prices a loop from. A tool's
// provider price stays private to its fee seam; only the after-fee rate is here.
export {
  carveToolLoopSteps,
  isToolName,
  TOOL_CALL_CAP_MAX,
  TOOL_DECLARATIONS,
  TOOL_NAMES,
  toolCallCapFor,
  toolCallChargeNanoUsd,
  toolCallsOfSteps,
  toolLoopBound,
  toolLoopStepsFor,
  WEB_SEARCH_RESULT_MAX_CHARS,
} from './tool-loop.ts';
export type { ToolLoopBound, ToolName } from './tool-loop.ts';
export { toolCallBillableNano } from './estimate/tool-pricing.ts';
// The feature surface of `docs/BILLING.md` §The public surface, and nothing
// about how any of it is computed. Its membership is held equal to that doc
// section by `index.test.ts` rather than restated here — an enumeration in prose
// is a sync contract with the exports beside it, and drifts the first time one
// moves.
export { getTurnOptions } from './turn/turn-options.ts';
// The pair's prompt-independent half for a surface that has no prompt to pass:
// the empty basis is the producer's own substitution, never a caller's argument.
export { getAffordableOptions } from './turn/turn-options.ts';
export type { AffordableOptions } from './turn/turn-options.ts';
// A model's answer room, whether a rung fits it, and the rung an unpinned send is
// graded at: answers the server's compile refuses and sizes a turn with, so it
// grades `model_output_cap_too_low` exactly as the composer does. The ceiling
// solvers they are built on stay walled.
export { answerRoomTokens, effortFitsAnswerRoom, unpinnedEffortOf } from './turn/answer-room.ts';
// The one row a produced set holds no entry for: the smart slot is not a catalog
// model, so its verdict is a query over the set rather than a lookup in it.
export { smartSlotAvailability } from './turn/turn-options.ts';
// The per-unit modality's producer, beside the token one: a media surface's only
// route to a grey is a produced value, exactly as a text surface's is.
export { getMediaTurnOptions } from './turn/turn-options.ts';
export type {
  MediaDimensionAvailability,
  MediaModelEntry,
  MediaOptionSet,
  MediaSelection,
  MediaTurnOptions,
} from './turn/turn-options.ts';
// The bound the PAYER decision consumes (§Math & Terms). Published because the
// send path must price it before it can choose a payer, and a consumer that
// composed it from the walled terms itself would be the second implementation
// of a quantity the funding decision compares against.
export { minTurnCostNanoUsd, smartSlotMinTurnCostNanoUsd } from './money/min-turn-cost.ts';
export type {
  MinTurnCostInput,
  MinTurnCostSibling,
  SmartSlotMinTurnCostInput,
} from './money/min-turn-cost.ts';
export { modelId, ModelId } from './model/model-id.ts';
export {
  EMPTY_PROMPT_BASIS,
  promptBasisFromTotal,
  promptCharsOf,
  REFUSAL_CODES,
  refusalPrecedence,
} from './turn/turn-types.ts';
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
} from './turn/turn-types.ts';
export {
  NOTICE_COPY,
  NOTICE_REASONS,
  SELECTION_CAUSED_COPY,
  isTransientBlock,
  notices,
  noticeText,
  noticeTextOf,
  refusesRegenerate,
} from './notices.ts';
export type { Notice, NoticeCopy, NoticeReason } from './notices.ts';
