/**
 * The pure core the token producer runs: {@link evaluateTurn} takes one
 * `(funding, basis)` pair and returns one {@link OptionSet} plus the priced
 * line items. The producer runs it twice, against `effectiveBalance` and
 * against `spendable`, and nothing else may run it, which is why this file is
 * not on any barrel.
 *
 * The per-unit core is its sibling in `media-core.ts`, and the two are separate
 * because the projections they consume partition the catalog rather than
 * overlapping.
 *
 * What it does, in the specification's own terms (`docs/BILLING.md`):
 *
 * 1. An **arrangement** is a set of siblings that would answer together. A turn
 *    with pinned models alone has one; a smart slot adds one per candidate, and
 *    every non-pinned catalog model gets one too — that is how the picker's rows
 *    answer "could I run this beside what I have selected".
 * 2. Each arrangement solves ONE shared token count against the summed variable
 *    rates (§Sharing one budget across siblings), then clamps each sibling by its
 *    OWN `providerCap` and `contextHeadroom`. A small-context sibling therefore
 *    never caps a large-context one.
 *
 *    **The order of those two steps is the specification's, and it is
 *    authoritative for what any surface presents.** Solving unclamped and clamping
 *    afterwards guarantees `Σᵢ cost(mᵢ, ceiling(mᵢ)) ≤ funding` with room to
 *    spare whenever a sibling saturates: the saturated sibling's unused funding is
 *    left unspent rather than reallocated. A solve that clamped inside the sum
 *    would satisfy the same inequality while finding a larger shared count, so the
 *    two orders are distinguishable only by amount — which is why the amounts on a
 *    saturating-sibling turn are pinned in this directory
 *    (`turn-options.shared-ceiling.test.ts`) rather than described here. An
 *    execution path that sizes its own wire cap by the other order delivers MORE
 *    than was presented; that is safe for the reservation and visible as a
 *    presentation difference, and it is the presented figure that this module
 *    owns.
 * 3. The priced basis is `Σᵢ cost(mᵢ, ceiling(mᵢ))` plus the turn-level fixed
 *    terms — never `T × Σrates`, which §Multi-Model 2 forbids.
 * 4. The smart slot takes the `MAX` over candidate arrangements, never the `Σ`:
 *    exactly one candidate answers.
 * 5. **Four readings, ONE derivation.** What the classifier may pick (the
 *    candidate rows), what the user may pick (the turn-level menu), what the
 *    server admits (the send gate) and what money is reserved (the hold's `MAX`
 *    domain) are all queries over {@link reachableAt} — which arrangements the
 *    turn could become can run at a given effort. Each of those four is a
 *    decision, so a disagreement between any two of them is a defect rather than
 *    a cosmetic difference — and they cannot disagree, because there is nothing to
 *    disagree with.
 * 6. **Pricing and presentation still read different arrangements, deliberately.**
 *    An entry is graded on the arrangement it describes, whose membership no
 *    funding number can change. Collapsing that into the hold's arrangement makes
 *    a presented ceiling non-monotone in the funding, which breaks
 *    `admissible ⊆ affordable` — see {@link entriesFor}.
 *
 * Pure: no clock, no I/O, no randomness, and content-free — counts, rates and
 * identifiers only.
 */

import { classifierIsBought, dimensionSupportFor, resolveOption } from '../dimensions/derive.ts';
import { cheapestEffortOption, EFFORT_DIMENSION, EFFORT_OPTION_IDS } from '../dimensions/effort.ts';
import { effortSelectionForTurn } from '../estimate/effort-options.ts';
import { classifierEngineOf } from '../classifier-engine.ts';
import { classifierWorstCaseNanoUsd } from '../estimate/smart-model-affordability.ts';
import { costAt } from '../price/curve.ts';
import { inputTokensOf } from '../price/quantities.ts';
import { lineItemsAt } from '../price/reservation.ts';
import { toolCallCapFor, toolLoopBound } from '../tool-loop.ts';
import { WEB_SEARCH_TOOL_NAME } from '../../web-search/web-search-contract.ts';
import { offeredEffortRungs } from './effort-rungs.ts';
import { pricedSelection } from './priced-selection.ts';
import { reasoningPlanModelOf } from '../model/priceable-model.ts';
import {
  exceedsTrialBudget,
  isPremiumModel,
  premiumPriceThresholdNanoUsd,
} from '../money/premium.ts';
import { tierCanAccessPremium } from '../money/tiers.ts';
import {
  budgetBuysTokens,
  callCostBasis,
  ceilingTokens,
  contextHeadroomTokens,
  feasible,
  maxCallCostNanoUsd,
  MONEY_SOLVE_CAP_TOKENS,
  outlierModelIds,
  requiredCeilingTokens,
  siblingCurve,
} from './turn-arithmetic.ts';
import {
  isSelectionCaused,
  poolRefusalPrecedence,
  promptCharsOf,
  refusalPrecedence,
} from './turn-types.ts';
import type { CallCostBasis, CostContext } from './turn-arithmetic.ts';
import type { DimensionOption, OptionId } from '../dimensions/index.ts';
import type { NanoLineItem } from '../estimate/types.ts';
import type { Modality } from '../model/modality.ts';
import type { ModelId } from '../model/model-id.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { ReasoningEffortSelection, ResolvedReasoningEffort } from '../reasoning-effort.ts';
import type {
  Activation,
  Availability,
  CandidateModelEntry,
  DimensionAvailability,
  ModelEntry,
  OptionAvailability,
  OptionSet,
  PinnedModelEntry,
  PromptBasis,
  RefusalCode,
  RungCeiling,
  Selection,
  ToolLoopReading,
} from './turn-types.ts';
import type { UserTier } from '../money/tiers.ts';

export interface CoreInput {
  /** `effectiveBalance` for the affordable pass, `spendable` for the admissible one. */
  readonly fundingNanoUsd: bigint;
  readonly basis: PromptBasis;
  readonly selection: Selection;
  /** The priceable catalog pool — every model with a usable rate and cap. */
  readonly catalog: readonly PriceableModel[];
  readonly tier: UserTier;
  /**
   * The reference instant for premium classification's recency leg. An
   * argument, never read from the platform: this module holds no clock, so a
   * produced set is reproducible from its inputs alone (§Affordability:
   * "nothing in it reads a clock, a database, or a random source"). The purity
   * test in this directory greps for the reach, so the rule is enforced rather
   * than merely stated here.
   */
  readonly nowMs: number;
  /**
   * Which of the producer's two passes this is. The `affordable` pass is the
   * picker's greying check, which asks whether a model can run at all, so under
   * an open effort axis it prices at the loop of the lowest rung the selection
   * offers. Absent is the `admissible` pass.
   */
  readonly pass?: 'affordable' | 'admissible';
}

export interface CoreResult {
  readonly optionSet: OptionSet;
  /** The priced total of the arrangement a hold would be taken for. */
  readonly totalNanoUsd: bigint | undefined;
  /**
   * The line items that total folds. Not part of {@link OptionSet}: §Data
   * Structures does not carry a manifest to a surface, and the storage-drop and
   * reservation-amount properties need something to assert against, so the
   * manifest travels on the core's result where tests can pin it.
   */
  readonly lineItems: readonly NanoLineItem[];
  /**
   * The classifier reserve the solves set aside and the total does not carry:
   * non-zero exactly when an open effort axis settles at its one available rung
   * with no call left to buy ({@link settledReserveNanoUsd}).
   */
  readonly setAsideNanoUsd: bigint;
}

/**
 * Which rung a sibling's minimum-answer floor is measured at, once the effort
 * argued has resolved onto that model's own ladder.
 *
 * `at-effort` measures at the resolved rung, which is what a rung's own menu
 * verdict and the send gate ask: both are questions ABOUT a rung. `cheapest`
 * measures at `e_min(m)` — `eligible(m)` (`docs/BILLING.md` §Predicates),
 * "graded on the resolved cheapest corner". A lower rung never reserves more
 * completion than a higher one, so a model with any usable rung has a usable
 * cheapest rung, and the two corners coincide wherever the axis is open.
 */
type MinimumAnswerCorner = 'at-effort' | 'cheapest';

/**
 * The effort a verdict is taken under: the selection to resolve on each model's
 * ladder, and the corner its floor is then measured at. One argument because a
 * verdict needs both, and a call site carrying only the effort would leave the
 * corner defaulted silently. The two halves need not name the same rung:
 * {@link selectionBlock} resolves at the pin and measures at `e_min(m)`.
 */
interface EffortReading {
  /** `undefined` means the axis is open, which resolves to `e_min(m)`. */
  readonly effort: OptionId | undefined;
  readonly corner: MinimumAnswerCorner;
}

/** The reading every question ABOUT a rung takes: that rung, measured at itself. */
function atEffort(effort?: OptionId): EffortReading {
  return { effort, corner: 'at-effort' };
}

/** What the turn's effort selection resolves to on one model. */
interface EffortGate {
  /**
   * The option eligibility is graded on: the resolved pin, or `e_min(m)`.
   * `undefined` when the dimension does not apply to this model at all.
   */
  readonly option: OptionId | undefined;
  /** False when a pinned option has nothing at or below it on this model. */
  readonly resolvable: boolean;
}

