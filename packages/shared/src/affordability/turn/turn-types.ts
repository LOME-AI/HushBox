/**
 * The shapes the one producer consumes and returns (`docs/BILLING.md` §Data
 * Structures). They are chosen so that illegal states cannot be represented;
 * where a type cannot carry a property, a named executable pin carries it
 * instead.
 *
 * Everything here is counts, rates and identifiers. No shape carries a prompt,
 * a message or a history array, which is what keeps content out of the money
 * layer by type rather than by discipline.
 */

import type { DimensionId, OptionId, OptionLabel } from '../dimensions/index.ts';
import type { ModelId } from '../model/model-id.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { Modality } from '../model/modality.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { UserTier } from '../money/tiers.ts';
import type { ResolvedReasoningEffort } from '../reasoning-effort.ts';

/**
 * A list that cannot be empty. Used where emptiness would be a representable
 * lie — `runnable` on a sendable option set, the option list of a presented
 * dimension.
 */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * Money only: one value per payer, cacheable, invalidated by run frames and
 * window focus. Both funding numbers the producer needs are derivable from it —
 * `spendable` is served directly and `effectiveBalance = spendable + held` — so
 * no second request and no additional served field exist for this (§Funding).
 */
export interface FundingSnapshot {
  readonly spendableNanoUsd: NanoUSD;
  readonly heldNanoUsd: NanoUSD;
  /**
   * The PAYER's tier, never the sender's. The name carries the distinction
   * because a link guest's two tiers differ — `guest` answers who is sending,
   * this answers what funds the turn — and a composer holding both under one
   * name will eventually cross them (§User Tiers).
   */
  readonly payerTier: UserTier;
  /**
   * Structural, not funding-derived: a link guest's payer is the conversation's
   * owner whether or not the owner's funds cover. Zero spendable is not a third
   * kind of payer, which is why this union stays closed at two.
   */
  readonly payer: 'self' | 'owner';
}

/**
 * Counts only. This type is why no content can cross into the money layer:
 * components, never a total plus its parts, so a history count larger than the
 * whole prompt is unrepresentable — `promptChars` is derived by
 * {@link promptCharsOf}.
 */
export interface PromptBasis {
  readonly systemChars: number;
  readonly instructionChars: number;
  readonly historyChars: number;
  readonly inputChars: number;
  readonly attachmentBytes: number;
}

/**
 * `promptChars` = system + instructions + history + new input. Attachment bytes
 * are deliberately excluded: they are bytes of media, not characters of prompt,
 * and they price through the media storage rate rather than the character rate.
 */
export function promptCharsOf(basis: PromptBasis): number {
  return basis.systemChars + basis.instructionChars + basis.historyChars + basis.inputChars;
}

/**
 * The basis a caller holding a measured TOTAL builds: the new message in
 * `inputChars`, everything ahead of it parked in `historyChars`. A caller that
 * measured the components separately builds a {@link PromptBasis} directly — this
 * is the derivation from a total, and there is one of it, because every consumer
 * of it prices the same turn.
 *
 * The components must sum to the total, because the money layer's two prompt legs
 * read different parts of it: the token leg (the price core's `inputTokensOf`
 * over {@link promptCharsOf}) prices the summed components, the whole prompt the
 * provider receives, while the storage leg (`inputStorageNanoUsd`) prices
 * `inputChars` alone. Dropping the remainder instead of parking it would narrow
 * the token leg too, which must not narrow; parking the whole total in
 * `inputChars` reserves a storage fee settlement can never charge.
 *
 * `historyChars` carries the remainder rather than `systemChars` because no leg
 * distinguishes them and a caller holding only a total measures neither.
 */
export function promptBasisFromTotal(counts: {
  /** The measured total: system prompt + instructions + history + new input. */
  readonly promptChars: number;
  /** The new message's own characters, of `promptChars`. */
  readonly inputChars: number;
}): PromptBasis {
  return {
    systemChars: 0,
    instructionChars: 0,
    historyChars: counts.promptChars - counts.inputChars,
    inputChars: counts.inputChars,
    attachmentBytes: 0,
  };
}

/**
 * The zero-length prompt basis the `affordable` set is evaluated against. The
 * producer substitutes it itself, so no caller can obtain a prompt-dependent
 * floor (§Affordability §Scope, §Affordability 2).
 */
export const EMPTY_PROMPT_BASIS: PromptBasis = {
  systemChars: 0,
  instructionChars: 0,
  historyChars: 0,
  inputChars: 0,
  attachmentBytes: 0,
};

