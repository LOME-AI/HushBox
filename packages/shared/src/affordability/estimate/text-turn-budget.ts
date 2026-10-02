/**
 * The composer's budget for a text turn: how many output tokens the turn can
 * carry and how much of the context it fills. It carries no price: a text
 * turn shows none before it is sent.
 *
 * It exists so that a surface can ask WHAT it wants priced — this prompt, these
 * served rows, this payer — without naming HOW the price decomposes. The rates,
 * the cost curve and the token ratios stay behind the wall (`docs/BILLING.md`
 * §Where the Code Lives); a caller assembling them itself would be a second
 * estimator, and the composer's figures would drift from the admission gate's
 * the first time either side changed.
 *
 * Every term is composed, none restated: each sibling is priced on the price
 * core's cost curve, the curve the server's admission estimate evaluates, with
 * each step at the long-context tier its own input reaches, so identical inputs
 * give identical nano. A turn with the Smart slot is answered by the turn
 * producer instead: its figure is the largest ceiling the producer grades any
 * candidate the slot can resolve to at.
 */

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { computePromptCapacity, getEffectiveBalanceNano } from './pre-adapters.ts';
import { largestFundedOutput, sumCurves, textCallCurve } from '../price/curve.ts';
import { inputTokensOf } from '../price/quantities.ts';
import { pricingFromWire, tokenPricingOf } from '../price/wire.ts';
import { toolCallCapFor, toolLoopBound } from '../tool-loop.ts';
import { MONEY_SOLVE_CAP_TOKENS } from '../turn/turn-arithmetic.ts';
import { WEB_SEARCH_TOOL_NAME } from '../../web-search/web-search-contract.ts';
import type { UserTier } from '../money/tiers.ts';
import type { CostCurve } from '../price/curve.ts';
import type { TokenPricing } from '../price/schedule.ts';
import type { ResolvedReasoningEffort } from '../reasoning-effort.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { TurnOptions } from '../turn/turn-types.ts';
import type { Model } from '../../schemas/api/models.ts';

export interface TextTurnBudgetInput {
  /**
   * The served row of every sibling that will answer. An empty selection is
   * unpriceable, not free. The Smart Model row is the Smart slot's own answer:
   * the slot runs through the `smartModel` node, whose schema has no tools field,
   * so it never carries the search tool, and its figure is read from
   * {@link TextTurnBudgetInput.turnOptions}, never priced at the rates the row
   * serves.
   */
  readonly models: readonly Model[];
  /**
   * The turn producer's pair for this selection, or `undefined` while it has not
   * answered. Read only when the Smart Model row is selected: the slot's answer
   * is the largest ceiling among the admissible set's runnable candidates, the
   * models and ceilings the producer grades the slot on, and a refused set
   * funds no answer.
   */
  readonly turnOptions: TurnOptions | undefined;
  /** The measured total: system prompt + history + the message being composed. */
  readonly promptChars: number;
  /**
   * The message being composed, on its own. Storage is the only leg that reads
   * it: the turn stores one new user message, while the system prompt and the
   * resent history rest nowhere new. The input TOKEN leg still prices
   * {@link TextTurnBudgetInput.promptChars}, which is what the provider receives.
   */
  readonly inputChars: number;
  /**
   * The PAYER's tier, never the sender's. It fixes the funding arm, so an
   * owner-funded group turn sizes exactly as the owner's own would (§Group
   * Funding 1).
   */
  readonly payerTier: UserTier;
  /**
   * The payer's SERVED spendable — hold-aware and already cushioned. Ignored
   * for the one tier with no funding door to serve it (see below).
   */
  readonly payerSpendableNanoUsd: bigint;
  /** Whether the web-search tool is on. When it is, each named sibling prices its tool loop. */
  readonly webSearch: boolean;
  /**
   * The rung whose tool loop a searching sibling prices: the one the producer
   * took its hold at, read off the produced option set (`holdEffort`) and never
   * derived here. `undefined` prices the ceiling loop, the turn with no ladder.
   */
  readonly loopEffort: ResolvedReasoningEffort | undefined;
  /**
   * The reasoning token budget B the turn will engage (0 = reasoning-free).
   * Reasoning tokens are output tokens, so B is taken out of the output-token
   * pool before the answer's share, {@link TextTurnBudget.maxAnswerTokens}.
   */
  readonly reasoningBudgetTokens: number;
}

export interface TextTurnBudget {
  /**
   * The turn's output-token pool, or `undefined` while a Smart-slot turn waits on
   * the turn producer's pair. With named siblings alone it is the largest output
   * the effective balance funds on their summed cost curve, and 0 below the
   * minimum answer. With the Smart slot it is the largest ceiling among the
   * producer's runnable candidates, each capped by its provider limit, its
   * context headroom and its budget, and 0 when the producer refuses the turn.
   */
  readonly maxOutputTokens: number | undefined;
  /**
   * The share of that pool left for the ANSWER once the turn's pinned
   * reasoning budget is taken out — reasoning tokens are output tokens drawn
   * from the same pool (`docs/BILLING.md` §Terms, `H(m, e)`). Zero when the
   * budget alone exhausts the pool, and `undefined` exactly when
   * `maxOutputTokens` is. A surface asking how long a reply the turn can carry
   * means this figure, never `maxOutputTokens`.
   */
  readonly maxAnswerTokens: number | undefined;
  /** Input tokens the prompt is estimated to occupy. */
  readonly estimatedInputTokens: number;
  /** Context usage in tokens: input tokens plus the minimum output reserve. */
  readonly currentUsage: number;
  /** Usage as a percentage of the limiting context length. */
  readonly capacityPercent: number;
}