/** Everything an arrangement prices against that does not vary by sibling. */
interface PricingContext {
  readonly fundingNanoUsd: bigint;
  readonly tier: UserTier;
  /**
   * The turn's modality, carried because the effort a REPLACING click leaves is
   * asked of the shared selection authority and only a text turn engages
   * reasoning at all ({@link replacementEffort}).
   */
  readonly modality: Modality;
  readonly persists: boolean;
  readonly inputTokens: number;
  /**
   * The WHOLE assembled prompt. It is the trial cap's basis and nothing else
   * here: the provider receives all of it, so the token leg and the trial cap
   * price it, while storage prices {@link PricingContext.inputChars}.
   */
  readonly promptChars: number;
  /**
   * The NEW message alone — the only characters this turn will store. It reaches
   * the solve, the total and the line items through the first sibling's
   * manifest, so the three read one number.
   */
  readonly inputChars: number;
  readonly classifierReserveNanoUsd: bigint;
  /**
   * The tool loop every tool-carrying sibling prices, at the call budget of the
   * rung this pricing is for. `undefined` when the turn carries no tool.
   */
  readonly toolLoop: ToolLoopBound | undefined;
  /**
   * Whether the turn's answers include the Smart slot's own. Its `smartModel`
   * node has no tools field, so an arrangement holding it prices the loop on its
   * named siblings alone: a slot-only turn prices none.
   */
  readonly smartSlot: boolean;
  readonly effortPin: OptionId | undefined;
  /**
   * Every model this turn could put on the WIRE: the pinned siblings, plus the
   * classifier-selectable pool when a smart slot can resolve to one.
   *
   * It is what {@link runsWireSilent} quantifies over, and that question is not
   * the menu's: {@link offeredRungs} lists the rungs these models DECLARE, while
   * a pin is resolved DOWNWARD onto each ladder, so a pin no row of the menu
   * carries can still be one an answerer resolves.
   */
  readonly answerModels: readonly PriceableModel[];
  /**
   * The whole priceable pool, carried for the ONE thing an arrangement cannot
   * answer from its own siblings: which model classifies it. The engine is the
   * cheapest model of the whole catalog by construction (§Smart Model 1), so an
   * arrangement that buys a classifier call has to reach past itself to price
   * one — see {@link classifierReserveOf}.
   */
  readonly catalog: readonly PriceableModel[];
  /**
   * The premium price threshold of the exposed pool, resolved once per pass.
   * `undefined` when the pool is too small to have one, which disables the price
   * leg alone. It is a property of the catalog, never of the payer, so both
   * passes of one call classify identically.
   */
  readonly premiumThresholdNanoUsd: NanoUSD | undefined;
  readonly nowMs: number;
}

/**
 * One set of siblings, priced. It carries no verdict: whether it can run is a
 * question about an EFFORT as well as an arrangement, and the answer has one
 * home ({@link arrangementBlock}) rather than a cached field beside it.
 */
interface Arrangement {
  readonly siblings: readonly PriceableModel[];
  /**
   * The smart-slot candidate this arrangement was built around — the one
   * sibling an effort pin GATES rather than resolves, because it is the model a
   * classifier may pick rather than one the payer chose. `undefined` when the
   * selection IS the turn and every sibling is pinned.
   */
  readonly candidateId: ModelId | undefined;
  /** The shared token count `T`; `budgetBuys(m)` when there is one sibling. */
  readonly sharedTokens: number;
  readonly totalNanoUsd: bigint;
  readonly lineItems: readonly NanoLineItem[];
}

/**
 * `ceiling(m)` inside one arrangement: the arrangement contributes the shared
 * token count, the model its own physical bounds. Derived on demand rather than
 * carried in a per-arrangement map, so there is no lookup that can miss.
 */
function ceilingIn(
  arrangement: Pick<Arrangement, 'sharedTokens'>,
  model: PriceableModel,
  context: PricingContext
): number {
  return ceilingTokens(model, {
    contextHeadroomTokens: contextHeadroomTokens(model, context.inputTokens),
    sharedTokens: arrangement.sharedTokens,
  });
}

/**
 * A turn that cannot start still renders: the entries and the turn-level option
 * lists ride the unsendable arm too, because the payer who cannot send is the
 * one whose greying needs explaining. Only `runnable` is withheld, and only a
 * priced arrangement can produce a hold.
 */
function refused(
  reason: RefusalCode,
  entries: readonly ModelEntry[],
  turnDimensions: readonly DimensionAvailability[],
  loops: ToolLoopReading
): CoreResult {
  return {
    optionSet: { sendable: false, refusal: reason, all: entries, turnDimensions, ...loops },
    totalNanoUsd: undefined,
    lineItems: [],
    setAsideNanoUsd: 0n,
  };
}

/** The line item an arrangement's classifier reserve is rendered under. */
const CLASSIFIER_LINE_ITEM = 'classifier-tokens';

/** The loop reading of a set no tool loop can price: a per-unit modality. */
const NO_LOOP: ToolLoopReading = { toolLoopEffort: undefined, holdEffort: undefined };

/**
 * The classifier's worst-case reserve, read through the ONE shared derivation
 * {@link classifierWorstCaseNanoUsd}. Admission sizes the call from the same
 * derivation: a chat turn's classifier is its own `classify` model call, stamped
 * with the input-token count the reserve derives for the list the call is
 * prompted with and capped at the same output, then priced as an ordinary
 * non-persisting call with each count clamped to the classifier model's limits;
 * a smartModel slot that classifies for itself prices
 * `classifierReserveCurve`. The client's send gate and the server's hold
 * compare against each other, so a second assembly of the same stage would put
 * a different number on each side of that comparison. It has a provider leg and
 * nothing else — the classifier's prompt and output are mid-flow values that
 * never rest, so no storage is reserved or charged for them on any tier (§Cost,
 * §Reasoning Effort 7).
 *
 * Two different lists, deliberately. The ENGINE is the cheapest model in the
 * whole priceable catalog (§Smart Model 1) and must stay so: it is
 * prompt-independent, which is what keeps the two option sets from choosing
 * different engines and breaking `admissible ⊆ affordable`. The PROMPTED list is
 * only what the classifier's own prompt will carry, and it bounds the input leg's
 * character count. The executor's list is a subset of the prompted list passed
 * here (a candidate list is the affordability-narrowed pool, and it lists no
 * models at all when the model dimension is not open), and the overhead is
 * monotone in that list — so the reserve is an upper bound by construction
 * rather than by measurement.
 */
function classifierReserveNanoUsd(
  catalog: readonly PriceableModel[],
  promptedModels: readonly PriceableModel[]
): bigint {
  const engine = classifierEngineOf(catalog);
  /* v8 ignore next 3 -- unreachable: a classifier is only bought when some model
     contributes an open dimension, so the pool this engine comes from is
     non-empty by the time anything asks for a reserve */
  if (engine === undefined) {
    throw new RangeError('classifier reserve: the catalog offers no engine to price it on');
  }
  return classifierWorstCaseNanoUsd(
    engine,
    promptedModels.map((model) => ({ id: model.modelId }))
  );
}

/**
 * How the turn's effort selection lands on one model.
 *
 * An OPEN axis grades on `e_min(m)`, and a model that offers no rung — one that
 * cannot reason at all — grades on no option, runs with no reasoning wire and
 * reserves nothing. A mandatory-reasoning model with a single native word is NOT
 * that case: it offers that one rung, and grading it here on the rung's real
 * budget is what keeps eligibility on a reachable corner (§Predicates).
 *
 * A PIN is a question about the model's own ladder, put to the registry's one
 * resolver: the rung itself, the nearest rung below it, or a mandatory ladder's
 * lowest rung. Resolution is total over the DECLARED domain but not over the
 * MODEL — `resolvable` is false when the model has nothing for the pin to land
 * on, an empty ladder or an id outside the domain included. §Reasoning Effort
 * 10(a) maps a choice onto a model's REAL ladder, and an absent ladder has
 * nothing to map onto.
 *
 * What an unresolvable pin COSTS the model is not decided here, because it
 * depends on which sibling it is ({@link runsWireSilent}): a candidate is
 * withheld, a pinned sibling runs wire-silent, and when nothing the turn could
 * put on the wire resolves the pin every one of them is withheld and the turn
 * refuses.
 *
 * The menu cannot then enable what the send refuses, because both read this one
 * predicate: an empty-ladder model contributes no rung to the union
 * {@link offeredRungs} presents, and every rung the union does carry is graded
 * through {@link reachableAt} at that rung.
 */
function effortGate(model: PriceableModel, pin: OptionId | undefined): EffortGate {
  if (pin === undefined) return { option: cheapestEffortOption(model), resolvable: true };
  const support = dimensionSupportFor(EFFORT_DIMENSION, model);
  const resolved = resolveOption(EFFORT_DIMENSION, support, pin);
  return { option: resolved, resolvable: resolved !== undefined };
}