/**
 * The priceable catalog pool as of an instant.
 *
 * The instant rides WITH the pool rather than as its own argument because both of
 * premium classification's legs are properties of this pair — the price percentile
 * is taken over the pool, the recency window is measured from the instant — and
 * because the money layer holds no clock of its own (§Model Classification,
 * §Affordability: "nothing in it reads a clock, a database, or a random source").
 *
 * `nowMs` is validated where the snapshot enters the module rather than trusted:
 * a clock a caller got wrong changes premium classification, which is a money
 * verdict, so an unusable instant is refused at the boundary the same way an empty
 * identifier is.
 */
export interface CatalogSnapshot {
  readonly models: readonly PriceableModel[];
  readonly nowMs: number;
}

/**
 * Where the turn's answers come from. At least one answer source is required,
 * so an empty turn is unrepresentable: either the pinned model list is
 * non-empty, or the smart slot is on.
 */
export type AnswerSources =
  | { readonly models: NonEmpty<ModelId>; readonly smartSlot: boolean }
  | { readonly models: readonly ModelId[]; readonly smartSlot: true };

/**
 * What the user has fixed. `pinned` names one option per registered dimension;
 * a dimension absent from it is open (the classifier chooses).
 *
 * `webSearch` is a turn-level additive toggle rather than a `pinned` entry
 * because web search is not yet a registered dimension — §The Dimension
 * Framework lists it as one, and when it becomes one this field collapses into
 * `pinned`. It is stated as its own field rather than hidden in a context
 * argument because it is something the USER fixed, and this is the type that
 * carries those.
 */
export interface Selection {
  readonly answerSources: AnswerSources;
  readonly modality: Modality;
  readonly pinned: Readonly<Partial<Record<DimensionId, OptionId>>>;
  readonly webSearch: boolean;
}

/**
 * Every reason a model, an option or a whole turn can be unavailable. Typed,
 * because copy is derived from the reason in one place: a condition cannot
 * acquire a second phrasing by being explained on a second surface (§Notices &
 * Refusals 1).
 *
 * Ordered by the precedence §Notices & Refusals 4 fixes: more than one term of
 * `min(providerCap, contextHeadroom, budgetBuys)` routinely binds at once, and
 * the rule is money first, then length. {@link refusalPrecedence} reads this
 * order, so the order here is behaviour, not documentation.
 *
 * Two axes live here. The FEASIBILITY axis — the four codes from
 * `insufficient_funds` down — is decided by the turn arithmetic and produced by
 * it. The TIER axis (the three codes above it) is decided by facts the
 * arithmetic cannot see: premium classification needs a pool percentile and a
 * release clock, and neither reaches a `PriceableModel`. They are declared here
 * so that a premium or trial-capped row is MARKED with a typed reason rather
 * than removed, and so that one condition still has exactly one wording — the
 * copy layer reads this enum, not a parallel string set.
 */
export const REFUSAL_CODES = [
  /**
   * The model is premium and the payer has no account to hold premium access.
   * Ahead of the money and length reasons because it is unconditional FOR ONE
   * MODEL: no balance and no shorter prompt unlocks the model at this tier, so a
   * money notice would name an action that cannot help (§Notices & Refusals 3).
   * Over a pool of interchangeable candidates the argument inverts, which is what
   * {@link poolRefusalPrecedence} exists for.
   */
  'premium_requires_account',
  /** The model is premium and the signed-in payer's tier has no premium access. */
  'premium_requires_credit',
  /** A trial turn on this model would exceed the trial per-message cost cap. */
  'trial_message_cap_exceeded',
  /** The funding cannot cover a minimum answer at all. */
  'insufficient_funds',
  /** The funding could, but the prompt leaves no room for a minimum answer. */
  'prompt_too_long',
  /** The model physically cannot emit a minimum answer at its cheapest configuration. */
  'model_output_cap_too_low',
  /** The model does not offer the pinned option, and nothing below it either. */
  'option_not_offered',
  /** No priceable model backs the selection. */
  'model_not_priceable',
  /** The modality is priced per unit, which the token ceiling cannot express. */
  'modality_not_priceable',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * The order a turn-level refusal is resolved in when several model-level
 * reasons are present: the first code of {@link REFUSAL_CODES} that appears
 * wins, so one condition yields one notice, always the same one. Total — an
 * empty reason list means nothing priceable backed the selection.
 */
export function refusalPrecedence(reasons: readonly RefusalCode[]): RefusalCode {
  return REFUSAL_CODES.find((code) => reasons.includes(code)) ?? 'model_not_priceable';
}

/**
 * The refusals that yield inside a pool, and the one property that puts a code
 * here: nothing the payer does reaches the model. No balance and no shorter
 * prompt lifts a premium lock, so among interchangeable candidates it is the
 * reason to drop rather than the reason to report.
 *
 * The trial per-message cap shares these two codes' axis and is deliberately NOT
 * here. It is actionable — its own copy asks the user to shorten the message, and
 * shortening does clear it — so yielding it would answer a trial payer with a
 * balance notice, which is the one action a trial payer cannot take and the exact
 * failure this reduction exists to remove.
 *
 * Enumerated rather than read off the enum's axis boundary for that reason: the
 * axis records which layer DECIDES a reason, and what decides membership here is
 * whether the payer can act on it. The two coincide across the premium pair and
 * part company at the trial cap.
 */
const UNCONDITIONAL_REFUSALS: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  'premium_requires_account',
  'premium_requires_credit',
]);

