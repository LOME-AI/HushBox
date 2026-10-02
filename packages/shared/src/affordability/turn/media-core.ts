/**
 * The per-unit core, over the `MediaModel` projection. It is a second entry
 * point rather than a widened first one because the two projections PARTITION
 * the catalog: a media row carries no per-token rate and no context length, so
 * it has no ceiling to solve and cannot enter the priceable pool the outlier
 * median, the premium price threshold and the classifier engine are taken over.
 *
 * No per-unit pricing expression lives here: every amount comes from the price
 * core's media curve, through the dimension registry, and the one byte estimate
 * (`estimate/output-bytes.ts`). Pure, content-free and clock-free, exactly as
 * the token core is.
 *
 * The provider composition is the registry's own, read through
 * {@link reserveContribution} at a single-option support so the cost class
 * decides the arithmetic rather than the dimension's identity: a `money` axis
 * adds an amount, a multiplicative one scales it, and a zero-cost axis
 * contributes nothing. A model presenting no priced axis at all is priced at one
 * reference unit of its own rate — the flat per-image case, whose whole
 * generation cost is that unit.
 *
 * The storage leg rides this core rather than a dimension's requirement because
 * it is a property of the generated OUTPUT, not of any axis: charging it per
 * dimension would charge it once per axis. It rides the same unit count as the
 * provider leg, which is what makes a longer video cost more bytes as well as
 * more seconds. Omitting it is not a rounding difference — a cheap image's
 * stored bytes cost several times its generation — and it fails in the
 * permissive direction, presenting a row as affordable that admission then
 * refuses.
 */

import {
  cheapestPresentedOption,
  dimensionSupportFor,
  reserveContribution,
} from '../dimensions/derive.ts';
import { MEDIA_REFERENCE_UNITS, mediaDimensionFor } from '../dimensions/media.ts';
import { mediaParameterSpecs } from '../dimensions/media-params.ts';
import { MEDIA_DIMENSION_IDS } from '../dimensions/types.ts';
import { mediaOutputBytes } from '../estimate/output-bytes.ts';
import { mediaStorageNanoUsd } from '../estimate/storage-rate.ts';
import { pricedSelection } from './priced-selection.ts';
import { inputStorageNanoUsd, maxMediaCallCostNanoUsd } from './turn-arithmetic.ts';
import { refusalPrecedence } from './turn-types.ts';
import type { MediaModel } from '../dimensions/media-model.ts';
import type {
  DimensionOption,
  DimensionSpec,
  DimensionSupport,
  MediaDimensionId,
  OptionId,
} from '../dimensions/index.ts';
import type { StoredMediaModality } from '../estimate/output-bytes.ts';
import type { ModelId } from '../model/model-id.ts';
import type { PricedSelection } from './priced-selection.ts';
import type {
  Availability,
  NonEmpty,
  OptionAvailability,
  PromptBasis,
  RefusalCode,
} from './turn-types.ts';

/** What the user has fixed on a media turn (`Selection`'s per-unit counterpart). */
export interface MediaSelection {
  /**
   * What the turn generates. It fixes the byte estimate the generated output is
   * stored at, so it is part of the price and not merely of the picker's filter.
   */
  readonly modality: StoredMediaModality;
  /** The models that will generate; every one of them is charged. */
  readonly selectedIds: readonly ModelId[];
  /** One option per media dimension the user has pinned; the rest are open. */
  readonly pinned: Readonly<Partial<Record<MediaDimensionId, OptionId>>>;
}

/**
 * One media picker row. It carries no ceiling: a per-unit call has no
 * token-shaped bound, which is the same fact that keeps media out of the token
 * core.
 */
export interface MediaModelEntry {
  readonly modelId: ModelId;
  readonly availability: Availability;
}

/** One media dimension's option list, never filtered — unavailable options carry a reason. */
export interface MediaDimensionAvailability {
  readonly dimensionId: MediaDimensionId;
  readonly options: NonEmpty<OptionAvailability>;
}