/**
 * What one sibling prices against. `inputChars` lands on the FIRST sibling only:
 * `inputStorage` is counted once per turn and attributed to the first charge,
 * mirroring the settlement side (§Multi-Model 1). The tool loop lands on every
 * sibling that carries the tool.
 */
function costContextFor(
  context: PricingContext,
  isFirst: boolean,
  carriesTool: boolean
): CostContext {
  return {
    inputTokens: context.inputTokens,
    inputChars: isFirst ? context.inputChars : 0,
    persists: context.persists,
    ...(carriesTool && context.toolLoop !== undefined ? { toolLoop: context.toolLoop } : {}),
  };
}

function priceArrangement(
  siblings: readonly PriceableModel[],
  context: PricingContext,
  candidateId?: ModelId
): Arrangement {
  // The slot's own answer sits in this arrangement exactly when a candidate fills
  // it, and it is the one node that can never hold a tool.
  const slotAnswer = context.smartSlot ? candidateId : undefined;
  // Every sibling's curve is built once, and the solve, the total and the
  // rendered line items all read it: the curve the ceiling is solved against and
  // the price a surface renders cannot drift apart.
  const priced = siblings.map((sibling, index) => {
    const costContext = costContextFor(context, index === 0, sibling.modelId !== slotAnswer);
    return { sibling, curve: siblingCurve(sibling, costContext, MONEY_SOLVE_CAP_TOKENS) };
  });
  const sharedTokens = budgetBuysTokens(
    context.fundingNanoUsd,
    priced.map(({ curve }) => curve),
    context.classifierReserveNanoUsd
  );

  const lineItems: NanoLineItem[] = [];
  if (context.classifierReserveNanoUsd > 0n) {
    lineItems.push({
      label: CLASSIFIER_LINE_ITEM,
      fixedNano: context.classifierReserveNanoUsd,
      kind: 'provider',
    });
  }

  // The turn-level classifier reserve, plus each sibling's own cost at its own
  // ceiling — Σᵢ cost(mᵢ, ceiling(mᵢ)), the priced basis §Multi-Model 2 requires.
  let totalNanoUsd = context.classifierReserveNanoUsd;
  for (const { sibling, curve } of priced) {
    const ceiling = ceilingIn({ sharedTokens }, sibling, context);
    lineItems.push(...lineItemsAt(curve, ceiling));
    totalNanoUsd += costAt(curve, ceiling);
  }

  return { siblings, candidateId, sharedTokens, totalNanoUsd, lineItems };
}

/**
 * The tier axis: what this payer's TIER forbids, regardless of funding. A
 * premium row is marked rather than removed, so the reason travels with it and a
 * surface greys it with copy instead of hiding a model the payer could unlock
 * (§Model Classification, §Notices & Refusals 1).
 *
 * The two premium reasons are different ACTIONS, which is why they are two codes:
 * a payer with no account signs up, a payer with an account adds credit.
 */
function tierAxisBlock(model: PriceableModel, context: PricingContext): RefusalCode | undefined {
  if (
    !tierCanAccessPremium(context.tier) &&
    isPremiumModel({
      model,
      priceThresholdNanoUsd: context.premiumThresholdNanoUsd,
      nowMs: context.nowMs,
    })
  ) {
    return context.tier === 'free' ? 'premium_requires_credit' : 'premium_requires_account';
  }
  if (context.tier === 'trial' && exceedsTrialBudget(model, context.promptChars)) {
    return 'trial_message_cap_exceeded';
  }
  return undefined;
}

/**
 * Which of the ceiling's three bounds refused a token requirement, in the
 * precedence §Notices & Refusals 4 fixes: money first, then the prompt, then the
 * model's own output cap. One ladder, read by both the entry verdict and every
 * option's verdict, so a surface cannot explain the same condition two ways.
 */
function boundReason(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext,
  requiredTokens: number
): RefusalCode {
  if (arrangement.sharedTokens < requiredTokens) return 'insufficient_funds';
  if (contextHeadroomTokens(model, context.inputTokens) < requiredTokens) return 'prompt_too_long';
  return 'model_output_cap_too_low';
}

/**
 * Whether a sibling with nothing for the pin to land on runs WIRE SILENT — no
 * reasoning wire, nothing reserved, no refusal — rather than being withheld.
 * §Reasoning Effort 9 names that outcome directly: a model that cannot reason
 * records no level and shows no badge.
 *
 * The entitlement is granted when the pin is one the TURN can answer: some model
 * the turn could put on the wire resolves it. That set is
 * {@link PricingContext.answerModels}.
 *
 * "Can answer it" is deliberately weaker than "is a rung the menu shows", and
 * the two come apart on ordinary sending turns rather than only on degenerate
 * ones: {@link offeredRungs} carries the rungs models DECLARE, while
 * {@link effortGate} resolves a pin downward onto each real ladder. So a pin
 * above every declared rung is answered here, on a turn that presents an
 * arrangement and sends. Reading menu membership instead would withhold a
 * sibling over a pin every answer source honours.
 *
 * §Reasoning Effort 4's union is over the answer sources, and a smart slot is an
 * answer source: its candidates contribute the rungs the menu presents, so they
 * answer the pin the menu offered. Reading the PINNED siblings alone instead
 * refuses a pin the menu itself enabled — the union collapsed to an
 * intersection.
 *
 * The quantifier deliberately does not read the arrangement. That is what keeps
 * a pinned row ({@link pinnedEntryFor}, judged on the pinned siblings alone) and
 * the send gate ({@link reachableAt}, judged on the presented arrangements)
 * granting it alike, so the two cannot disagree; and it is what keeps a pinned
 * row's verdict from moving with whichever candidate it happened to be priced
 * beside — the frame-dependence {@link entriesFor} rules out.
 *
 * A CANDIDATE never qualifies, whatever else the turn can answer: it is a model
 * the CLASSIFIER may pick, and §Reasoning Effort 3 refuses a pin no candidate
 * can offer rather than binding one that would answer at some other rung — or at
 * none. A pinned sibling running wire-silent is the payer's own explicit choice
 * of that model; a classifier's is not. When nothing the turn could put on the
 * wire resolves the pin, every sibling is withheld — which is what makes a solo
 * ladderless selection refuse.
 */
function runsWireSilent(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext,
  effort: OptionId | undefined
): boolean {
  if (model.modelId === arrangement.candidateId) return false;
  return context.answerModels.some((answerer) => effortGate(answerer, effort).resolvable);
}

/**
 * Why one sibling cannot answer under `reading` inside this arrangement —
 * `undefined` when it can. THE leaf predicate: every reading this file publishes
 * is built from this one function, so "can this run" has a single definition
 * wherever it is asked. An effort the model cannot resolve refuses outright
 * unless it runs wire-silent; otherwise the minimum-answer floor is tested
 * against the ceiling and {@link boundReason} names the bound.
 *
 * `reading` carries both halves of the question ({@link EffortReading}).
 * `reading.effort` is the selection to resolve on this model's ladder — the
 * turn's own pin, or a rung the menu is asking about; `undefined` is an open
 * axis, which resolves to `e_min(m)`. `reading.corner` decides where the
 * minimum-answer floor is then measured, and only that: resolution runs on
 * `reading.effort` either way. `at-effort` measures the floor on the resolved
 * rung — `feasible(m, e)` — and `cheapest` measures it at `e_min(m)`, which is
 * `eligible(m)` (§Predicates). So on a RESOLVED pin the two corners genuinely
 * diverge, and {@link selectionBlock} is the one reading that takes `cheapest`;
 * wherever the axis is open they coincide.
 *
 * The tier axis is tested FIRST, in the precedence `REFUSAL_CODES` in
 * `packages/shared/src/affordability/turn/turn-types.ts` declares: a tier fact is
 * not a funding one, so no balance and no shorter answer clears it and a money
 * reason would name an action that cannot help (§Notices & Refusals 3, §Trial
 * Usage).
 *
 * An unresolvable pin costs the two sibling kinds different things
 * ({@link runsWireSilent}), because they are different questions.
 */
function siblingBlock(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext,
  reading: EffortReading
): RefusalCode | undefined {
  const tierBlock = tierAxisBlock(model, context);
  if (tierBlock !== undefined) return tierBlock;
  const gate = effortGate(model, reading.effort);
  if (!gate.resolvable && !runsWireSilent(model, arrangement, context, reading.effort)) {
    return 'option_not_offered';
  }
  const option = reading.corner === 'cheapest' ? cheapestEffortOption(model) : gate.option;
  const ceiling = ceilingIn(arrangement, model, context);
  if (!feasible(model, option, ceiling)) {
    return boundReason(model, arrangement, context, requiredCeilingTokens(model, option));
  }
  return undefined;
}

/**
 * Why this arrangement cannot run under `reading` — the conjunction of
 * {@link siblingBlock} over its siblings, reduced to one reason in the
 * precedence §Notices & Refusals 4 fixes.
 *
 * The conjunction is what §Story 1.2 asks for — "money for all three siblings …
 * and `B + MINIMUM_OUTPUT_TOKENS` inside every sibling's ceiling" — and what
 * makes §Story 1.3's pinned siblings a hard gate: they are not chooseable, so
 * they cap the whole turn. A candidate whose arrangement starves a pinned sibling
 * is therefore not a candidate, which is also the money half — the hold's `MAX`
 * ranges over exactly the arrangements this returns `undefined` for, so a
 * presented arrangement the `MAX` never priced is unrepresentable rather than
 * merely avoided (§Affordability: "the one place where using the wrong set is a
 * money defect").
 */
