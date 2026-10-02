/**
 * `getTurnOptions` — the token turn's producer. Nothing else in the system may
 * construct a {@link TurnOptions} or either of its option sets. Its per-unit
 * counterpart, {@link getMediaTurnOptions}, lives beside it at the foot of this
 * file: one file publishes every produced option set, so a surface has one place
 * to look and no place to compute its own.
 *
 * It is called ONCE, with the composed prompt basis, and internally evaluates
 * one pure core over two `(funding, basis)` pairs:
 *
 * | set          | funding                          | basis         |
 * | ------------ | -------------------------------- | ------------- |
 * | `affordable` | `effectiveBalance` = spendable + held | empty    |
 * | `admissible` | `spendable`                      | the composed one |
 *
 * The two sets differ in TWO inputs, not one. `affordable` answers a question
 * about the model and the payer's money, so it must not move while the user
 * types; `admissible` answers what can start right now. The producer applies
 * both substitutions itself — no signature here accepts a basis for the
 * `affordable` set — so a prompt-dependent floor and a hold-blind send gate are
 * unobtainable rather than merely discouraged (`docs/BILLING.md` §Affordability
 * 2, §Affordability §Scope).
 *
 * `admissible ⊆ affordable` follows because both differing inputs push the same
 * way: `spendable ≤ effectiveBalance` shrinks what the money buys, and a real
 * prompt basis is never smaller than the empty one, so it shrinks context
 * headroom and raises fixed costs.
 *
 * The fourth argument is a catalog SNAPSHOT rather than the catalog itself.
 * §The public surface already documents a fourth `catalog` argument and calls it
 * necessary rather than convenient — a `Selection` names models by identifier, and
 * §Smart Model requires the pool to be derivable from the catalog and the prompt
 * size, so the pool has to arrive from somewhere. What this signature adds to that
 * argument is the reference instant, because both legs of premium classification
 * are properties of the pool AS OF an instant: the price percentile is taken over
 * the pool, and the recency window is measured from the instant
 * (§Model Classification). This module holds no clock, so the instant arrives as
 * an argument or not at all — and one snapshot feeds both passes, so `affordable`
 * and `admissible` cannot classify a model differently.
 */

import { nanoUSD } from '../money/nano-usd.ts';
import { PREMIUM_RECENCY_MS } from '../money/premium.ts';
import { evaluateMediaTurn } from './media-core.ts';
import { evaluateTurn } from './turn-core.ts';
import { EMPTY_PROMPT_BASIS, poolRefusalPrecedence } from './turn-types.ts';
import type { MediaModel } from '../dimensions/media-model.ts';
import type { MediaOptionSet, MediaSelection } from './media-core.ts';
import type {
  Availability,
  CatalogSnapshot,
  FundingSnapshot,
  OptionSet,
  PromptBasis,
  Selection,
  TurnOptions,
} from './turn-types.ts';

/**
 * The snapshot's instant, refused unless it can carry the meaning premium
 * classification gives it.
 *
 * This is the same posture the module already takes on a count (`promptChars`
 * throws) and on an identifier (`ModelId` refuses the empty string), and it is
 * needed for the same reason: classification is a money verdict, so an unusable
 * instant must not be absorbed. Absorbing one fails PERMISSIVE — a
 * non-comparable instant makes every recency test false, which turns a premium
 * row available rather than refusing it.
 *
 * The lower bound is the recency window itself: below it the window reaches
 * before the epoch, so "released recently" would be true of every model ever
 * released. There is deliberately NO upper bound — a far-future instant is a
 * representable instant whose recency leg is legitimately vacuous, and this module
 * holds no clock to check a caller's against. What protects money there is the
 * other leg: the price percentile reads no clock at all.
 */
function requireUsableInstant(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < PREMIUM_RECENCY_MS) {
    throw new RangeError(
      'getTurnOptions: the catalog snapshot instant must be a safe integer no earlier than the premium recency window'
    );
  }
}

/**
 * What a payer may pick, with no prompt in hand. It is the pair's `affordable`
 * half and nothing else — deliberately not a `TurnOptions` with fields left
 * out, because a shape carrying an absent `admissible` is a shape a caller can
 * read a send gate off by treating the absence as a refusal or a pass.
 */
export interface AffordableOptions {
  /** From `effectiveBalance` and the empty basis. Drives greying. */
  readonly affordable: OptionSet;
  /** The smart slot's own verdict, taken over the same set (see {@link smartSlotAvailability}). */
  readonly smartSlot: Availability;
}

/**
 * The prompt-INDEPENDENT half of the pair, on its own. A surface asking only
 * "what may this payer pick at all" — a model picker, which grades rows before
 * a prompt exists — has no basis to pass and must not have to invent one: the
 * empty basis is an argument, and a caller holding it can also hand it to
 * {@link getTurnOptions}, whose `admissible` set would then answer the send
 * gate's question from a zero prompt. That answer is strictly more permissive
 * than the real gate, so this read withholds admissibility entirely rather than
 * defaulting its basis, and there is no field on the result to default.
 *
 * It is the same evaluation {@link getTurnOptions} grades greying from, called
 * once here and reused there, so the two reads cannot answer differently.
 */
export function getAffordableOptions(
  funding: FundingSnapshot,
  selection: Selection,
  catalog: CatalogSnapshot
): AffordableOptions {
  requireUsableInstant(catalog.nowMs);
  const affordable = evaluateTurn({
    // `effectiveBalance = spendable + holds`: both funding numbers are derivable
    // from what the wire already serves, so there is no second request for this.
    fundingNanoUsd: BigInt(funding.spendableNanoUsd) + BigInt(funding.heldNanoUsd),
    basis: EMPTY_PROMPT_BASIS,
    selection,
    catalog: catalog.models,
    tier: funding.payerTier,
    nowMs: catalog.nowMs,
    pass: 'affordable',
  });
  return {
    affordable: affordable.optionSet,
    // Taken over `affordable`, the set every other row's greying is read from,
    // so the slot cannot say a different money thing than the rows beside it.
    smartSlot: smartSlotAvailability(affordable.optionSet),
  };
}

