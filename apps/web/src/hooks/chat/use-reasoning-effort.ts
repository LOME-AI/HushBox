import * as React from 'react';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { effortSelectionForTurn } from '@hushbox/shared/affordability';
import { useModels } from '@/hooks/models/models';
import { useModelStore } from '@/stores/model';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import type {
  ChatModality,
  DimensionAvailability,
  EffortChoice,
  Model,
  ReasoningEffortSelection,
} from '@hushbox/shared';

/**
 * The structural slice of a wire catalog `Model` the reasoning derivations
 * read — exactly the shared plan's `ReasoningPlanModel` plus the id. A full
 * `Model` row satisfies it directly (top-level `contextLength` and
 * `maxOutputTokens`). `maxOutputTokens` is declared explicitly — the shared
 * option authority's completion-cap term reads it, and an undeclared field
 * would silently type-erase at this seam even though the runtime object
 * carries it.
 */
export type EffortModel = Readonly<
  Pick<Model, 'id' | 'reasoning' | 'contextLength' | 'maxOutputTokens'>
>;

/**
 * Whether the turn draws on the Smart Model slot. The slot declares no ladder
 * of its own — the answering model is unknown until the classifier resolves
 * it — so what it can serve is read off the models it could become.
 */
function selectsSmartSlot(models: readonly EffortModel[]): boolean {
  return models.some((model) => model.id === SMART_MODEL_ID);
}

interface EffectiveSelectionInput {
  readonly preferred: ReasoningEffortSelection;
  /** Catalog rows for every selected model id; undefined while unresolved. */
  readonly models: readonly EffortModel[] | undefined;
  readonly modality: ChatModality;
  /**
   * The rows a drawn Smart Model slot could resolve to. Undefined when the
   * caller holds no catalog, which leaves the slot's ladder unknown rather than
   * empty.
   */
  readonly slotCandidates?: readonly EffortModel[] | undefined;
  /**
   * The choices the produced effort dimension enables, as the menu greys them.
   * Undefined until a funding verdict exists, which leaves the structural clamp
   * as the whole answer rather than refusing every rung on an absent read.
   */
  readonly enabled?: readonly EffortChoice[] | undefined;
}

/**
 * The selection that actually rides the turn request, asked of the shared
 * producer. This side supplies only what it knows — the preference, the
 * resolved rows, the modality, whether the smart slot is drawn and what it
 * could become — and holds no rule about which rungs a selection offers.
 *
 * The one thing decided here is the unresolved catalog: no rows means no turn
 * to ask about, which is a loading state rather than a money answer.
 */
export function effectiveReasoningSelection(
  input: EffectiveSelectionInput
): ReasoningEffortSelection | undefined {
  const { preferred, models, modality, slotCandidates, enabled } = input;
  if (models === undefined) return undefined;
  const smartSlot = selectsSmartSlot(models);
  return effortSelectionForTurn({
    preferred,
    ...(enabled !== undefined && { enabled }),
    ...(smartSlot && slotCandidates !== undefined && { slotCandidates }),
    // The sentinel is the SLOT, not a model that answers: it is declared by
    // `smartSlot` alone, and passing it as a row too would read a slot-only
    // turn as one with a model pinned beside the slot.
    models: models.filter((model) => model.id !== SMART_MODEL_ID),
    modality,
    smartSlot,
  });
}

/**
 * The write end of the effort channel {@link useReasoningEffort} reads: it
 * routes the graded effort dimension to the producer of the value the SEND
 * carries, so the rungs a user sees enabled and the level the request rides are
 * one answer rather than two that must agree.
 *
 * EXACTLY ONE CALLER, and it is the composer's effort control — the surface
 * that greys from this very dimension. Several budget instances are live at
 * once and they are NOT scoped to the same payer: the regenerate gate grades
 * the first message's conversation, which on an empty list is no conversation
 * at all, so it holds a full verdict against a different wallet and tier. A
 * second writer here is not a duplicate of the first; it is the wrong payer's
 * verdict lowering the composer's effort, and two of them alternate forever.
 *
 * Nothing is published while no verdict exists — an absent funding read must
 * not read as "no rung is enabled" and grey the whole ladder.
 */