function arrangementBlock(
  arrangement: Arrangement,
  context: PricingContext,
  reading: EffortReading
): RefusalCode | undefined {
  const [first, ...rest] = arrangement.siblings.flatMap((sibling) => {
    const block = siblingBlock(sibling, arrangement, context, reading);
    return block === undefined ? [] : [block];
  });
  return first === undefined ? undefined : refusalPrecedence([first, ...rest]);
}

/** What the turn can become at one effort, and why the rest of it cannot. */
interface Reachable {
  /** Every presented arrangement that can run at this effort. */
  readonly running: readonly Arrangement[];
  /** One reason per arrangement that cannot. */
  readonly blocks: readonly RefusalCode[];
}

/**
 * THE derivation, and the whole point of its existing: the send gate is `running`
 * being non-empty, the hold is the `MAX` over `running`, the turn-level menu asks
 * the same question once per rung, and a row's verdict is
 * {@link arrangementBlock} — this function's own per-arrangement step — over the
 * arrangement that row describes.
 *
 * Each of those is a decision, so a disagreement between two of them is a money or
 * menu defect rather than a cosmetic difference. Deriving any of them separately is
 * what makes these silently possible: a hold taken over a set the classifier was
 * not presented, a menu enabling a rung the send gate refuses, a menu greying a
 * rung it would accept, a candidate ceiling above what its arrangement honours.
 * None of them is expressible against one derivation, which is why there is one.
 */
function reachableAt(
  presented: readonly Arrangement[],
  context: PricingContext,
  effort?: OptionId
): Reachable {
  const running: Arrangement[] = [];
  const blocks: RefusalCode[] = [];
  for (const arrangement of presented) {
    const block = arrangementBlock(arrangement, context, atEffort(effort));
    if (block === undefined) running.push(arrangement);
    else blocks.push(block);
  }
  return { running, blocks };
}

/**
 * What one row is graded by, at any effort. A row's own verdict is this at the
 * turn's effort selection and each of its rungs is this at that rung, so the two
 * cannot disagree: they are one function at different arguments.
 *
 * Only a candidate row needs one, because only a candidate row publishes rungs.
 */
type RowGrader = (effort: OptionId | undefined) => RefusalCode | undefined;

function availabilityOf(block: RefusalCode | undefined): Availability {
  return block === undefined ? { available: true } : { available: false, reason: block };
}

/**
 * One model's dimension lists. A dimension the model offers nothing on is absent
 * rather than present-and-empty, which is what keeps `options` a `NonEmpty`; the
 * model dimension has no entry here because its options ARE the model entries.
 *
 * A rung is graded on its own merits rather than inheriting an unavailable row's
 * reason: a row the turn cannot run at the effort SELECTED can still name the rung
 * that would make it runnable, and greying that rung hides the way out.
 */
function dimensionsFor(model: PriceableModel, grade: RowGrader): readonly DimensionAvailability[] {
  const support = dimensionSupportFor(EFFORT_DIMENSION, model);
  const [first, ...rest] = support.options.map(
    (option): OptionAvailability => ({
      ...option,
      availability: availabilityOf(grade(option.optionId)),
    })
  );
  if (first === undefined) return [];
  return [{ dimensionId: 'effort', options: [first, ...rest] }];
}

/**
 * A pinned sibling's row: graded on its OWN fit ({@link siblingBlock}), because
 * the sibling is already chosen and the row's only job is to name which sibling is
 * the problem (§Story 1.3). That verdict is finer than the arrangement's, so it may
 * disagree with the turn's — which is exactly why the shape publishes no
 * per-option list for anything to decide from.
 */
function pinnedEntryFor(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext,
  rungCeilings: readonly RungCeiling[]
): PinnedModelEntry {
  return {
    kind: 'pinned',
    modelId: model.modelId,
    availability: availabilityOf(
      siblingBlock(model, arrangement, context, atEffort(context.effortPin))
    ),
    ceilingTokens: ceilingIn(arrangement, model, context),
    rungCeilings,
  };
}

/**
 * Why the turn the payer would get by ADDING this row to the selection cannot
 * run — the same {@link arrangementBlock}, on the arrangement with this model
 * moved out of the classifier pool and into the pinned set. A second predicate is what this
 * deliberately is not: selecting a model changes its ROLE, not the rules, and
 * the two roles are already graded apart inside {@link runsWireSilent}.
 *
 * Two things move together, because pinning does both. The model stops being
 * the one sibling an effort pin GATES rather than resolves (`candidateId`), and
 * it starts being one of the turn's own ANSWER SOURCES — a pin it resolves
 * becomes a pin the turn can answer, which is what entitles its ladderless
 * siblings to run wire-silent. Nothing priced moves: the siblings, the shared
 * token count and every amount are the arrangement's own.
 *
 * The minimum-answer floor is measured at `e_min(m)` rather than at the rung the
 * pin resolved to, which is `eligible(m)` as §Predicates defines it. A rung is
 * a thing the payer can move, and the effort axis is where an unreachable one is
 * refused ({@link dimensionsFor}, {@link turnDimensionsFor}); refusing the MODEL
 * for it grounds a picker row on a choice made elsewhere, so every reasoning
 * model whose completion cap sits at or below the pinned rung's budget greyed at
 * every balance — `B` clamps to the cap, and no amount of money widens a cap.
 * The pin still has to RESOLVE on the ladder: a model that cannot offer it at
 * all is the {@link runsWireSilent} question, which the corner leaves alone.
 */
function selectionBlock(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext
): RefusalCode | undefined {
  return arrangementBlock(
    { ...arrangement, candidateId: undefined },
    { ...context, answerModels: [...context.answerModels, model] },
    { effort: context.effortPin, corner: 'cheapest' }
  );
}

/**
 * The pin supplied for this grading, restated in the shape the effort resolver
 * takes a preference in. It is NOT the payer's preference: the pin reaching
 * here was already resolved against the ladders of the selection in force, so a
 * preference above what that selection could honour arrives lowered, and a
 * candidate is graded at or below the rung the committed turn would carry.
 * Feeding the raw preference through instead changes which rows the picker
 * offers, so the gap is a product question rather than a defect to close here.
 *
 * A value outside the axis's declared domain names no rung any turn could
 * honour, which is the answer the selection authority already gives such a
 * value: `auto`, the open axis, delegated to the server.
 */
function preferredEffortOf(pin: OptionId | undefined): ReasoningEffortSelection {
  const known = EFFORT_OPTION_IDS.find((optionId) => optionId === pin);
  if (known === undefined) return 'auto';
  return known;
}

/**
 * The effort pin the REPLACED turn would really carry.
 *
 * A pin is a preference resolved against whatever ladders the turn's answer
 * sources offer, so a click that replaces the answer set also replaces the pin:
 * committing a model with no ladder leaves the turn carrying no pin at all, and
 * it sends. Grading the replacement at the pin the PRE-CLICK selection resolved
 * refused clicks that succeed — under any explicit preference every model with
 * no reasoning ladder greyed, which is most of the catalog.
 *
 * The resolution is asked of the one shared authority for it rather than
 * restated here, so the rung this arm grades at and the rung the request would
 * ride are one answer. Its funding-graded lowering is deliberately not asked
 * for: that set is derived from the very verdicts being computed here, so
 * supplying it would close a loop. What remains is the model clamp, which is the
 * question this arm asks — which pin the candidate's own ladder leaves standing.
 */
function replacementEffort(model: PriceableModel, context: PricingContext): OptionId | undefined {
  const resolved = effortSelectionForTurn({
    preferred: preferredEffortOf(context.effortPin),
    models: [reasoningPlanModelOf(model)],
    modality: context.modality,
    smartSlot: false,
  });
  return resolved === undefined || resolved === 'auto' ? undefined : resolved;
}

/**
 * Why the turn the payer would get by REPLACING the whole answer set with this
 * row cannot run — {@link selectionBlock}'s sibling, for the other click.
 *
 * A single-mode picker does not add: committing a row hands the store one entry
 * and the turn's answer sources become that model alone, with the smart slot
 * off, because the slot is an entry of that same list. So the arrangement graded
 * here is the candidate by itself, and it is the turn's only answer source —
 * which is what entitles it to run wire-silent, exactly as pinning it does.
 *
 * The effort pin and the classifier reserve are OUTPUTS of the click rather than
 * inputs it preserves ({@link replacementEffort}, {@link classifierReserveOf}):
 * a commit closes the model dimension, so the call the pass reserved for
 * choosing among candidates is not the call the committed turn makes. What the
 * arrangement still prices against the pass's own way is the funding, the tier,
 * the prompt basis, the other pinned dimensions and the web search toggle. The
 * slot flag is set for what a single-mode commit produces rather than for what
 * it changes here — nothing prices differently for it, because the tool loop
 * reads it only for an arrangement that names a candidate and this one does not.
 *
 * The corner is `cheapest`, for the same reason {@link selectionBlock} takes it:
 * a rung is a thing the payer can move, so refusing the MODEL for one grounds a
 * picker row on a choice made elsewhere.
 */