export function getTurnOptions(
  funding: FundingSnapshot,
  basis: PromptBasis,
  selection: Selection,
  catalog: CatalogSnapshot
): TurnOptions {
  const spendableNanoUsd = BigInt(funding.spendableNanoUsd);
  const picker = getAffordableOptions(funding, selection, catalog);

  const admissible = evaluateTurn({
    fundingNanoUsd: spendableNanoUsd,
    basis,
    selection,
    catalog: catalog.models,
    tier: funding.payerTier,
    nowMs: catalog.nowMs,
  });

  // A hold is only ever taken against `spendable`, and only when the turn can
  // actually start; the affordable pass's own total is deliberately discarded.
  const holdNanoUsd =
    admissible.optionSet.sendable && admissible.totalNanoUsd !== undefined
      ? nanoUSD(admissible.totalNanoUsd)
      : undefined;

  return {
    affordable: picker.affordable,
    admissible: admissible.optionSet,
    holdNanoUsd,
    smartSlot: picker.smartSlot,
    ...(holdNanoUsd === undefined || admissible.setAsideNanoUsd === 0n
      ? {}
      : { setAsideNanoUsd: nanoUSD(admissible.setAsideNanoUsd) }),
  };
}

/**
 * The smart SLOT's own verdict, read off a produced set. The slot is not a
 * catalog model — it carries no rates and no pool membership, so no entry of
 * `all` describes it — and a surface with no answer for it defaulted to
 * offering it, which is the one row a picker never graded.
 *
 * It is a query over the set rather than a rule of its own: the slot resolves to
 * a CANDIDATE row, `runnable` is the rows that can answer with the outliers the
 * classifier may not pick already removed, and a candidate among them is a model
 * the slot can become. That is the same predicate the server's candidate menu
 * refuses on, so the picker cannot offer a slot the send then finds empty.
 *
 * An unsendable set answers with the turn's own refusal: no arrangement runs, so
 * the slot has none either, and the reason the turn gives is the reason to give.
 * When the set sends and no candidate is left, a candidate is missing from
 * `runnable` PRECISELY BECAUSE IT WAS BLOCKED, and its own row in `all` carries
 * the reason — so the reduction is over those reasons, through the same
 * {@link poolRefusalPrecedence} the turn refusal uses for a slot turn, which is
 * what makes the slot row say the money thing exactly when the rows beside it do.
 * The empty-reason case is left for a pool with nothing blocked in it — every
 * candidate pinned away, or only excluded outliers remaining — where the
 * reduction is total and yields the code the producer's own slot turn carries for
 * an empty pool.
 *
 * The set is read as produced, for the selection it was produced from. With the
 * slot not yet selected its arrangements carry no classifier reserve, so this
 * answers whether the POOL has a candidate rather than whether the priced turn
 * that adds the slot would also clear that reserve.
 */
export function smartSlotAvailability(set: OptionSet): Availability {
  if (!set.sendable) return { available: false, reason: set.refusal };
  if (set.runnable.some((entry) => entry.kind === 'candidate')) return { available: true };
  const blocked = set.all.flatMap((entry) =>
    entry.kind === 'candidate' && !entry.availability.available ? [entry.availability.reason] : []
  );
  return { available: false, reason: poolRefusalPrecedence(blocked) };
}

/**
 * The media pair's shapes travel with its producer rather than from the core.
 * `media-core.ts` stays off every barrel — a consumer reaching it could evaluate
 * one pass alone, which is the disagreement the pair exists to prevent — so the
 * types a caller needs to name what it gets back are re-exported here.
 */
export type {
  MediaDimensionAvailability,
  MediaModelEntry,
  MediaOptionSet,
  MediaSelection,
} from './media-core.ts';

/**
 * The media pair, produced together for the same reason the token pair is: a
 * surface that asked for greying and for the send gate in two calls could be
 * handed two answers, and one of them would be wrong.
 *
 * No hold figure is returned: this core produces verdicts, not a priced request,
 * and the hold is the server's. What the verdicts are priced ON is the whole
 * turn — each selected model's generation, the bytes its output is stored at,
 * and the prompt's own storage — because a verdict priced on less than admission
 * holds says yes exactly where admission says no.
 *
 * The basis substitution is this producer's, for the same reason it is the token
 * producer's: the `affordable` set is evaluated against the empty basis so no
 * caller can obtain a prompt-dependent floor, and `admissible` against the turn's
 * real one, which is what makes `admissible ⊆ affordable` hold here too.
 */
export interface MediaTurnOptions {
  /** From `effectiveBalance`. Drives ALL greying, and does not move while a run holds. */
  readonly affordable: MediaOptionSet;
  /** From `spendable`. Drives the send gate. */
  readonly admissible: MediaOptionSet;
}

export function getMediaTurnOptions(
  funding: FundingSnapshot,
  basis: PromptBasis,
  selection: MediaSelection,
  catalog: readonly MediaModel[]
): MediaTurnOptions {
  const spendableNanoUsd = BigInt(funding.spendableNanoUsd);
  return {
    affordable: evaluateMediaTurn({
      fundingNanoUsd: spendableNanoUsd + BigInt(funding.heldNanoUsd),
      basis: EMPTY_PROMPT_BASIS,
      catalog,
      selection,
    }),
    admissible: evaluateMediaTurn({
      fundingNanoUsd: spendableNanoUsd,
      basis,
      catalog,
      selection,
    }),
  };
}
