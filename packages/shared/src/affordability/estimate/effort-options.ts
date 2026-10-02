/**
 * The turn's effort choice set, and the ONE shared authority for it (client
 * menu / classifier options / server validation all derive from here; One
 * Implementation, Shared).
 *
 * A multi-model turn offers the UNION of its answer sources' positional ladders
 * (`offeredLevels` stays the sole normalization authority — never re-derived
 * here), plus Min (reasoning off) when any of them can disable. Which rungs a
 * set of sources declares is the engine's own rule, imported rather than
 * restated ({@link offeredEffortRungs}).
 *
 * Per-model resolution is NOT implemented here. `resolveEffortForModel` is a
 * projection of the registry's one resolver onto this module's `ResolvedEffort`
 * shape: the rule (downward-only, with the mandatory lowest-rung carve-out)
 * lives in `dimensions/derive.ts` and is declared by the effort dimension's
 * `resolution` field, so a second nearest-below walk cannot exist to drift from
 * it. Explicit picks on a turn with ONE answer source are not resolved through
 * this module at all: such a level runs as asked or refuses (`planReasoning`'s
 * refusal), never silently substituted.
 */

import { resolveOption } from '../dimensions/derive.ts';
import {
  EFFORT_DIMENSION,
  EFFORT_OPTION_IDS,
  effortDomainOptions,
  effortSupportOf,
} from '../dimensions/effort.ts';
import { offeredEffortRungs } from '../turn/effort-rungs.ts';
import { REASONING_OFF } from '../reasoning-effort.ts';
import { offeredLevels, reasoningBudgetForWire, validCap } from './reasoning-plan.ts';
import type { Modality } from '../model/modality.ts';
import type {
  CanonicalReasoningEffort,
  ReasoningEffortSelection,
  ReasoningOff,
} from '../reasoning-effort.ts';
import type { OfferedLevel, ReasoningPlanModel } from './reasoning-plan.ts';

/**
 * One entry of the turn's real choice set: a canonical rung or
 * {@link REASONING_OFF} (displayed as Min — reasoning off). `auto` is a
 * selection, not a choice — it never appears here; the menu prepends it and
 * the classifier enumerates exactly these choices.
 */
export type EffortChoice = CanonicalReasoningEffort | ReasoningOff;

interface EffortOption {
  readonly choice: EffortChoice;
  /**
   * The largest reasoning budget any selected model runs at under this
   * choice, after per-model downgrade resolution and catalog clamps — the
   * B term of the turn's shared headroom sizing. Min is 0 unless a
   * mandatory sibling is forced up to its lowest rung.
   */
  readonly maxReasoningBudgetTokens: number;
  /**
   * The tightest declared provider completion ceiling (`maxOutputTokens`)
   * across the selection — the cap term the headroom `min()` must carry
   * alongside balance-affordable output and context headroom. Undefined
   * when no selected model declares a valid cap; identical on every option
   * of one turn (every sibling answers regardless of the effort choice).
   */
  readonly completionCapTokens: number | undefined;
}

/**
 * How one model runs the turn's chosen effort:
 * - `level` — engage at the offered rung (label + exact wire from the
 *   model's positional ladder); feed `planReasoning`.
 * - `off` — explicit hard off; feed `planReasoningOff`.
 * - `default` — send no reasoning wire at all: the model is not
 *   reasoning-capable, so there is nothing to wire.
 *
 * A mandatory model with a single native word resolves to `level`, not to
 * `default`: its one rung carries a real budget the provider will spend, so it
 * is wired and priced explicitly rather than left to the provider default
 * (§Predicates — eligibility is graded on a reachable corner).
 */
type ResolvedEffort =
  | { readonly kind: 'level'; readonly level: OfferedLevel }
  | { readonly kind: 'off' }
  | { readonly kind: 'default' };

/**
 * The turn's rung set as this module's choice type, projected from the one union
 * rule the engine grades its menu rows with. Min enters as soon as one source
 * can disable, because the off rung is a member of a model's support like any
 * level.
 */
function offeredChoices(sources: readonly ReasoningPlanModel[]): readonly EffortChoice[] {
  const offered = new Set<string>(offeredEffortRungs(sources).map((option) => option.optionId));
  return EFFORT_OPTION_IDS.filter((optionId) => offered.has(optionId));
}