function replacementBlock(model: PriceableModel, pricings: Pricings): RefusalCode | undefined {
  const effortPin = replacementEffort(model, pricings.base);
  // The committed turn's own cheapest corner: its pin, or with the axis open the
  // lowest rung the model offers. The pass's loop belongs to a different turn.
  const loop = effortIdOf(effortPin ?? cheapestEffortOption(model));
  const replaced: PricingContext = {
    ...pricings.at(loop).context,
    answerModels: [model],
    smartSlot: false,
    effortPin,
    classifierReserveNanoUsd: classifierReserveOf(
      { answerModels: [model], effortPin, smartSlot: false, classifierPool: [] },
      pricings.base.catalog
    ),
  };
  return arrangementBlock(priceArrangement([model], replaced), replaced, {
    effort: replaced.effortPin,
    corner: 'cheapest',
  });
}

/**
 * Both activation verdicts for one row, and — when adding refuses — whose
 * problem that is.
 *
 * Whether adding refuses is {@link selectionBlock}'s answer alone; the
 * attribution decides only which reason the refusal WEARS. A candidate the payer
 * could not run alone reports its own reason, true of the model whether it runs
 * beside anything or not. A candidate that runs alone reports the arrangement's
 * reason, attributed to the selection where a sibling could have imposed it —
 * {@link isSelectionCaused} — so that removal joins the remedies, and to the
 * model otherwise. Reporting the arrangement's reason with nothing said about
 * whose it is, as this row's one verdict did, is the misattribution the split
 * exists to remove: an innocent row wore the pinned sibling's premium lock, and
 * every click on it opened a paywall it had no business at.
 *
 * Running alone does not mean a sibling is to blame, which is why the last arm
 * exists rather than refusing: a replacing click leaves the turn carrying only
 * the pin the committed model itself leaves standing ({@link replacementEffort}),
 * so a model with no ladder runs alone by dropping the turn's pin — and still
 * cannot answer that pin beside anything. That is `option_not_offered`, the one
 * reason this arm can reach that no sibling can impose, and it is the model's.
 * A row wearing it cannot appear on a turn that sends, pinned over generated
 * arrangements in `turn-core.model-caused-add.property.test.ts`.
 *
 * The attribution is published rather than left to a surface to derive, for the
 * same reason the verdicts are: deriving it there is a second rule that must
 * agree with this one.
 */
function activationFor(model: PriceableModel, pricings: Pricings): Activation {
  const replaceBlock = replacementBlock(model, pricings);
  const replace = availabilityOf(replaceBlock);
  const added = addedTurnPricing(model, pricings);
  const addBlock = selectionBlock(model, candidateArrangementIn(added, model), added.context);
  if (addBlock === undefined) return { replace, add: { available: true } };
  if (replaceBlock !== undefined) {
    return { replace, add: { available: false, reason: replaceBlock, causedBy: 'model' } };
  }
  if (!isSelectionCaused(addBlock)) {
    return { replace, add: { available: false, reason: addBlock, causedBy: 'model' } };
  }
  return { replace, add: { available: false, reason: addBlock, causedBy: 'selection' } };
}

/**
 * A candidate's row: graded on the whole arrangement it would create
 * ({@link arrangementBlock}), because it is what the classifier may pick and its
 * rungs are the per-candidate ceiling a classifier answer clamps onto — §Story
 * 2.2's "capped by the tightest pinned sibling".
 *
 * Each rung is graded exactly as the row is under a pin at that rung: the same
 * arrangement, priced at that rung's loop, at that rung's budget. A rung the row
 * could not run at under that pin is therefore never marked available.
 *
 * `activation` answers the other question the row is asked, once per way the row
 * can be activated — see {@link activationFor}.
 */
function candidateEntryFor(
  model: PriceableModel,
  reading: LoopReading,
  pricings: Pricings
): CandidateModelEntry {
  const verdict = pricings.at(reading.verdictLoop);
  const arrangement = candidateArrangementIn(verdict, model);
  // A rung is graded on the arrangement priced at that rung's own loop, which is
  // the loop the same row carries when the turn pins that rung: a rung and the
  // row under that pin stay one verdict.
  const grade: RowGrader = (effort) => {
    const at = pricings.at(effortIdOf(effort));
    return arrangementBlock(candidateArrangementIn(at, model), at.context, atEffort(effort));
  };
  const dimensions = dimensionsFor(model, grade);
  // The row publishes a ceiling for every rung the turn can run and every rung
  // the row itself offers, so a picker row's own rungs carry the ceiling each
  // runs at even where the turn's menu lists no such rung.
  const ownRungs = new Set(availableRungsOf(dimensions));
  const ceilingRungs = EFFORT_OPTION_IDS.filter(
    (effort) => ownRungs.has(effort) || reading.ceilingRungs.includes(effort)
  );
  return {
    kind: 'candidate',
    modelId: model.modelId,
    availability: availabilityOf(
      arrangementBlock(arrangement, verdict.context, atEffort(verdict.context.effortPin))
    ),
    activation: activationFor(model, pricings),
    ceilingTokens: ceilingIn(arrangement, model, verdict.context),
    dimensions,
    rungCeilings: ceilingRungs.flatMap((effort): readonly RungCeiling[] => {
      const at = pricings.at(effort);
      const atRung = candidateArrangementIn(at, model);
      return arrangementBlock(atRung, at.context, atEffort()) === undefined
        ? [{ effort, ceilingTokens: ceilingIn(atRung, model, at.context) }]
        : [];
    }),
  };
}

/** The arrangement a candidate would create, in one pricing. */
function candidateArrangementIn(pricing: Pricing, model: PriceableModel): Arrangement {
  const arrangement = pricing.candidateArrangements.get(model.modelId);
  /* v8 ignore next 3 -- every candidate got an arrangement in every pricing; this
     narrows the map lookup for the compiler and is not a reachable branch */
  if (arrangement === undefined) {
    throw new RangeError(`no arrangement priced for candidate '${model.modelId}'`);
  }
  return arrangement;
}

/**
 * The turn an ADD click would commit, priced at its own cheapest corner: the
 * pass's pin when one is set, and with the axis open the lowest rung the
 * arrangement's own members offer.
 */
function addedTurnPricing(model: PriceableModel, pricings: Pricings): Pricing {
  const pin = pricings.base.effortPin;
  return pricings.at(
    pin === undefined ? lowestRungOf([...pricings.plan.pinnedModels, model]) : effortIdOf(pin)
  );
}

/**
 * The menu's rows: every rung the presented arrangements' siblings declare,
 * through the one union rule {@link offeredEffortRungs} holds for the engine and
 * the selection authority alike.
 *
 * A smart slot is one of the answer sources the payer selected, so with one
 * present the siblings passed here are its CANDIDATES and not only the pinned
 * models. Everything that grades a rung has to range over the same models, or
 * the menu offers a rung the gate has no answer source for — see
 * {@link runsWireSilent}.
 */
function offeredRungs(members: readonly PriceableModel[]): readonly DimensionOption[] {
  return offeredEffortRungs(members.map((member) => reasoningPlanModelOf(member)));
}

/**
 * Every sibling of the arrangements {@link presentedArrangements} builds, read off
 * the plan: membership is what the menu's rungs come from, and no pricing moves it.
 */
function presentedMembers(plan: SiblingPlan): readonly PriceableModel[] {
  if (!plan.smartSlot) return plan.pinnedModels;
  if (plan.classifierPool.length === 0) return [];
  return [...plan.pinnedModels, ...plan.classifierPool];
}

/**
 * The turn-level option list for the effort dimension: each rung graded by the
 * SAME query the send gate runs, asked once per rung, over the arrangements priced
 * at that rung's own tool loop. A rung is a turn the payer could pin, so it is
 * graded at the loop that turn would declare, in both passes.
 *
 * That composes the specification's two quantifiers correctly because they live in
 * one place — an AND over the pinned siblings, which are not chooseable and so cap
 * the whole turn (§Story 2.1), inside an OR over the arrangements a smart slot
 * could pick, since an effort is enabled iff at least one candidate can honour it
 * (§Story 2.8). Merging the ROWS instead inverted them: a pinned sibling's own
 * verdict got OR'd, which enabled rungs the send gate refuses, and an unavailable
 * row greyed every rung it offers, which hid the lower rung that would have sent.
 *
 * A greyed rung carries the reason the send gate itself would give, because both
 * reduce the same arrangement blocks through {@link reduceArrangementBlocks} for
 * the same plan.
 */