/**
 * {@link refusalPrecedence} over a set of INTERCHANGEABLE candidates — a Smart
 * Model pool, where any one member answering is enough and the members block for
 * different reasons.
 *
 * A premium lock leads the enum because it is unconditional FOR ONE MODEL: no
 * balance and no shorter prompt unlocks it, so a money notice would name an
 * action that cannot help. Over a pool that argument inverts. The pool carries no
 * premium floor, and candidates are built only from rows the payer can run, so a
 * premium-locked member is one the slot would never resolve to anyway; reporting
 * its reason sells premium access that moves nothing, while the members the slot
 * COULD pick are held back by something the payer can act on. So an
 * {@link UNCONDITIONAL_REFUSALS} member yields whenever the pool carries a reason
 * outside that set, and the survivors reduce through the same order — money still
 * ahead of length.
 *
 * A pool blocked only by those reports one of them, which is exactly where the
 * single-model justification is still true: nothing the payer does unlocks any
 * member.
 */
export function poolRefusalPrecedence(reasons: readonly RefusalCode[]): RefusalCode {
  const actionable = reasons.filter((code) => !UNCONDITIONAL_REFUSALS.has(code));
  return refusalPrecedence(actionable.length > 0 ? actionable : reasons);
}

/** Availability always carries its reason, so a surface cannot grey silently. */
export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: RefusalCode };

/**
 * The refusals one answer source can impose on ANOTHER — everything a sibling
 * already in the selection can make true of a candidate that is fine on its own.
 *
 * `option_not_offered` is deliberately absent, and its absence is a property
 * rather than an omission: adding a candidate makes it one of the turn's ANSWER
 * SOURCES, and wire-silence is granted to every sibling exactly when some answer
 * source — the candidate included — resolves the pin. That grant is a
 * disjunction over the answer sources, so it only widens as sources are added:
 * adding one can clear the reason and can never impose it, and the reason
 * appears only where NO answer source resolves the pin. So no sibling can impose
 * it, removing one is never the remedy, and the arm that grades adding
 * attributes it to the model.
 *
 * The rejected inference, recorded because this absence was justified by it and
 * it is false: a candidate whose own solo arrangement runs is NOT thereby one
 * that resolves the pin. A replacing click leaves the turn carrying only the pin
 * the committed model itself leaves standing, so a model with no ladder runs
 * alone by dropping the pin entirely. Reading the two as equivalent made an
 * ordinary selection — an effort pinned over models that offer no rung — look
 * unreachable.
 *
 * Declared as its own type so the selection-caused copy map is exhaustive by
 * typecheck rather than by review.
 */
export const SELECTION_CAUSED_REASONS = [
  'premium_requires_account',
  'premium_requires_credit',
  'trial_message_cap_exceeded',
  'insufficient_funds',
  'prompt_too_long',
  'model_output_cap_too_low',
] as const satisfies readonly RefusalCode[];

export type SelectionCausedReason = (typeof SELECTION_CAUSED_REASONS)[number];

const SELECTION_CAUSED: ReadonlySet<RefusalCode> = new Set<RefusalCode>(SELECTION_CAUSED_REASONS);

/** Whether a refusal is one a sibling can impose on an otherwise runnable candidate. */
export function isSelectionCaused(reason: RefusalCode): reason is SelectionCausedReason {
  return SELECTION_CAUSED.has(reason);
}

/**
 * The verdict on ADDING a row to the selection, which carries one thing an
 * {@link Availability} does not: WHOSE problem the refusal is.
 *
 * A row can be blocked by something true of the model wherever it runs, or by
 * something only the current selection makes true — and the two need different
 * copy, because only the second has removal as a remedy. The attribution is
 * published rather than derived, for the same reason the verdict itself is: a
 * surface computing it would be a second rule that has to agree with this one.
 *
 * It is a superset of {@link Availability} rather than a change to it, so the
 * union the dimensions, the smart slot and the send gate all read is untouched.
 */