/**
 * Per-model resolution of the turn's chosen effort, projected from the registry
 * onto the three wire shapes this module's consumers switch on.
 *
 * The mapping is total and lossless in both directions: the off option becomes
 * the hard-off wire, a rung becomes its own offered level, and the registry's
 * "this model offers nothing on the axis" — which it expresses as no resolved
 * option — becomes the wire-silence arm. That last arm is the one thing the
 * registry's return type does not carry, which is why the projection exists
 * rather than the consumers calling `resolveOption` themselves.
 */
export function resolveEffortForModel(
  model: ReasoningPlanModel,
  chosen: EffortChoice
): ResolvedEffort {
  const resolved = resolveOption(EFFORT_DIMENSION, effortSupportOf(model), chosen);
  if (resolved === undefined) return { kind: 'default' };
  if (resolved === REASONING_OFF) return { kind: 'off' };
  const level = offeredLevels(model).find((offered) => offered.label === resolved);
  /* v8 ignore next -- unreachable: `resolveOption` only ever returns an option the
     support presented, and every non-off option in the effort support is a rung
     read off this same ladder */
  if (level === undefined) return { kind: 'default' };
  return { kind: 'level', level };
}

function resolvedBudgetTokens(model: ReasoningPlanModel, chosen: EffortChoice): number {
  const resolved = resolveEffortForModel(model, chosen);
  return resolved.kind === 'level' ? reasoningBudgetForWire(model, resolved.level.wire) : 0;
}

/**
 * The turn's real choice set, ascending Min → Max. Empty when nothing is
 * selected or no selected model reasons — the chip renders no control, and the
 * server REFUSES any level chosen against an empty set rather than ignoring it.
 * Only the off rung stays a no-op there.
 */
export function turnEffortOptions(models: readonly ReasoningPlanModel[]): EffortOption[] {
  const declaredCaps = models
    .map((model) => validCap(model.maxOutputTokens))
    .filter((cap): cap is number => cap !== undefined);
  const completionCapTokens = declaredCaps.length === 0 ? undefined : Math.min(...declaredCaps);
  return offeredChoices(models).map((choice) => ({
    choice,
    maxReasoningBudgetTokens: Math.max(
      0,
      ...models.map((model) => resolvedBudgetTokens(model, choice))
    ),
    completionCapTokens,
  }));
}

export interface TurnEffortSelectionInput {
  /** The user's persisted preference, unclamped. */
  readonly preferred: ReasoningEffortSelection;
  /**
   * Every model PINNED to answer, resolved. The Smart Model slot is not one of
   * them and cannot be: it has no declared ladder to resolve, so it is declared
   * by `smartSlot` instead.
   */
  readonly models: readonly ReasoningPlanModel[];
  /** The turn's modality — only text carries an engaged reasoning selection. */
  readonly modality: Modality;
  /**
   * Whether the turn draws the Smart Model slot. The slot declares no ladder of
   * its own — the answering model is unknown until the classifier resolves it —
   * so what it can serve is {@link TurnEffortSelectionInput.slotCandidates}.
   */
  readonly smartSlot: boolean;
  /**
   * What a drawn slot could RESOLVE TO: the models the classifier may pick.
   * Their ladders are the slot's own, because the slot always becomes one of
   * them.
   *
   * Omitted by a caller that cannot name them, which declares a slot it knows
   * nothing about — and a slot that could become anything serves the whole axis,
   * the answer this module gave every slot turn before any caller could name a
   * pool. Read only when {@link TurnEffortSelectionInput.smartSlot} is set.
   */
  readonly slotCandidates?: readonly ReasoningPlanModel[] | undefined;
  /**
   * The turn's currently ENABLED choices, as the produced effort dimension
   * grades them — the same set the menu greys from, so the value that rides the
   * request and the value the user sees enabled are one answer rather than two
   * that must agree. Omitted when no funding verdict is in hand yet (the
   * catalog or the payer's snapshot is still loading), which leaves the
   * structural clamp as the whole answer.
   */
  readonly enabled?: readonly EffortChoice[] | undefined;
}