function turnDimensionsFor(
  offered: readonly DimensionOption[],
  pricings: Pricings
): readonly DimensionAvailability[] {
  const [first, ...rest] = offered.map((option): OptionAvailability => {
    const at = pricings.at(effortIdOf(option.optionId));
    const reachable = reachableAt(at.presented, at.context, option.optionId);
    return {
      ...option,
      availability:
        reachable.running.length > 0
          ? { available: true }
          : { available: false, reason: reduceArrangementBlocks(reachable.blocks, pricings.plan) },
    };
  });
  if (first === undefined) return [];
  return [{ dimensionId: 'effort', options: [first, ...rest] }];
}

/** The available rungs of a produced menu, ascending. */
function availableRungsOf(
  turnDimensions: readonly DimensionAvailability[]
): readonly ResolvedReasoningEffort[] {
  return turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) => {
      const effort = effortIdOf(option.optionId);
      return option.availability.available && effort !== undefined ? [effort] : [];
    })
  );
}

/**
 * Whether a smart slot with no pinned sibling offers the turn's one classifier
 * call a choice: two or more candidates, or two or more effort rungs. Exported for
 * the slot's `minTurnCost`, which carries the reserve exactly then, since the send
 * threshold deducts it whenever a choice is offered, even where a funded run
 * settles effort at one available rung and sets the reserve aside. A threshold
 * that adds a reserve no send deducts refuses a payer who could send, and one
 * that omits a reserve the send deducts admits a turn admission then refuses.
 */
export function smartSlotBuysClassifier(classifierPool: readonly PriceableModel[]): boolean {
  return classifierIsBoughtForTurn(classifierPool, true, true, classifierPool.length);
}

/** Whether the MODEL dimension alone buys the call: a slot with two or more to choose between. */
function modelAxisBuysClassifier(modelOpen: boolean, candidateCount: number): boolean {
  return modelOpen && candidateCount >= 2;
}

/** Whether an open dimension buys the turn's one classifier call. */
function classifierIsBoughtForTurn(
  effortContributors: readonly PriceableModel[],
  effortOpen: boolean,
  modelOpen: boolean,
  candidateCount: number
): boolean {
  if (modelAxisBuysClassifier(modelOpen, candidateCount)) return true;
  if (!effortOpen) return false;
  return effortContributors.some((model) =>
    classifierIsBought(EFFORT_DIMENSION, model, dimensionSupportFor(EFFORT_DIMENSION, model))
  );
}

/**
 * The four facts a turn's classifier reserve is decided from. An ARRANGEMENT's
 * facts, not a pass's: a replacing click closes the model dimension and changes
 * the answer sources, so every one of them moves under it.
 */
interface ClassifierPlan {
  /** Every model the turn could put on the wire — the effort axis's contributors. */
  readonly answerModels: readonly PriceableModel[];
  readonly effortPin: OptionId | undefined;
  /** Whether the MODEL dimension is open, which is what a smart slot leaves it. */
  readonly smartSlot: boolean;
  /** What the classifier could choose between, and what its own prompt lists. */
  readonly classifierPool: readonly PriceableModel[];
}

/**
 * Whether a turn buys the one classifier call and what it reserves for it, asked
 * of an arrangement rather than of the pass.
 *
 * It is one function because the two callers grade two different turns and must
 * not answer this differently: the pass reserves for choosing among the whole
 * pool, while the turn a single-mode click commits reserves for whatever an
 * arrangement of one model with the model dimension closed still buys — often
 * nothing, and never more. A second copy of the rule would put one figure on the
 * picker row and another on the send the row leads to.
 */
function classifierReserveOf(plan: ClassifierPlan, catalog: readonly PriceableModel[]): bigint {
  const bought = classifierIsBoughtForTurn(
    plan.answerModels,
    plan.effortPin === undefined,
    plan.smartSlot,
    plan.classifierPool.length
  );
  if (!bought) return 0n;
  // The classifier's prompt lists the classifier-selectable pool exactly when
  // the model dimension is open; an effort-only turn's classifier names no model.
  return classifierReserveNanoUsd(catalog, plan.smartSlot ? plan.classifierPool : []);
}

/**
 * Who would answer: the pinned siblings, the ids nothing prices, and two readings
 * of the rest of the catalog.
 *
 * `candidatePool` is every non-pinned model and is what the PICKER renders — an
 * outlier is excluded from the product nowhere, so it keeps its row and stays one
 * deliberate click away. `classifierPool` is that pool minus `outlier(m)` and is
 * the CLASSIFIER-SELECTABLE set: the arrangements a smart slot could become, and
 * therefore the domain the hold's `MAX` ranges over (§Smart Model 3).
 */
interface SiblingPlan {
  readonly pinnedModels: readonly PriceableModel[];
  readonly unpriceableIds: readonly ModelId[];
  readonly candidatePool: readonly PriceableModel[];
  readonly classifierPool: readonly PriceableModel[];
  /**
   * The candidate ids `outlier(m)` removed — `candidatePool` minus
   * `classifierPool`. A PINNED model is never in here however extreme it is:
   * pinning IS the explicit selection §Smart Model 3 keeps available.
   */
  readonly excludedIds: ReadonlySet<string>;
  readonly smartSlot: boolean;
}

/**
 * How a pass's arrangement blocks collapse to the one reason a surface shows.
 *
 * The plan decides it, because the plan is what the presented set IS. With a
 * smart slot on the arrangements are the classifier pool — interchangeable, one
 * of them answering is enough — and a tier lock on some of its members is not the
 * payer's way out. Without a slot the selection is the turn and every sibling
 * must run, so the single-model order stands.
 *
 * Every reading that reduces arrangement blocks goes through here, which is what
 * keeps the send gate and the turn-level rung menu from answering a pool
 * differently. {@link arrangementBlock} is deliberately NOT one of them: it
 * reduces over one arrangement's SIBLINGS, which all have to run, so no member of
 * that set is an alternative to another.
 */
function reduceArrangementBlocks(reasons: readonly RefusalCode[], plan: SiblingPlan): RefusalCode {
  return plan.smartSlot ? poolRefusalPrecedence(reasons) : refusalPrecedence(reasons);
}

/**
 * §Smart Model 1's candidate order: ascending `maxCallCost`, identifier
 * tiebreak. It lives HERE, on the one producer, so the pool the picker renders,
 * the list the classifier is prompted with and the menu the server admits are
 * one ordering rather than three that must agree.
 *
 * It is not presentation. `candidates[0]` is the declared cheapest-presented
 * fallback the smart-slot execution runs whenever the classifier's answer names
 * nothing in the list, so position zero decides which model runs and what the
 * payer is billed for it. `maxCallCost` is the ordering quantity because it
 * carries no funding term — §Smart Model 1 requires an order reproducible from
 * the catalog and the prompt size alone, never from database row order, and a
 * balance-dependent order would move under the payer.
 *
 * The identifier tiebreak is load-bearing for the same reason it is on the
 * classifier engine: the catalog read is a whole-table select, so without it row
 * order would decide the fallback between two equally priced models.
 *
 * Distinct from {@link classifierEngineOf}'s order, deliberately: that one ranks
 * on the combined per-token rate and must stay basis-INDEPENDENT, or the two
 * option-set passes could pick different engines.
 */
function byAscendingTurnCost(
  basis: CallCostBasis
): (a: PriceableModel, b: PriceableModel) => number {
  return (a, b) => {
    const left = maxCallCostNanoUsd(a, basis);
    const right = maxCallCostNanoUsd(b, basis);
    if (left < right) return -1;
    if (left > right) return 1;
    if (a.modelId < b.modelId) return -1;
    return a.modelId > b.modelId ? 1 : 0;
  };
}

function planSiblings(
  catalog: readonly PriceableModel[],
  selection: Selection,
  basis: CallCostBasis
): SiblingPlan {
  const pinnedIds = selection.answerSources.models;
  const { priced: pinnedModels, unpriceableIds } = pricedSelection(catalog, pinnedIds);
  // The median is taken over the whole priceable catalog pool, pinned models
  // included: it must be reproducible from the catalog and the prompt size, and a
  // selection-dependent median would make the exclusion set move as the user
  // pins siblings.
  const outliers = outlierModelIds(catalog, basis);
  const candidatePool = catalog
    .filter((model) => !pinnedIds.includes(model.modelId))
    .toSorted(byAscendingTurnCost(basis));
  const excluded = candidatePool.filter((model) => outliers.has(model.modelId));
  return {
    pinnedModels,
    unpriceableIds,
    candidatePool,
    classifierPool: candidatePool.filter((model) => !outliers.has(model.modelId)),
    excludedIds: new Set(excluded.map((model) => model.modelId)),
    smartSlot: selection.answerSources.smartSlot,
  };
}

/**
 * The prompt half of a cost, with no funding term. Shared by the outlier pool
 * (which must stay balance-independent) and the arrangement pricing, so the two
 * cannot disagree about how wide the prompt leaves a model.
 */
function callCostBasisFor(input: CoreInput): CallCostBasis {
  // Trial turns are ephemeral, so nothing about them is stored and no storage
  // term appears anywhere in their pricing.
  const persists = input.tier !== 'trial';
  return callCostBasis(inputTokensOf(promptCharsOf(input.basis)), persists);
}