export type MediaOptionSet =
  | {
      readonly sendable: false;
      readonly refusal: RefusalCode;
      readonly all: readonly MediaModelEntry[];
      readonly turnDimensions: readonly MediaDimensionAvailability[];
    }
  | {
      readonly sendable: true;
      readonly all: readonly MediaModelEntry[];
      readonly turnDimensions: readonly MediaDimensionAvailability[];
    };

interface MediaCoreInput {
  /** `effectiveBalance` for the affordable pass, `spendable` for the admissible one. */
  readonly fundingNanoUsd: bigint;
  /** The empty basis on the affordable pass, the turn's own on the admissible one. */
  readonly basis: PromptBasis;
  /** Every per-unit-priced model of the turn's modality — the picker's rows. */
  readonly catalog: readonly MediaModel[];
  readonly selection: MediaSelection;
}

/** One registered media dimension, with its id narrowed to the media set. */
interface MediaAxis {
  readonly id: MediaDimensionId;
  readonly spec: DimensionSpec<MediaModel>;
}

const MEDIA_AXES: readonly MediaAxis[] = MEDIA_DIMENSION_IDS.map((id) => ({
  id,
  spec: mediaDimensionFor(id),
}));

/**
 * One reading of a turn's cost: what the user fixed, optionally with one axis
 * held at the option being graded.
 */
interface MediaReading {
  readonly selection: MediaSelection;
  readonly override?: { readonly dimensionId: MediaDimensionId; readonly optionId: OptionId };
}

/**
 * The option the REQUEST will carry for an axis: the option being graded when
 * the override names this axis, else what the user pinned. `undefined` means the
 * turn names no value for it.
 */
function requestedOptionFor(axis: MediaAxis, reading: MediaReading): OptionId | undefined {
  const { override } = reading;
  return override?.dimensionId === axis.id ? override.optionId : reading.selection.pinned[axis.id];
}

/**
 * The option one model runs an axis at: the value the request will carry when it
 * names one, else the declared fallback (the cheapest presented option).
 * `undefined` means the model offers nothing that satisfies the reading.
 *
 * A value the request names and the model's declared domain does not contain is
 * NOT substituted for the model's cheapest: the request carries that value to
 * every selected model, so the per-model domain check the server runs refuses
 * the turn. Pricing a substitute would present a send that is a guaranteed 400,
 * and would let every option on the axis grey while the turn stayed sendable.
 */
function axisOptionFor(
  axis: MediaAxis,
  model: MediaModel,
  support: DimensionSupport,
  reading: MediaReading
): DimensionOption | undefined {
  if (support.options.length === 0) return undefined;
  const requested = requestedOptionFor(axis, reading);
  if (requested !== undefined) {
    return support.options.find((option) => option.optionId === requested);
  }
  const fallback = cheapestPresentedOption(axis.spec, model, support);
  return support.options.find((option) => option.optionId === fallback);
}

/**
 * What one axis's chosen option contributes to a per-unit call, in the unit its
 * cost class fixes: an amount out of `spendable`, a factor scaling that amount,
 * or nothing at all.
 */
type AxisTerm =
  | { readonly kind: 'amount'; readonly nanoUsd: bigint }
  | { readonly kind: 'factor'; readonly factor: number }
  | { readonly kind: 'free' };

function axisTermFor(
  axis: MediaAxis,
  model: MediaModel,
  support: DimensionSupport,
  option: DimensionOption
): AxisTerm {
  const contribution = reserveContribution(axis.spec, model, {
    options: [option],
    mandatory: support.mandatory,
  });
  if (contribution.kind === 'money') return { kind: 'amount', nanoUsd: contribution.nanoUsd };
  if (contribution.kind === 'ceilingMultiplier') {
    return { kind: 'factor', factor: contribution.factor };
  }
  // A token-shaped resource has no meaning for a per-unit call, and every
  // registered media dimension declares `money` or `none`, so this refuses
  // rather than dropping the term — a dimension declaring one later would
  // otherwise be priced as free.
  /* v8 ignore next 3 -- unreachable while that holds */
  if (contribution.kind !== 'none') {
    throw new RangeError(
      `dimension '${axis.id}' contributes '${contribution.kind}', which no per-unit call can spend`
    );
  }
  return { kind: 'free' };
}