export type AddAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: RefusalCode; readonly causedBy: 'model' }
  | {
      readonly available: false;
      readonly reason: SelectionCausedReason;
      readonly causedBy: 'selection';
    };

/**
 * The verdict for each of the two ways a picker row can be activated: REPLACING
 * the answer set with the row, and ADDING the row to it as a sibling.
 *
 * Both are published because both are real clicks — a single-mode picker
 * replaces, a multi-mode one adds — and a surface holding only one of them has
 * to re-grade the other for itself. Which arm a surface reads is a restatement
 * of the click it implements, and it belongs with that click.
 */
export interface Activation {
  readonly replace: Availability;
  readonly add: AddAvailability;
}

/** One option of one dimension, marked rather than filtered. */
export interface OptionAvailability {
  readonly optionId: OptionId;
  readonly label: OptionLabel;
  readonly availability: Availability;
}

/**
 * One dimension's option list. Never filtered: an unavailable option is present
 * and marked, so hiding an affordable option requires deleting a field rather
 * than forgetting a branch.
 */
export interface DimensionAvailability {
  readonly dimensionId: DimensionId;
  readonly options: NonEmpty<OptionAvailability>;
}

/** One answer's ceiling at one effort rung, bought by that rung's own budget solve. */
export interface RungCeiling {
  readonly effort: ResolvedReasoningEffort;
  readonly ceilingTokens: number;
}

/** What both kinds of row carry: which model, its verdict, and its ceiling. */
interface ModelEntryBase {
  readonly modelId: ModelId;
  /**
   * Whether the model can answer IN THE ROLE THIS ROW DESCRIBES: a pinned
   * sibling the payer already chose, or a model the classifier may bind. It is
   * therefore not a forecast of what selecting the model would do — a candidate
   * row publishes that separately as {@link CandidateModelEntry.activation}.
   */
  readonly availability: Availability;
  /** `ceiling(m)` — `min(providerCap, contextHeadroom, budgetBuys)`, in tokens. */
  readonly ceilingTokens: number;
  /**
   * This answer's ceiling at each rung the turn's menu marks available (and, on a
   * candidate row, at each rung the row itself offers), in the domain's ascending
   * order, each from that rung's own budget solve. On a tool-carrying turn a
   * rung's loop sets its price, so the rungs buy different ceilings; on a turn
   * with no tool they buy the same one. Empty when no rung is available; a rung is
   * absent when the row's arrangement cannot answer at that rung's loop.
   */
  readonly rungCeilings: readonly RungCeiling[];
}

/**
 * A row for a model the {@link Selection} named in `answerSources.models` — a
 * sibling that is already chosen, including one the catalog cannot price.
 *
 * It carries **no per-dimension option list**, and that absence is the rule
 * rather than an omission. A pinned sibling's own-fit verdict per option is
 * deliberately FINER than the turn's: it can hold an option that
 * `turnDimensions` on the {@link OptionSet} greys, because a *different* sibling
 * cannot honour it. Nothing may decide from that — an effort control reads
 * `turnDimensions`, which ANDs over the pinned siblings inside an OR over the
 * arrangements the turn could become — so the shape does not publish it, and
 * consuming it is a compile error rather than a documented mistake.
 *
 * What the row owes instead is the diagnosis §Story 1.3 asks for: `availability`
 * names which sibling is the problem, and carries the reason it is.
 */
export interface PinnedModelEntry extends ModelEntryBase {
  readonly kind: 'pinned';
}

/**
 * A row for a catalog model the selection did not pin — what may fill a smart
 * slot, and what a model picker greys from. This is the decision-bearing kind.
 *
 * It is graded against the whole arrangement it would create, the pinned siblings
 * plus itself, so its {@link CandidateModelEntry.dimensions} are already capped by the tightest
 * pinned sibling — the per-candidate effort ceiling of §Story 2.2, which is what a
 * classifier answer clamps onto.
 *
 * It carries TWO verdicts because it is asked two questions, and SELECTING the
 * model is what makes them different: it moves out of the classifier pool and
 * into the pinned set, and the two roles are graded differently on purpose
 * (§Reasoning Effort 3 withholds a pin no CANDIDATE can offer; §Reasoning Effort
 * 9 runs a PINNED sibling that cannot reason wire-silent). Reading either one
 * for the other's question is the defect the split exists to make
 * unrepresentable: the `availability` answer forecast a click's outcome from the
 * model's CURRENT role, which greyed every non-reasoning row under any explicit
 * effort preference at any balance.
 */