function pricingContextFor(input: CoreInput, plan: SiblingPlan): PricingContext {
  const { basis, tier, selection, catalog } = input;
  const { inputTokens, persists } = callCostBasisFor(input);
  const effortPin = selection.pinned.effort;
  const answerModels = plan.smartSlot
    ? [...plan.pinnedModels, ...plan.classifierPool]
    : plan.pinnedModels;
  // Pool SIZE decides whether the classifier is bought (§Reserve ⟺ classify), and
  // the pool it sizes is the classifier-selectable one — an excluded outlier is
  // not an option the classifier could be asked to choose between.
  const classifierPlan: ClassifierPlan = {
    answerModels,
    effortPin,
    smartSlot: plan.smartSlot,
    classifierPool: plan.classifierPool,
  };
  return {
    fundingNanoUsd: input.fundingNanoUsd,
    tier,
    modality: selection.modality,
    persists,
    inputTokens,
    promptChars: promptCharsOf(basis),
    inputChars: basis.inputChars,
    classifierReserveNanoUsd: classifierReserveOf(classifierPlan, catalog),
    toolLoop: undefined,
    smartSlot: plan.smartSlot,
    effortPin,
    answerModels,
    catalog,
    premiumThresholdNanoUsd: premiumPriceThresholdNanoUsd(catalog),
    nowMs: input.nowMs,
  };
}

/** The costliest arrangement of a set — the `MAX` the hold is sized against. */
function worstOf(arrangements: readonly Arrangement[]): Arrangement | undefined {
  let worst: Arrangement | undefined;
  for (const arrangement of arrangements) {
    if (worst === undefined || arrangement.totalNanoUsd > worst.totalNanoUsd) worst = arrangement;
  }
  return worst;
}

/**
 * One entry per catalog model, plus one per selected id nothing prices.
 *
 * **Every entry is graded on an arrangement whose MEMBERSHIP is fixed by the
 * selection, never by the funding or the prompt.** A pinned sibling is read off
 * the pinned siblings alone; every other catalog model is read off `pinned +
 * itself`, which is how a picker row answers "could I run this beside what I
 * have selected". That is what makes a presented ceiling monotone in `(funding,
 * basis)`, and hence `admissible ⊆ affordable` true per model and per option:
 * for a fixed membership, `fixedCosts` and `Σ variableRate` do not depend on the
 * funding, so `budgetBuys` only grows as the funding grows and only shrinks as
 * the basis grows, and `contextHeadroom` only shrinks as the basis grows.
 *
 * A candidate's verdict is the CONJUNCTION of that arrangement's siblings
 * ({@link arrangementBlock}), which preserves the monotonicity: every conjunct is
 * monotone in `(funding, basis)` and the membership conjoined over is fixed, so an
 * AND of them is monotone too. It is also what makes the presented candidate set
 * and the set the hold's `MAX` is taken over the same set.
 *
 * Two rejected alternatives, both non-monotone. Reading a pinned sibling off the
 * arrangement the HOLD is sized for: with a smart slot present that is the worst
 * VIABLE candidate, and which candidate is worst — indeed which are viable at all
 * — is itself a function of the funding and the basis, so a richer pass can clear
 * a costlier candidate into viability, adopt it, and solve FEWER shared tokens
 * than a poorer pass. Taking the worst over ALL candidates instead: an unclamped
 * arrangement's total is `funding − ((funding − fixedCosts) mod Σrate)`, so which
 * arrangement is costliest turns on a modulus and flips arbitrarily as the
 * funding moves.
 *
 * The consequence, deliberately accepted: when the smart slot resolves to a
 * candidate, the shared token count shrinks, so a pinned sibling's delivered
 * ceiling can be below the one presented here. The per-candidate entries are
 * where that is visible — each carries the ceiling of the arrangement it would
 * create, which is exactly what §The four notions asks of the candidate set
 * ("which candidates may fill the smart slot, and up to what ceiling each") —
 * and the hold, unchanged, still covers the worst of them.
 */
function entriesFor(reading: LoopReading, pricings: Pricings): readonly ModelEntry[] {
  const { plan } = pricings;
  const verdict = pricings.at(reading.verdictLoop);
  const pinnedArrangement = verdict.pinnedArrangement;
  const pinned =
    pinnedArrangement === undefined
      ? []
      : plan.pinnedModels.map((model) =>
          pinnedEntryFor(
            model,
            pinnedArrangement,
            verdict.context,
            reading.ceilingRungs.flatMap((effort): readonly RungCeiling[] => {
              const { context, pinnedArrangement: pinned } = pricings.at(effort);
              /* v8 ignore next -- the pinned arrangement exists in every pricing
                 whenever it exists in one; this narrows for the compiler */
              if (pinned === undefined) return [];
              return [{ effort, ceilingTokens: ceilingIn(pinned, model, context) }];
            })
          )
        );
  // A selected id nothing prices is a pinned row: the user named it, and the only
  // thing to say about it is that no arrangement contains it.
  const unpriceable = plan.unpriceableIds.map(
    (modelId): PinnedModelEntry => ({
      kind: 'pinned',
      modelId,
      availability: { available: false, reason: 'model_not_priceable' },
      ceilingTokens: 0,
      rungCeilings: [],
    })
  );
  const candidates = plan.candidatePool.map((candidate) =>
    candidateEntryFor(candidate, reading, pricings)
  );
  return [...pinned, ...unpriceable, ...candidates];
}

/**
 * Where each question the pass answers is priced: which loop grades the rows, the
 * candidate set and the send gate; which loop grades a candidate row's rungs;
 * which rungs publish their own ceilings; and which loop the set declares.
 */
interface LoopReading extends ToolLoopReading {
  /** Grades the rows, their ceilings, the candidate set and the send gate. */
  readonly verdictLoop: LoopEffort;
  /** The rungs each row publishes its own ceiling for: the menu's available rungs. */
  readonly ceilingRungs: readonly ResolvedReasoningEffort[];
  /**
   * The rungs whose own holds the set's hold is the largest of. Empty when the
   * hold is priced at the verdict loop alone.
   */
  readonly holdRungs: readonly ResolvedReasoningEffort[];
}

/** An effort option id as a rung of the domain, or `undefined` for none or an unknown id. */
function effortIdOf(option: OptionId | undefined): ResolvedReasoningEffort | undefined {
  return EFFORT_OPTION_IDS.find((optionId) => optionId === option);
}

/**
 * The lowest rung a set of models offers, or `undefined` when none reasons: the
 * loop an open axis grades its rows at, and the one the freeze bound prices.
 */
export function lowestRungOf(
  models: readonly PriceableModel[]
): ResolvedReasoningEffort | undefined {
  const [lowest] = offeredEffortRungs(models.map((model) => reasoningPlanModelOf(model)));
  return effortIdOf(lowest?.optionId);
}

/**
 * The loops one pass prices at.
 *
 * Under a pin every question is priced at the pin's loop, and with no reasoning
 * ladder at the ceiling loop.
 *
 * Under an open axis the rows, the candidate set and the send gate are graded at
 * the loop of the lowest rung the selection offers: the pinned siblings plus the
 * whole candidate pool, a membership no funding or prompt can move, so the
 * picker's verdicts stay monotone in the balance. Both passes grade each rung of
 * the menu and of a candidate row at that rung's own loop, so a rung carries one
 * verdict in the picker and at the send gate, and `admissible ⊆ affordable` holds
 * rung by rung: the passes then differ only in funding and basis, which push the
 * same way. The admissible pass alone sizes every available rung by its own budget
 * solve and holds the largest of those.
 */
function loopReadingFor(
  input: CoreInput,
  pricings: Pricings,
  turnDimensions: readonly DimensionAvailability[],
  offered: readonly DimensionOption[]
): LoopReading {
  const available = availableRungsOf(turnDimensions);
  const pin = pricings.base.effortPin;
  if (pin !== undefined) {
    const loop = effortIdOf(pin);
    return {
      verdictLoop: loop,
      ceilingRungs: available,
      holdRungs: [],
      toolLoopEffort: loop,
      holdEffort: loop,
    };
  }
  const floor = lowestRungOf([
    ...pricings.plan.pinnedModels,
    ...(pricings.plan.smartSlot ? pricings.plan.candidatePool : []),
  ]);
  const admissible = input.pass !== 'affordable';
  // An admissible turn offering no rung has no ladder, so it takes the ceiling loop.
  const lowest = admissible && offered.length === 0 ? undefined : floor;
  return {
    verdictLoop: lowest,
    ceilingRungs: available,
    holdRungs: admissible ? available : [],
    toolLoopEffort: offered.length === 0 ? undefined : (available.at(-1) ?? floor),
    holdEffort: lowest,
  };
}

/**
 * Which arrangements the turn could BECOME. A smart slot always resolves to a
 * candidate, so with one present these are the candidates' arrangements and the
 * pinned siblings alone are not among them — that combination is only the frame a
 * pinned ROW is diagnosed in. Without a slot the selection IS the turn, so there
 * is exactly one.
 *
 * This is where the hold's `MAX`-over-candidates and its `Σ`-over-siblings shapes
 * come from, so the two live in one expression rather than in a branch beside
 * every reading.
 */