/**
 * A priced media reading, or the reason it has none. The two refusals are
 * distinct because they send the payer to different places: `notOffered` is a
 * choice the payer can change, `notPriceable` is the model. A reading prices as
 * `notOffered` when a model DECLARES a domain for an axis and the value the
 * request names for it — the pin, or the override being graded — is outside
 * that domain, and as `notPriceable` when the request names no value for an axis
 * the model leaves unconstrained. A model that declares no domain never yields
 * `notOffered`: it honours whatever the request carries, so an absent domain is
 * the absence of a constraint, never a refusal.
 */
type MediaPrice =
  | { readonly kind: 'priced'; readonly nanoUsd: bigint }
  | { readonly kind: 'notOffered' }
  | { readonly kind: 'notPriceable' };

/** A reading with no price, and therefore a reason. */
type UnpricedMediaPrice = Exclude<MediaPrice, { kind: 'priced' }>;

const NOT_OFFERED: UnpricedMediaPrice = { kind: 'notOffered' };
const NOT_PRICEABLE: UnpricedMediaPrice = { kind: 'notPriceable' };

/**
 * The typed reason an unpriced reading gives, read by the row, the option and
 * the send gate alike so one condition keeps one wording (§Notices & Refusals 1)
 * — a turn refused for an option no sibling offers cannot be explained as an
 * unpriceable model on one surface and an unoffered option on the next.
 */
function unpricedReason(cost: UnpricedMediaPrice): RefusalCode {
  return cost.kind === 'notOffered' ? 'option_not_offered' : 'model_not_priceable';
}

/**
 * The reason that survives when several axes, or several models, refuse one
 * reading: the precedence §Notices & Refusals 4 fixes, taken from the same
 * ladder every other refusal is reduced through. Never the first refusal met —
 * that would make a turn's answer depend on the order the payer happened to
 * select its models in, and on the order the registry happens to list its axes.
 */
function worseUnpriced(
  current: UnpricedMediaPrice | undefined,
  next: UnpricedMediaPrice
): UnpricedMediaPrice {
  if (current === undefined) return next;
  const winner = refusalPrecedence([unpricedReason(current), unpricedReason(next)]);
  return winner === unpricedReason(current) ? current : next;
}

/**
 * How one model prices one axis at a reading, or why it does not.
 *
 * `runs` carries the model the term is read against, which is the model itself
 * everywhere except the unconstrained case below — see {@link modelDeclaring}.
 */
type AxisReading =
  | {
      readonly kind: 'runs';
      readonly model: MediaModel;
      readonly support: DimensionSupport;
      readonly option: DimensionOption;
    }
  /** The axis takes no part in this call's price. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'notOffered' }
  | { readonly kind: 'notPriceable' };

/**
 * The same model, declaring exactly the option the request will carry on one
 * axis.
 *
 * An axis a model declares no domain for is UNCONSTRAINED, not unsupported: the
 * model runs whatever the request asks for. The registry cannot be asked about
 * such an option directly, because a dimension's `requirement` refuses an option
 * its model does not offer — correct when grading what a model OFFERS, and the
 * wrong question here. Widening the model instead keeps the requirement itself
 * the single authority on what the option costs: no factor is computed here, and
 * a dimension that changed how it prices its options would move this with it.
 * The spec is minted by the one media-spec minter for the same reason.
 */
function modelDeclaring(axis: MediaAxis, model: MediaModel, option: OptionId): MediaModel {
  return {
    ...model,
    parameters: { ...model.parameters, ...mediaParameterSpecs({ [axis.id]: [option] }) },
  };
}