/**
 * The balance the affordability solve gates against.
 *
 * Every payer with a funding door reads ONE served number, with no branch
 * between paid, free and owner-funded: which wallet funds the turn was decided
 * server-side and is already baked into the figure, so a branch here could only
 * reintroduce a second funding authority. The trial is the one tier with no
 * door at all, so its fixed per-message ceiling is the one arm that stays
 * client-derivable (§Affordability 8).
 */
function effectiveBalanceNanoUsd(input: TextTurnBudgetInput): bigint {
  if (input.payerTier === 'trial') return getEffectiveBalanceNano('trial', 0n, 0n);
  return input.payerSpendableNanoUsd;
}

/** One sibling's served price, or `undefined` when the row states no token price. */
function tokenPriceOf(model: Model): TokenPricing | undefined {
  const pricing = pricingFromWire(model);
  return pricing === undefined ? undefined : tokenPricingOf(pricing);
}

/**
 * The Smart slot's answer as the turn producer grades it: the largest ceiling
 * among the admissible set's runnable candidates, 0 when the producer refuses
 * the turn, `undefined` while it has not answered.
 */
function slotCeilingTokens(options: TurnOptions | undefined): number | undefined {
  if (options === undefined) return undefined;
  const set = options.admissible;
  if (!set.sendable) return 0;
  let largest = 0;
  for (const entry of set.runnable) {
    if (entry.kind === 'candidate' && entry.ceilingTokens > largest) largest = entry.ceilingTokens;
  }
  return largest;
}

/**
 * Every named sibling of a searching turn carries the search loop, priced at the
 * call budget of the loop effort it was handed. The new message's storage rides
 * the first sibling alone, because a turn stores it once.
 */
function siblingCurves(
  input: TextTurnBudgetInput,
  prices: readonly TokenPricing[],
  promptTokens: number
): readonly CostCurve[] {
  const searchLoop: ToolLoopBound | undefined = input.webSearch
    ? toolLoopBound([WEB_SEARCH_TOOL_NAME], toolCallCapFor(input.loopEffort))
    : undefined;
  return prices.map((pricing, index) =>
    textCallCurve(
      pricing,
      'reserve',
      {
        promptTokens,
        ...(searchLoop === undefined ? {} : { loop: searchLoop }),
        persists: true,
        newMessageChars: index === 0 ? input.inputChars : 0,
      },
      MONEY_SOLVE_CAP_TOKENS
    )
  );
}

/** The answer figures for an output-token pool, both `undefined` while it waits on the producer. */
function answerFigures(
  funded: number | undefined,
  reasoningBudgetTokens: number
): Pick<TextTurnBudget, 'maxOutputTokens' | 'maxAnswerTokens'> {
  if (funded === undefined) return { maxOutputTokens: undefined, maxAnswerTokens: undefined };
  // Funding short of the minimum answer funds no answer at all: the send gate
  // refuses that turn, so the preview offers nothing rather than a stub.
  const maxOutputTokens = funded >= MINIMUM_OUTPUT_TOKENS ? funded : 0;
  return { maxOutputTokens, maxAnswerTokens: Math.max(0, maxOutputTokens - reasoningBudgetTokens) };
}

/**
 * The composer's budget, or `undefined` when a named selected row states no
 * token price: an unpriceable sibling makes the turn unpriceable, and an absence
 * is what carries that out, never a figure that reads as a priced turn. A
 * Smart-slot turn whose producer pair has not arrived keeps its capacity, which
 * does not depend on the pair; only its answer figures are `undefined`.
 */
export function textTurnBudget(input: TextTurnBudgetInput): TextTurnBudget | undefined {
  // No figure can carry "no answer" out of here: zeros would read as a priced
  // turn that funds nothing, not as a turn with no model. The caller decides
  // what an empty composer shows; the money layer refuses to price one.
  if (input.models.length === 0) {
    throw new RangeError('textTurnBudget: a turn with no selected model is unpriceable');
  }
  // `inputChars` reaches the storage leg raw, so a negative or fractional one is
  // refused here; a bad `promptChars` is refused by its conversion to tokens.
  if (!Number.isSafeInteger(input.inputChars) || input.inputChars < 0) {
    throw new RangeError('textTurnBudget: inputChars must be a non-negative integer');
  }
  const promptTokens = inputTokensOf(input.promptChars);
  const prices: TokenPricing[] = [];
  for (const model of input.models) {
    if (model.isSmartModel === true) continue;
    const pricing = tokenPriceOf(model);
    if (pricing === undefined) return undefined;
    prices.push(pricing);
  }
  const hasSmartSlot = prices.length < input.models.length;
  // The Smart slot's answer is the producer's: its candidates are the models the
  // slot can resolve to beside the pinned siblings, which no rule here restates.
  const funded = hasSmartSlot
    ? slotCeilingTokens(input.turnOptions)
    : largestFundedOutput(
        sumCurves(siblingCurves(input, prices, promptTokens)),
        effectiveBalanceNanoUsd(input)
      );
  const capacity = computePromptCapacity({
    promptCharacterCount: input.promptChars,
    modelContextLength: Math.min(...input.models.map((model) => model.contextLength)),
  });

  return {
    ...answerFigures(funded, input.reasoningBudgetTokens),
    estimatedInputTokens: promptTokens,
    currentUsage: capacity.currentUsage,
    capacityPercent: capacity.capacityPercent,
  };
}