/**
 * THE lowering, and the only one: a chosen rung a set does not carry becomes the
 * nearest rung BELOW it in that set, and `auto` when the set carries none below.
 * Both questions this module answers reduce to it — which rung the selection can
 * serve at all, and which rung the payer can currently fund — so the two cannot
 * answer the same shape of question differently (`docs/BILLING.md` §Reasoning
 * Effort 3).
 *
 * `auto` is the right degenerate answer because it delegates the rung to the
 * server rather than substituting one, and it is always selectable.
 *
 * The direction is the registry resolver's, not a second walk of its own: the
 * set is handed to `resolveOption` as the support, so "nearest below" has one
 * implementation for the axis and the ordering comes from the declared domain
 * (the off rung below every level) rather than from the caller's order.
 *
 * The support is `mandatory: false` in both readings. A funding verdict mandates
 * nothing — the resolver's one upward move belongs to a model that cannot run
 * the axis at all, which no balance can make true — and a UNION over several
 * sources carries no mandate either: one source that cannot disable does not
 * stop another from doing so.
 */
function lowerTo(
  chosen: EffortChoice,
  available: readonly EffortChoice[]
): ReasoningEffortSelection {
  const availableIds = new Set<string>(available);
  const options = effortDomainOptions().filter((option) => availableIds.has(option.optionId));
  const resolved = resolveOption(EFFORT_DIMENSION, { options, mandatory: false }, chosen);
  return EFFORT_OPTION_IDS.find((optionId) => optionId === resolved) ?? 'auto';
}

/**
 * The rungs the selection can STRUCTURALLY serve — the union of its answer
 * sources' ladders, asked of the one rule the engine grades its menu rows with
 * ({@link offeredEffortRungs}, through {@link offeredChoices}) rather than
 * re-derived here.
 *
 * A drawn slot is an answer source, and the ladders it can serve are its
 * candidates': the server derives that menu AT the pin, so a model that cannot
 * honour the rung is never a candidate and the rung has to be one some candidate
 * declares. Each pinned sibling beside the slot still resolves downward or runs
 * wire-silent, which is why the union is over both rather than over the pinned
 * models alone.
 */
function offeredForSelection(
  input: Omit<TurnEffortSelectionInput, 'enabled'>
): readonly EffortChoice[] {
  const { models, smartSlot, slotCandidates } = input;
  if (!smartSlot) return offeredChoices(models);
  if (slotCandidates === undefined) return EFFORT_OPTION_IDS;
  return offeredChoices([...models, ...slotCandidates]);
}

/**
 * The turn's chosen effort before funding is consulted: the structural clamp
 * alone.
 */
function structuralSelection(
  input: Omit<TurnEffortSelectionInput, 'enabled'>
): ReasoningEffortSelection | undefined {
  const { preferred, modality } = input;
  if (modality !== 'text') return undefined;
  // A selection with no ladder engages nothing, so the field is omitted rather
  // than answered.
  const offered = offeredForSelection(input);
  if (offered.length === 0) return undefined;
  if (preferred === 'auto') return 'auto';
  return lowerTo(preferred, offered);
}

/**
 * The effort selection a turn can actually honour — the value that rides the
 * request. `undefined` means send no reasoning field at all: a non-text
 * modality refuses engaged reasoning, and a selection with no offered level has
 * nothing to engage.
 *
 * TWO clamps, ONE rule. The structural one runs first and needs no money: a
 * level the selection's own ladders do not carry lowers to the nearest one they
 * do, `auto` only when they carry none below. That is what keeps an unservable
 * rung from being displayed, held or sent on the very first render, before any
 * funding verdict exists. The funding one then lowers the survivor onto the
 * graded `enabled` set by the same walk — derived, never written back over the
 * preference, so the level returns when it becomes fundable again
 * (`docs/BILLING.md` §Reasoning Effort 3).
 *
 * The offered set is the UNION of the selection's ladders, not the
 * intersection: per-model resolution falls downward, so a level only one
 * sibling names is still honourable by the turn. The off rung is a member of it
 * like any level — it enters as soon as one source can disable — so a mandatory
 * sibling standing beside a disable-capable one does not force `auto`; it runs
 * its lowest rung.
 *
 * A structural clamp alone is not enough to make the value sendable: a stored
 * preference naming a level the payer can no longer fund would otherwise ride
 * the request while the menu greyed it, which is the one way a client could
 * send what the server refuses.
 */
export function effortSelectionForTurn(
  input: TurnEffortSelectionInput
): ReasoningEffortSelection | undefined {
  const chosen = structuralSelection(input);
  if (chosen === undefined || chosen === 'auto') return chosen;
  return input.enabled === undefined ? chosen : lowerTo(chosen, input.enabled);
}