/**
 * What one axis contributes to one model's call, resolved before any arithmetic.
 *
 * The unconstrained arm is gated on the MULTIPLICATIVE cost class rather than on
 * a dimension's identity, and it is the arm that matters: a multiplicative axis
 * that contributes nothing leaves the unit count at one, which prices a four
 * second video as one second on both the provider and the storage leg while the
 * request carries four. An additive axis that contributes nothing cannot fail
 * that quietly — the flat-rate fallback either prices it or refuses.
 *
 * With no value in the request there is nothing to price the axis at, so the
 * model is refused rather than priced at one unit — EXCEPT for a per-image rate,
 * whose call generates exactly one artifact, so no axis it leaves unconstrained
 * can scale it.
 */
function axisReadingFor(axis: MediaAxis, model: MediaModel, reading: MediaReading): AxisReading {
  const support = dimensionSupportFor(axis.spec, model);
  const option = axisOptionFor(axis, model, support, reading);
  if (option !== undefined) return { kind: 'runs', model, support, option };
  if (support.options.length === 0 && axis.spec.costClass === 'multiplicative') {
    const requested = requestedOptionFor(axis, reading);
    if (requested === undefined) {
      return model.pricing.kind === 'perImage' ? { kind: 'absent' } : { kind: 'notPriceable' };
    }
    const runAt: DimensionOption = { optionId: requested, label: requested };
    return {
      kind: 'runs',
      model: modelDeclaring(axis, model, requested),
      support: { options: [runAt], mandatory: false },
      option: runAt,
    };
  }
  // A model that declares a domain runs nothing here only when the reading names
  // a value outside it. A model that declares NO domain is unconstrained on the
  // axis rather than unable ({@link modelDeclaring}), so it takes no part in the
  // price under EVERY reading — the override included. Answering `notOffered`
  // there would grey an option on a turn that sends, and name a refusal the
  // server does not make: its per-model check skips an undeclared axis.
  if (support.options.length > 0) return { kind: 'notOffered' };
  return { kind: 'absent' };
}

/** The refusal one axis reading carries, or `undefined` when it takes part in the price. */
function axisRefusalFor(reading: AxisReading): UnpricedMediaPrice | undefined {
  if (reading.kind === 'notOffered') return NOT_OFFERED;
  if (reading.kind === 'notPriceable') return NOT_PRICEABLE;
  return undefined;
}

/**
 * What one model's generation costs at a reading, in nano-USD — the provider leg
 * PLUS the bytes its output is stored at, or a {@link MediaPrice} refusal.
 */
function mediaModelCostNanoUsd(model: MediaModel, reading: MediaReading): MediaPrice {
  let amountNanoUsd: bigint | undefined;
  // A multiplicative axis scales how many reference units the call generates
  // (duration is the registered one), so the same count scales both legs.
  let units = 1;
  let refusal: UnpricedMediaPrice | undefined;
  for (const axis of MEDIA_AXES) {
    const axisReading = axisReadingFor(axis, model, reading);
    const refused = axisRefusalFor(axisReading);
    if (refused !== undefined) {
      refusal = worseUnpriced(refusal, refused);
      continue;
    }
    if (axisReading.kind !== 'runs') continue;
    const term = axisTermFor(axis, axisReading.model, axisReading.support, axisReading.option);
    if (term.kind === 'amount') amountNanoUsd = (amountNanoUsd ?? 0n) + term.nanoUsd;
    else if (term.kind === 'factor') units *= term.factor;
  }
  if (refusal !== undefined) return refusal;
  const base = amountNanoUsd ?? maxMediaCallCostNanoUsd(model, { units: MEDIA_REFERENCE_UNITS });
  // No axis contributed an amount and the model states no rate for one bare
  // unit either — a matrix-priced row with no resolution to key it by reaches
  // here. It prices nothing, so it refuses; a stand-in zero would read as a
  // free generation and send.
  if (base === undefined) return NOT_PRICEABLE;
  const storage = mediaStorageNanoUsd(mediaOutputBytes(reading.selection.modality, units));
  return { kind: 'priced', nanoUsd: base * BigInt(units) + storage };
}

