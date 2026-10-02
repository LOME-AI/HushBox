/**
 * `minTurnCost` (`docs/BILLING.md` §Math & Terms) — the least a turn could
 * possibly cost if a given payer paid for it. It is the number the payer
 * decision consumes, never a full estimate: an estimate's ceiling is bounded by
 * the payer's own funding, so pricing one in order to CHOOSE the payer would
 * need the answer first. This is a bound, and bounds are what a decision that
 * gates pricing may consume.
 *
 * It is priced at the `eligible(m)` corner — every fixed term plus the cheapest
 * reasoning rung the model can actually run and a minimum viable answer.
 * Dropping the fixed terms or the reasoning term yields a number that is
 * smaller but NOT sufficient: a headroom clearing it would still fail
 * admission, which is the permanent-refusal class the comparison exists to
 * prevent.
 *
 * Composition only — every term is a named §Math & Terms function, and no
 * formula is restated here. Pure: counts, rates and identifiers, no clock and
 * no content.
 */

import { classifierEngineOf } from '../classifier-engine.ts';
import { cheapestEffortOption } from '../dimensions/effort.ts';
import { classifierWorstCaseNanoUsd } from '../estimate/smart-model-affordability.ts';
import { inputTokensOf } from '../price/quantities.ts';
import { toolCallCapFor, toolLoopBound } from '../tool-loop.ts';
import { lowestRungOf, smartSlotBuysClassifier } from '../turn/turn-core.ts';
import { WEB_SEARCH_TOOL_NAME } from '../../web-search/web-search-contract.ts';
import {
  callCostBasis,
  costNanoUsd,
  feasible,
  maxCallCostTokens,
  outlierModelIds,
  requiredCeilingTokens,
} from '../turn/turn-arithmetic.ts';
import { promptBasisFromTotal, promptCharsOf } from '../turn/turn-types.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { ReasoningEffortSelection, ResolvedReasoningEffort } from '../reasoning-effort.ts';
import type { ToolName } from '../tool-loop.ts';
import type { NonEmpty, PromptBasis } from '../turn/turn-types.ts';

/** One answering sibling and the tools its node carries. */
export interface MinTurnCostSibling {
  readonly model: PriceableModel;
  /**
   * The tools the sibling's node carries: empty for a node that carries none,
   * and always empty for the Smart slot's own answer, whose `smartModel` node
   * has no tools field.
   */
  readonly tools: readonly ToolName[];
}

export interface MinTurnCostInput {
  /** Every sibling that will answer. A turn with no model is unpriceable, not free. */
  readonly siblings: NonEmpty<MinTurnCostSibling>;
  /**
   * `promptChars` — the measured total (system prompt + instructions + history
   * + input). Two counts rather than a {@link PromptBasis}: the bound's two
   * prompt legs read exactly these two numbers, so a caller splitting the total
   * into four components would be measuring what nothing here consumes.
   */
  readonly promptChars: number;
  /**
   * The NEW message's own characters, of {@link MinTurnCostInput.promptChars}.
   * Storage is the only leg that reads it: a turn stores one new user message
   * row, so the rest of the prompt rests nowhere new. Zero on a re-run that
   * stores no message at all.
   */
  readonly inputChars: number;
  /** Whether the turn's content will rest. A non-persisting turn carries no storage term. */
  readonly persists: boolean;
  /** Non-zero exactly when a classifier may run (§Reserve ⟺ classify). */
  readonly classifierReserveNanoUsd: bigint;
  /**
   * The send's reasoning selection. It fixes the tool loop a tool-carrying
   * sibling prices: the pin's, the lowest rung the siblings offer under `auto`,
   * and the ceiling loop when the send carries none.
   */
  readonly reasoningEffort: ReasoningEffortSelection | undefined;
}

/**
 * The loop the least a turn could cost is priced at: the lowest rung the turn
 * can fall to. A pin fixes it; an open axis falls as low as the lowest rung its
 * answer sources offer, which is the loop the producer's send gate grades at; a
 * send with no selection has no ladder and takes the ceiling loop.
 */
function floorLoopEffort(
  selection: ReasoningEffortSelection | undefined,
  answerSources: readonly PriceableModel[]
): ResolvedReasoningEffort | undefined {
  return selection === 'auto' ? lowestRungOf(answerSources) : selection;
}