export interface CandidateModelEntry extends ModelEntryBase {
  readonly kind: 'candidate';
  /**
   * Whether the payer CLICKING this row gets a turn that sends — the verdict a
   * picker greys and gates from, one arm per way the row can be activated. The
   * same grading as {@link ModelEntryBase.availability}, over the arrangement
   * each activation would produce.
   */
  readonly activation: Activation;
  /**
   * Per-dimension options for THIS model, each carrying its own verdict. No claim
   * is made about combinations across dimensions: an option is presented iff the
   * arrangement this row describes can honour it.
   */
  readonly dimensions: readonly DimensionAvailability[];
}

/**
 * One rendered row. The two kinds answer different questions and only one is
 * decision-bearing, so they are separate shapes rather than one shape plus a rule
 * about when to read which field.
 */
export type ModelEntry = PinnedModelEntry | CandidateModelEntry;

/**
 * A discriminated union on whether the turn can start. `runnable` is exclusive
 * to the sendable arm and is a `NonEmpty` there, so "sendable with nothing
 * runnable" is unrepresentable.
 *
 * `all` and `turnDimensions` are on BOTH arms, because a refused turn is exactly
 * the turn whose greying needs explaining: a zero-balance payer's picker must
 * render one row per model with a reason on each (notion 1 exists to grey them,
 * and the product rule is grey, never hide). An unsendable set carrying no
 * entries would leave that surface with nothing to draw.
 */
export type OptionSet = (
  | {
      readonly sendable: false;
      readonly refusal: RefusalCode;
      readonly all: readonly ModelEntry[];
      readonly turnDimensions: readonly DimensionAvailability[];
    }
  | {
      readonly sendable: true;
      readonly runnable: NonEmpty<ModelEntry>;
      readonly all: readonly ModelEntry[];
      readonly turnDimensions: readonly DimensionAvailability[];
    }
) &
  ToolLoopReading;

/**
 * Which effort rung's tool loop the set is priced at. Both arms carry it, because
 * the composer's preview is priced on every render, sendable or not.
 */
export interface ToolLoopReading {
  /**
   * The rung a tool-carrying node declares its steps at: the pin under a pin, the
   * highest available rung under an open axis (the lowest rung the selection
   * offers when none is available), and `undefined` with no reasoning ladder,
   * which prices at the ceiling loop.
   */
  readonly toolLoopEffort: ResolvedReasoningEffort | undefined;
  /**
   * The rung whose loop the set's hold was priced at: the pin under a pin; under
   * an open axis, on a sendable admissible set the rung whose own hold is the
   * largest (the higher rung on a tie), and on any other set the lowest rung the
   * selection offers. `undefined` with no reasoning ladder.
   */
  readonly holdEffort: ResolvedReasoningEffort | undefined;
}

/**
 * The pair every surface reads, produced together so they cannot disagree.
 *
 * `holdNanoUsd` lives here rather than on an {@link OptionSet} because a hold is
 * only ever taken against `spendable`: an affordable-side hold is a value with
 * no meaning, and this placement makes it unrepresentable rather than merely
 * discouraged.
 */
export interface TurnOptions {
  /** From (effectiveBalance, empty basis). Drives ALL greying. Hold-blind, keystroke-stable. */
  readonly affordable: OptionSet;
  /** From (spendable, the composed basis). Drives the send gate and the classifier's options. */
  readonly admissible: OptionSet;
  /** The hold this turn would place. Present only when `admissible.sendable`. */
  readonly holdNanoUsd: NanoUSD | undefined;
  /**
   * The classifier reserve the admissible solves set aside that the hold does not
   * carry. Present only on a sendable turn whose open effort axis settles at its
   * one available rung with no call left to buy: a server that builds that turn
   * sizes its answers against the funding less this amount, as the solves did.
   */
  readonly setAsideNanoUsd?: NanoUSD;
  /**
   * The smart SLOT's own verdict, taken over `affordable` — the one row a picker
   * cannot look up, because the slot is not a catalog model and no entry of
   * `all` describes it.
   *
   * It rides on the pair rather than being offered as a separate query for the
   * same reason `holdNanoUsd` does: a caller reducing the set for itself picks
   * which set to reduce, and a slot graded against the send gate would grey
   * while a hold is out and no row beside it moved.
   */
  readonly smartSlot: Availability;
}