/**
 * What the whole turn costs at a reading: every selected model generates and
 * stores, so those legs are a `Σ`, and the prompt's own storage is added once —
 * the same shape the server's admission ceiling composes (one input-storage term
 * per turn, never one per sibling).
 */
function mediaTurnCostWithInputStorageNanoUsd(
  models: readonly MediaModel[],
  reading: MediaReading,
  inputStorageNano: bigint
): MediaPrice {
  let total = inputStorageNano;
  let refusal: UnpricedMediaPrice | undefined;
  // Every model is asked, and the reason is the one precedence picks, so the
  // turn's answer does not depend on the order the selection lists them in.
  for (const model of models) {
    const cost = mediaModelCostNanoUsd(model, reading);
    if (cost.kind === 'priced') total += cost.nanoUsd;
    else refusal = worseUnpriced(refusal, cost);
  }
  if (refusal !== undefined) return refusal;
  return { kind: 'priced', nanoUsd: total };
}

/**
 * Whether an axis costs the turn nothing, derived from the registry rather than
 * named: a dimension whose contribution is `none` on every selected model skips
 * affordability entirely, so no balance greys it.
 */
function axisIsFree(axis: MediaAxis, models: readonly MediaModel[]): boolean {
  return models.every(
    (model) =>
      reserveContribution(axis.spec, model, dimensionSupportFor(axis.spec, model)).kind === 'none'
  );
}

/** Every option any selected model offers on one axis, in first-offered order. */
function mediaOfferedOptions(
  axis: MediaAxis,
  models: readonly MediaModel[]
): readonly DimensionOption[] {
  const byOption = new Map<OptionId, DimensionOption>();
  for (const model of models) {
    for (const option of dimensionSupportFor(axis.spec, model).options) {
      if (!byOption.has(option.optionId)) byOption.set(option.optionId, option);
    }
  }
  return [...byOption.values()];
}

/** What one axis's options are graded against, resolved once per axis. */
interface AxisGrading {
  readonly models: readonly MediaModel[];
  readonly selection: MediaSelection;
  readonly fundingNanoUsd: bigint;
  /** The turn's prompt storage, carried so every option is graded on the whole turn. */
  readonly inputStorageNano: bigint;
  /** True when no option on this axis moves the turn's cost on any selected model. */
  readonly free: boolean;
}

function mediaTurnDimensions(
  models: readonly MediaModel[],
  selection: MediaSelection,
  fundingNanoUsd: bigint,
  inputStorageNano: bigint
): readonly MediaDimensionAvailability[] {
  const dimensions: MediaDimensionAvailability[] = [];
  for (const axis of MEDIA_AXES) {
    const grading: AxisGrading = {
      models,
      selection,
      fundingNanoUsd,
      inputStorageNano,
      free: axisIsFree(axis, models),
    };
    const [first, ...rest] = mediaOfferedOptions(axis, models).map(
      (option): OptionAvailability => ({
        ...option,
        availability: mediaOptionAvailability(axis, option, grading),
      })
    );
    if (first === undefined) continue;
    dimensions.push({ dimensionId: axis.id, options: [first, ...rest] });
  }
  return dimensions;
}

function mediaOptionAvailability(
  axis: MediaAxis,
  option: DimensionOption,
  grading: AxisGrading
): Availability {
  const cost = mediaTurnCostWithInputStorageNanoUsd(
    grading.models,
    {
      selection: grading.selection,
      override: { dimensionId: axis.id, optionId: option.optionId },
    },
    grading.inputStorageNano
  );
  // Not offered outranks money: an option a sibling cannot honour is unreachable
  // at any balance, so naming the balance would send the payer after a fix that
  // changes nothing. A model with no price outranks both.
  if (cost.kind !== 'priced') return { available: false, reason: unpricedReason(cost) };
  if (grading.free) return { available: true };
  return cost.nanoUsd <= grading.fundingNanoUsd
    ? { available: true }
    : { available: false, reason: 'insufficient_funds' };
}