function presentedArrangements(
  plan: SiblingPlan,
  pinnedArrangement: Arrangement | undefined,
  candidateArrangements: ReadonlyMap<string, Arrangement>
): readonly Arrangement[] {
  if (plan.smartSlot) {
    return plan.classifierPool.flatMap((candidate) => {
      const arrangement = candidateArrangements.get(candidate.modelId);
      /* v8 ignore next -- the classifier pool is a subset of the candidate pool,
         so every member has an arrangement; this narrows the lookup only */
      return arrangement === undefined ? [] : [arrangement];
    });
  }
  return pinnedArrangement === undefined ? [] : [pinnedArrangement];
}

/**
 * The turn-level refusal, or `undefined` when the turn can start — the send gate,
 * as a query over {@link reachableAt}: the turn starts iff some arrangement it
 * could become can run at the effort selected, and the reason is those
 * arrangements' own blocks in the precedence §Notices & Refusals 4 fixes.
 *
 * A selected id nothing prices refuses whatever the arrangements say, because it
 * is not an arrangement at all — nothing priced it.
 *
 * Which order the reasons reduce in is {@link reduceArrangementBlocks}'s call,
 * not this one's.
 */
function turnRefusal(plan: SiblingPlan, reachable: Reachable): RefusalCode | undefined {
  const unpriceable: readonly RefusalCode[] =
    plan.unpriceableIds.length > 0 ? ['model_not_priceable'] : [];
  if (reachable.running.length > 0) {
    const [onlyBlock] = unpriceable;
    return onlyBlock;
  }
  return reduceArrangementBlocks([...reachable.blocks, ...unpriceable], plan);
}

/** The rung whose loop a pass's hold was priced at, and that hold's arrangement. */
interface PricedHold {
  readonly arrangement: Arrangement | undefined;
  readonly effort: ResolvedReasoningEffort | undefined;
}

/**
 * The hold: the `MAX` over what the turn could become at the pass's own effort
 * selection: one candidate answers, so it is never a `Σ` across candidates.
 *
 * Under an open axis the admissible pass takes it over every available rung, each
 * arrangement priced at that rung's loop and read at the axis's cheapest corner,
 * because the classifier may decide any of those rungs and each runs at the
 * ceiling its own solve buys. The higher rung wins a tie. Otherwise it is the
 * send gate's own running set, at the verdict loop.
 */
function holdOf(reading: LoopReading, pricings: Pricings, sending: Reachable): PricedHold {
  if (reading.holdRungs.length === 0) {
    return { arrangement: worstOf(sending.running), effort: reading.holdEffort };
  }
  let best: PricedHold = { arrangement: undefined, effort: undefined };
  for (const effort of reading.holdRungs) {
    const at = pricings.at(effort);
    const worst = worstOf(reachableAt(at.presented, at.context).running);
    if (
      worst !== undefined &&
      (best.arrangement === undefined || worst.totalNanoUsd >= best.arrangement.totalNanoUsd)
    ) {
      best = { arrangement: worst, effort };
    }
  }
  return best;
}

/**
 * The turn's arrangements priced at each tool loop they are asked about. A loop
 * is keyed by its call budget, so rungs sharing a budget share one pricing, and a
 * turn with no tool on prices once whatever rung is asked.
 */
interface Pricings {
  readonly plan: SiblingPlan;
  /** The facts no loop changes: the pin, the modality, the catalog. */
  readonly base: PricingContext;
  readonly at: (effort: LoopEffort) => Pricing;
}

/** The rung whose tool loop prices an arrangement; `undefined` is the ceiling loop. */
type LoopEffort = ResolvedReasoningEffort | undefined;

/** The turn's arrangements at one tool loop. */
interface Pricing {
  readonly context: PricingContext;
  readonly candidateArrangements: ReadonlyMap<string, Arrangement>;
  readonly pinnedArrangement: Arrangement | undefined;
  /** What the turn could become: {@link presentedArrangements}. */
  readonly presented: readonly Arrangement[];
}

function pricingsFor(input: CoreInput, plan: SiblingPlan): Pricings {
  const base = pricingContextFor(input, plan);
  const byCalls = new Map<number, Pricing>();
  const at = (effort: LoopEffort): Pricing => {
    const calls = input.selection.webSearch ? toolCallCapFor(effort) : 0;
    const cached = byCalls.get(calls);
    if (cached !== undefined) return cached;
    const context: PricingContext = {
      ...base,
      toolLoop: calls === 0 ? undefined : toolLoopBound([WEB_SEARCH_TOOL_NAME], calls),
    };
    const candidateArrangements = new Map<string, Arrangement>(
      plan.candidatePool.map((candidate) => [
        candidate.modelId,
        priceArrangement([...plan.pinnedModels, candidate], context, candidate.modelId),
      ])
    );
    const pinnedArrangement =
      plan.pinnedModels.length > 0 ? priceArrangement(plan.pinnedModels, context) : undefined;
    const pricing: Pricing = {
      context,
      candidateArrangements,
      pinnedArrangement,
      presented: presentedArrangements(plan, pinnedArrangement, candidateArrangements),
    };
    byCalls.set(calls, pricing);
    return pricing;
  };
  return { plan, base, at };
}

export function evaluateTurn(input: CoreInput): CoreResult {
  const { selection, catalog } = input;
  // A per-unit modality prices nothing token-shaped, so there is no entry to
  // render and no ceiling to grade one on. The refusal stands rather than
  // widening: a media row is not a `PriceableModel` and admitting one here would
  // put it in the pool the outlier median, the premium price threshold and the
  // classifier engine are taken over. A media turn is graded by the per-unit
  // core in `media-core.ts` instead, over the disjoint `MediaModel` projection.
  if (selection.modality !== 'text') return refused('modality_not_priceable', [], [], NO_LOOP);

  const plan = planSiblings(catalog, selection, callCostBasisFor(input));
  const pricings = pricingsFor(input, plan);
  const offered = offeredRungs(presentedMembers(plan));
  const turnDimensions = turnDimensionsFor(offered, pricings);
  const reading = loopReadingFor(input, pricings, turnDimensions, offered);
  const verdict = pricings.at(reading.verdictLoop);
  const sending = reachableAt(verdict.presented, verdict.context, pricings.base.effortPin);

  const entries = entriesFor(reading, pricings);
  // `runnable` is the witness for what can run in THIS turn, so a high-cost
  // outlier is not among it: the smart slot cannot resolve to one, and the hold's
  // `MAX` is not taken over it. Its ROW stays in `all`, marked available, because
  // pinning it is a different selection and one the payer can still make
  // (§Smart Model 3). Membership of `all` is therefore wider than `runnable`,
  // which is what keeps `hold ≥ every runnable candidate's arrangement` true.
  const runnable = entries.filter(
    (entry) => entry.availability.available && !plan.excludedIds.has(entry.modelId)
  );

  const { toolLoopEffort } = reading;
  const loops: ToolLoopReading = { toolLoopEffort, holdEffort: reading.holdEffort };
  const refusal = turnRefusal(plan, sending);
  if (refusal !== undefined) return refused(refusal, entries, turnDimensions, loops);

  // Read only once the turn is known sendable, which is what makes it total.
  const hold = holdOf(reading, pricings, sending);
  const [firstRunnable, ...restRunnable] = runnable;
  /* v8 ignore next 3 -- unreachable: nothing blocked above means some presented
     arrangement runs, so its own row is available and its price is in hand */
  if (firstRunnable === undefined || hold.arrangement === undefined) {
    return refused('model_not_priceable', entries, turnDimensions, loops);
  }

  const setAside = settledReserveNanoUsd(pricings, turnDimensions);
  return {
    optionSet: {
      sendable: true,
      runnable: [firstRunnable, ...restRunnable],
      all: entries,
      turnDimensions,
      toolLoopEffort,
      holdEffort: hold.effort,
    },
    totalNanoUsd: hold.arrangement.totalNanoUsd - setAside,
    lineItems: hold.arrangement.lineItems.filter(
      (item) => setAside === 0n || item.label !== CLASSIFIER_LINE_ITEM
    ),
    setAsideNanoUsd: setAside,
  };
}

/**
 * The reserve an open effort axis sets aside without holding: its whole reserve
 * when the menu marks exactly one rung available and no open model axis buys the
 * call, and nothing otherwise.
 *
 * One available rung is the single choice `docs/BILLING.md` §Reasoning Effort 5
 * settles without a call, so the turn neither makes the call nor holds for it. The
 * solves keep deducting the reserve all the same: dropping it there would raise
 * every rung's ceiling at the balance a second rung becomes available and lower it
 * again past that balance, and it would move the send threshold and the freeze
 * bound, which both price the reserve of a turn offering two or more rungs.
 */
function settledReserveNanoUsd(
  pricings: Pricings,
  turnDimensions: readonly DimensionAvailability[]
): bigint {
  const { base, plan } = pricings;
  if (base.effortPin !== undefined || availableRungsOf(turnDimensions).length !== 1) return 0n;
  if (modelAxisBuysClassifier(plan.smartSlot, plan.classifierPool.length)) return 0n;
  return base.classifierReserveNanoUsd;
}