/**
 * The widest `B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS` across the siblings.
 *
 * It is a MAX rather than a per-sibling sum for a reason the single-model case
 * hides: the siblings share ONE token count `T`, so every sibling's ceiling is
 * clamped to it, and a turn is runnable only when `T` reaches the WIDEST
 * corner. Pricing each sibling at its own corner (`Σᵢ cornerᵢ × rateᵢ`) yields
 * a weighted average of the corners, which is below the widest one whenever the
 * corners differ — a mandatory-reasoning sibling beside an ordinary one — so it
 * would clear a headroom that cannot in fact run the turn. With one sibling the
 * two readings are the same number.
 */
function widestCornerTokens(siblings: NonEmpty<MinTurnCostSibling>): number {
  return Math.max(
    ...siblings.map(({ model }) => requiredCeilingTokens(model, cheapestEffortOption(model)))
  );
}

/**
 * `minTurnCost` = the classifier reserve plus `Σᵢ cost(mᵢ, corner)`: every
 * sibling priced at the one shared corner. A sibling that carries a tool prices
 * its loop at the lowest rung the turn can fall to ({@link floorLoopEffort}).
 */
export function minTurnCostNanoUsd(input: MinTurnCostInput): bigint {
  return minTurnCostAtLoop(
    input,
    floorLoopEffort(
      input.reasoningEffort,
      input.siblings.map(({ model }) => model)
    )
  );
}

/** {@link minTurnCostNanoUsd} with the tool loop's rung already decided. */
function minTurnCostAtLoop(
  input: Omit<MinTurnCostInput, 'reasoningEffort'>,
  loopEffort: ResolvedReasoningEffort | undefined
): bigint {
  const basis = promptBasisFromTotal(input);
  const inputTokens = inputTokensOf(promptCharsOf(basis));
  const corner = widestCornerTokens(input.siblings);
  return input.siblings.reduce(
    (total, { model, tools }, index) =>
      total +
      costNanoUsd(model, corner, {
        inputTokens,
        inputChars: index === 0 ? basis.inputChars : 0,
        persists: input.persists,
        ...(tools.length === 0
          ? {}
          : { toolLoop: toolLoopBound(tools, toolCallCapFor(loopEffort)) }),
      }),
    input.classifierReserveNanoUsd
  );
}

/** The Smart slot's `minTurnCost` inputs — a pool rather than named siblings. */
export interface SmartSlotMinTurnCostInput {
  /** The text-turn pool, as the one shared projection draws it. */
  readonly pool: readonly PriceableModel[];
  /**
   * The siblings the turn PINNED by name, when the slot answers beside them.
   * They are priced into every arrangement AND removed from the set the slot
   * could resolve to — the slot re-picking a pinned model would price, and the
   * run would bill, two answers from the same model. Empty on a slot-only turn,
   * and required rather than defaulted: a caller that forgot it would silently
   * price a different turn.
   */
  readonly pinned: readonly PriceableModel[];
  /** `promptChars` — the measured total the send will carry. */
  readonly promptChars: number;
  /** The new message's own characters, of {@link SmartSlotMinTurnCostInput.promptChars}. */
  readonly inputChars: number;
  /** Whether the turn's content will rest. */
  readonly persists: boolean;
  /** Whether the web-search tool is on. */
  readonly webSearch: boolean;
  /** The send's reasoning selection, as {@link MinTurnCostInput.reasoningEffort}. */
  readonly reasoningEffort: ReasoningEffortSelection | undefined;
}

/**
 * `minTurnCost` for a turn whose only answer source is the smart slot: the least
 * any arrangement the slot could become could cost. The slot resolves to exactly
 * one classifier-selectable model, so the bound is the MINIMUM over that set
 * rather than a sum — and it is the funding boundary the producer sends at,
 * which is what the payer freeze must compare group headroom against.
 *
 * Two terms the pool decides and a caller must not: the classifier reserve is
 * carried exactly when the pool offers the classifier a choice
 * ({@link smartSlotBuysClassifier}), even where a funded run settles effort at its
 * one available rung and sets the reserve aside, because the send threshold this
 * bounds still deducts it; and an `outlier(m)` is excluded
 * because the slot cannot resolve to one (§Smart Model 3) — a bound priced on a
 * model the slot can never pick is a bound on a different turn.
 *
 * `undefined` when nothing in the pool prices a turn; absent rather than zero,
 * because "no price" is not "free".
 */