/**
 * One row per catalog model, graded on the turn it would create — the already
 * selected siblings plus itself — which is what makes the row answer "could I
 * generate this beside what I have chosen".
 */
function mediaEntriesFor(
  input: MediaCoreInput,
  plan: PricedSelection<MediaModel>,
  inputStorageNano: bigint
): readonly MediaModelEntry[] {
  const { catalog, selection, fundingNanoUsd } = input;
  const selected = plan.priced;
  const rows = catalog.map((model): MediaModelEntry => {
    const others = selected.filter((sibling) => sibling.modelId !== model.modelId);
    // The row's OWN model answers first. A row is read at the turn's own pins, so
    // it grades a model that does not offer one of them exactly as the send gate
    // does — but the reason has to be this model's, or the row names a defect the
    // payer would have to deselect a DIFFERENT model to clear.
    const own = mediaModelCostNanoUsd(model, { selection });
    if (own.kind !== 'priced') {
      return {
        modelId: model.modelId,
        availability: { available: false, reason: unpricedReason(own) },
      };
    }
    const cost = mediaTurnCostWithInputStorageNanoUsd(
      [...others, model],
      { selection },
      inputStorageNano
    );
    // The model is priceable and a sibling is not: the turn cannot send, so the
    // row cannot look available, and the reason is the turn's.
    if (cost.kind !== 'priced') {
      return {
        modelId: model.modelId,
        availability: { available: false, reason: unpricedReason(cost) },
      };
    }
    return {
      modelId: model.modelId,
      availability:
        cost.nanoUsd <= fundingNanoUsd
          ? { available: true }
          : { available: false, reason: 'insufficient_funds' },
    };
  });
  const unpriceable = plan.unpriceableIds.map(
    (id): MediaModelEntry => ({
      modelId: id,
      availability: { available: false, reason: 'model_not_priceable' },
    })
  );
  return [...rows, ...unpriceable];
}

/**
 * The per-unit sibling of the token core in `turn-core.ts`: one funding number
 * and one selection in, one {@link MediaOptionSet} out. Its producer runs it
 * twice, exactly as the token one does, and the two passes differ only in the
 * funding number and the basis they are handed.
 *
 * Everything it decides comes off the media registry — each dimension's own
 * `support` for what a model offers and its own `requirement` for what an option
 * costs — reduced through the one shared media core. It prices the WHOLE turn
 * (generation, the output's stored bytes, and the prompt's storage once), which
 * is what lets its send gate agree with the figure admission holds.
 */
export function evaluateMediaTurn(input: MediaCoreInput): MediaOptionSet {
  const { catalog, selection, fundingNanoUsd } = input;
  const plan = pricedSelection(catalog, selection.selectedIds);
  const selected = plan.priced;
  // Media is signed-in only — there is no trial media turn — so a media turn
  // always persists, and its prompt always costs its characters' storage.
  const inputStorageNano = inputStorageNanoUsd(input.basis, true);
  const all = mediaEntriesFor(input, plan, inputStorageNano);
  const turnDimensions = mediaTurnDimensions(selected, selection, fundingNanoUsd, inputStorageNano);

  const reasons: RefusalCode[] = [];
  if (selected.length === 0 || plan.unpriceableIds.length > 0) {
    reasons.push('model_not_priceable');
  }
  const turnCost = mediaTurnCostWithInputStorageNanoUsd(selected, { selection }, inputStorageNano);
  if (selected.length > 0 && turnCost.kind !== 'priced') {
    // An unpriced turn must never fall through to sendable: a selection the
    // money layer cannot price is exactly what the send gate exists to refuse.
    reasons.push(unpricedReason(turnCost));
  } else if (
    selected.length > 0 &&
    turnCost.kind === 'priced' &&
    turnCost.nanoUsd > fundingNanoUsd
  ) {
    reasons.push('insufficient_funds');
  }
  if (reasons.length === 0) return { sendable: true, all, turnDimensions };
  return { sendable: false, refusal: refusalPrecedence(reasons), all, turnDimensions };
}