export function useEffortAvailabilityPublisher(dimension: DimensionAvailability | undefined): void {
  const setEnabledEffortChoices = useReasoningEffortStore((state) => state.setEnabledEffortChoices);
  const enabled = React.useMemo(
    (): readonly EffortChoice[] | undefined =>
      dimension?.options
        .filter((option) => option.availability.available)
        .map((option) => option.optionId as EffortChoice),
    [dimension]
  );
  // A LAYOUT effect, because the send gate reads this set through the store and
  // therefore always renders one pass behind it. A passive publication lands
  // after the browser paints, so the pass grading the new selection against the
  // previous one's set is the frame on screen — an unlowered pin refused as
  // `model_output_cap_too_low` between picking a model and the correction
  // arriving. Publishing in the commit phase keeps that pass off the screen. It
  // does not make the convergence loop settle in one step, and is not meant to:
  // termination rests on reaching a fixed point, which the store's equal-set
  // guard is what bounds.
  React.useLayoutEffect(() => {
    setEnabledEffortChoices(enabled);
  }, [enabled, setEnabledEffortChoices]);
}

interface ReasoningEffortState {
  /** Raw persisted preference (default `auto`). */
  preferred: ReasoningEffortSelection;
  /**
   * The selection the turn request carries: clamped to what the selection can
   * structurally serve AND lowered to what the payer can currently fund;
   * undefined = omit the field.
   */
  effective: ReasoningEffortSelection | undefined;
  /** Catalog rows of the selected models, or undefined while unresolved. */
  models: readonly EffortModel[] | undefined;
  setSelection: (selection: ReasoningEffortSelection) => void;
}

/**
 * What the Smart Model slot could resolve to, as this side can know it: every
 * catalog row that is neither the slot sentinel nor already pinned beside it.
 *
 * Deliberately WIDER than the pool the server presents the classifier, which
 * also drops cost-outliers and rows of another modality. Narrowing it here would
 * need the prompt basis the outlier median is taken over, which this seam does
 * not hold, and would read a field outside {@link EffortModel} — the structural
 * slice this whole derivation is declared over. Both widenings run the same
 * direction and it is the safe one: a rung only an excluded row declares
 * survives the structural clamp, so this clamp can fail to lower, never lower
 * too far, and the graded set lowers it on the pass after.
 */
function slotCandidatesOf(
  catalog: readonly EffortModel[],
  selected: readonly { id: string }[]
): readonly EffortModel[] {
  const pinned = new Set(selected.map((entry) => entry.id));
  return catalog.filter((model) => model.id !== SMART_MODEL_ID && !pinned.has(model.id));
}

/** Resolve the active selection's ids to catalog rows; undefined until all resolve. */
function resolveSelectedModels(
  selected: readonly { id: string }[],
  catalog: readonly EffortModel[] | undefined
): readonly EffortModel[] | undefined {
  if (catalog === undefined) return undefined;
  const rows: EffortModel[] = [];
  for (const entry of selected) {
    const row = catalog.find((model) => model.id === entry.id);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/**
 * Single source of truth for the reasoning-effort selection (mirrors
 * `useWebSearch`): the persisted preference plus the effective value every
 * consumer — the effort menu's checked item, the budget estimate, and the send
 * path — reads from here, so the rules have exactly one definition and cannot
 * drift.
 *
 * `effective` answers the funding question as well as the model one, off the
 * graded set the menu greys from. A model clamp alone would let a stored
 * preference ride a request the menu had already greyed, which is the one way a
 * client could send what the server refuses.
 */
export function useReasoningEffort(): ReasoningEffortState {
  const preferred = useReasoningEffortStore((state) => state.preferredReasoningEffort);
  const setSelection = useReasoningEffortStore((state) => state.setReasoningEffort);
  const modality = useModelStore((state) => state.activeModality);
  const selected = useModelStore((state) => state.selections[state.activeModality]);
  const { data } = useModels();
  const enabled = useReasoningEffortStore((state) => state.enabledEffortChoices);

  const models = resolveSelectedModels(selected, data?.models);
  const catalog = data?.models;
  return {
    preferred,
    effective: effectiveReasoningSelection({
      preferred,
      models,
      modality,
      ...(catalog !== undefined && { slotCandidates: slotCandidatesOf(catalog, selected) }),
      ...(enabled !== undefined && { enabled }),
    }),
    models,
    setSelection,
  };
}