export function smartSlotMinTurnCostNanoUsd(input: SmartSlotMinTurnCostInput): bigint | undefined {
  const inputTokens = inputTokensOf(promptCharsOf(promptBasisFromTotal(input)));
  // Two different sets, and the difference is load-bearing. The SELECTABLE set
  // is what the classifier is prompted with and what decides whether the call is
  // bought — the turn core's own `classifierPool`, the pool minus `outlier(m)`.
  // The RUNNABLE subset is what the bound may be priced on.
  const { pinned } = input;
  const selectable = classifierSelectable(input, inputTokens);
  const runnable = selectable.filter((model) =>
    // The money bound is deliberately absent: `maxCallCostTokens` is what the
    // model can physically emit, so this asks only whether ANY funding could run
    // it. A window too small to hold the prompt AND a minimum answer at the
    // model's own cheapest rung is a CAPABILITY refusal, so no balance clears it,
    // and pricing the bound there puts the threshold below what the producer
    // sends at — the direction that admits a turn the run then refuses however
    // much is in the wallet.
    feasible(model, cheapestEffortOption(model), maxCallCostTokens(model, inputTokens))
  );
  const reserve = slotClassifierReserveNanoUsd(input.pool, selectable);
  const tools: readonly ToolName[] = input.webSearch ? [WEB_SEARCH_TOOL_NAME] : [];
  // An open axis falls to the lowest rung the pinned siblings and the whole pool
  // offer, a membership no prompt moves: the loop the producer's send gate
  // grades a slot turn at.
  const loopEffort = floorLoopEffort(input.reasoningEffort, [...pinned, ...input.pool]);
  /* v8 ignore next -- the reserve is absent only when the pool offers no engine,
     which a non-empty selectable set rules out; kept fail-closed so a bound is
     never priced with no reserve in it */
  if (reserve === undefined) return undefined;
  let lowest: bigint | undefined;
  for (const model of runnable) {
    const cost = minTurnCostAtLoop(
      {
        // `model` is what the slot would resolve to, and its node carries no tool:
        // the tool loop lands on the pinned siblings alone.
        siblings: [{ model, tools: [] }, ...pinned.map((sibling) => ({ model: sibling, tools }))],
        promptChars: input.promptChars,
        inputChars: input.inputChars,
        persists: input.persists,
        classifierReserveNanoUsd: reserve,
      },
      loopEffort
    );
    if (lowest === undefined || cost < lowest) lowest = cost;
  }
  return lowest;
}

/**
 * The pool minus the pinned siblings and minus `outlier(m)` — the turn core's
 * classifier-selectable set. The outlier median is taken over the WHOLE pool,
 * pinned members included, exactly as the core does: a selection-dependent
 * median would move the exclusion set as the user pins siblings.
 */
function classifierSelectable(
  input: SmartSlotMinTurnCostInput,
  inputTokens: number
): readonly PriceableModel[] {
  const outliers = outlierModelIds(input.pool, callCostBasis(inputTokens, input.persists));
  const pinnedIds = new Set(input.pinned.map((model) => model.modelId));
  return input.pool.filter(
    (model) => !outliers.has(model.modelId) && !pinnedIds.has(model.modelId)
  );
}

/**
 * The reserve the slot's bound carries: the ENGINE is the cheapest model of the
 * whole pool and the PROMPTED list is the classifier-selectable set, which is
 * the same pair the turn core prices its own reserve on.
 */
function slotClassifierReserveNanoUsd(
  pool: readonly PriceableModel[],
  selectable: readonly PriceableModel[]
): bigint | undefined {
  if (!smartSlotBuysClassifier(selectable)) return 0n;
  const engine = classifierEngineOf(pool);
  /* v8 ignore next -- a non-empty selectable set means a non-empty pool, so the
     engine is in hand; this narrows for the compiler only */
  if (engine === undefined) return undefined;
  return classifierWorstCaseNanoUsd(
    engine,
    selectable.map((model) => ({ id: model.modelId }))
  );
}
