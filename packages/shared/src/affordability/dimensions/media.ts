/**
 * The media modality's registry entries: aspect ratio, resolution and duration
 * (`docs/BILLING.md` §The Dimension Framework). They are the same kind of object
 * as model and effort and are priced by the same mechanism; only their
 * projection differs, because a media call is priced per image or per second
 * rather than per token.
 *
 * Two properties are the reason this file exists rather than a media-specific
 * pricing path:
 *
 *  - **Option domains come from the catalog, never from here.** Every `param`
 *    declares no `values` (the model-dimension precedent), and `support` reads
 *    the model's own `ParamSpec`. One video model offering 4 and 8 second
 *    durations and another offering 5 is data, not a code change, and no global
 *    list can drift away from what a model actually offers.
 *  - **The cost math is the one shared media curve.** A requirement prices on
 *    the price core's `mediaCallCurve`, the curve the server's admission
 *    estimate and the client's media estimate price on too. A second per-unit
 *    pricing expression anywhere would be the sync contract
 *    `docs/CODE-RULES.md` §One Implementation, Shared bans.
 *
 * The registry is separate from the token path's `DIMENSIONS` because
 * `Selection.pinned` is keyed by that closed id set and `defineDimensions`
 * demands one entry per id: one flat registry would force a resolution onto
 * every text turn.
 */

import { evaluateManifest } from '../estimate/reducers.ts';
import { mediaCallCurve } from '../price/curve.ts';
import { lineItemsAt } from '../price/reservation.ts';
import { mediaRatesFor } from '../price/schedule.ts';
import { MEDIA_PARAMETER_NAMES } from './media-params.ts';
import { defineDimensions } from './registry.ts';
import { MEDIA_DIMENSION_IDS } from './types.ts';
import type { MediaModel } from './media-model.ts';
import type { ParamSpec as ParameterSpec } from '../model/param-spec.ts';
import type { CostCurve } from '../price/curve.ts';
import type {
  DimensionOption,
  DimensionSpec,
  DimensionSpecOf,
  DimensionSupport,
  MediaDimensionId,
  OptionId,
  ProviderParams,
} from './types.ts';

/**
 * The quantity a media dimension's requirement is denominated in: ONE unit —
 * one image, or one second at a resolution. A per-unit rate has no token-shaped
 * bound to price against (no context length, no completion cap), so the
 * reference quantity is what makes a media requirement a finite amount at all.
 * The duration dimension supplies the multiplier that turns it into a call cost.
 */
export const MEDIA_REFERENCE_UNITS = 1;

/** The model's declared domain for one dimension, or nothing when it declares none. */
function declaredValues(model: MediaModel, id: MediaDimensionId): readonly (string | number)[] {
  const spec: ParameterSpec | undefined = model.parameters[MEDIA_PARAMETER_NAMES[id]];
  if (spec?.type !== 'enum' || spec.values === undefined) return [];
  return spec.values;
}

function supportOf(
  model: MediaModel,
  id: MediaDimensionId,
  labelOf: (value: string) => string
): DimensionSupport {
  const options: DimensionOption[] = declaredValues(model, id).map((value) => ({
    optionId: String(value),
    label: labelOf(String(value)),
  }));
  // No media parameter is mandatory: a model that declares no domain for an axis
  // is unconstrained on it, which is the absence of the option rather than a
  // compulsion to pick one.
  return { options, mandatory: false };
}

function assertOffered(model: MediaModel, id: MediaDimensionId, option: OptionId): void {
  if (!declaredValues(model, id).some((value) => String(value) === option)) {
    throw new RangeError(`model '${model.modelId}' does not offer ${id} option '${option}'`);
  }
}

/**
 * The quantity a per-unit call is priced at: one image, or N seconds at a
 * resolution. It is the whole bound on a media call's cost — a per-unit rate has
 * neither a context headroom nor a completion cap to clamp against.
 */
export interface MediaCallQuantity {
  /** Units to charge: images, or seconds. */
  readonly units: number;
  /** The priced dimension key (a video resolution); absent for a per-image price. */
  readonly dimensionKey?: string;
}

/**
 * The media call's curve at a quantity, or nothing when the model states no
 * rate for it. The curve refuses such a quantity with a `RangeError` — a
 * resolution its matrix does not key, a resolution on a per-image price, a
 * count that is not a positive integer — and on this axis that refusal IS the
 * answer: a quantity with no rate is not on offer. A resolution only the dearest
 * side prices is not on offer either: it has no rate to show, and the server's
 * admission refuses it the same way.
 */
function mediaCurveAt(model: MediaModel, quantity: MediaCallQuantity): CostCurve | undefined {
  const key = quantity.dimensionKey;
  if (
    model.pricing.kind === 'perSecond' &&
    key !== undefined &&
    !Object.hasOwn(mediaRatesFor(model.pricing, 'display'), key)
  ) {
    return undefined;
  }
  const resolution = key === undefined ? {} : { resolution: key };
  const call =
    model.pricing.kind === 'perImage'
      ? { images: quantity.units, ...resolution }
      : { seconds: quantity.units, ...resolution };
  try {
    return mediaCallCurve(model.pricing, 'reserve', call);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * What a media call costs at a quantity, priced on the shared media curve at the
 * dearest unit, the side a hold reserves — the same curve the server's admission
 * estimate and the client's media estimate price on. The dimension key rides only
 * for a per-second price; the curve rejects one on a per-image price, which is
 * what stops an image model being priced as if resolution moved its price.
 *
 * Storage is not priced here because it is a property of the generated output
 * rather than of an option: it is a once-per-generation pass-through the turn's
 * own estimate carries, and charging it here would add it once per dimension.
 */
export function mediaUnitsCostNanoUsd(
  model: MediaModel,
  quantity: MediaCallQuantity
): bigint | undefined {
  // A quantity the model states no rate for has NO cost, and absence is what
  // this reports: the caller grades it as unpriceable. A zero would price the
  // generation as free, and a throw would leave the surface no reading to
  // refuse with — it lands in a render with no error boundary above it.
  const curve = mediaCurveAt(model, quantity);
  if (curve === undefined) return undefined;
  // Folded through the strict scope rather than read leg by leg: the shared
  // line-item type permits a per-output-token leg, and a media call is priced
  // per unit with no output count to charge one against. Reading `fixedNano`
  // alone would drop such a leg out of the unit cost silently.
  return evaluateManifest({ items: lineItemsAt(curve, 0) }, 0n, { scope: 'fixed-only' });
}

/**
 * What ONE unit costs on this model — a dimension requirement's denomination —
 * or nothing when the model states no rate for that unit.
 */
function perUnitReferenceCostNanoUsd(
  model: MediaModel,
  dimensionKey: string | undefined
): bigint | undefined {
  return mediaUnitsCostNanoUsd(model, {
    units: MEDIA_REFERENCE_UNITS,
    ...(dimensionKey === undefined ? {} : { dimensionKey }),
  });
}

/**
 * Aspect ratio: the zero-cost axis. It changes the shape of the output and
 * nothing about its price, so it declares no resource and a `free` cost class —
 * the pair the registry forces to be declared together — and every derivation
 * over it skips affordability rather than computing a zero.
 */
export const ASPECT_RATIO_DIMENSION: DimensionSpecOf<'aspectRatio', MediaModel> = {
  id: 'aspectRatio',
  param: { type: 'string', wire: 'providerOptions' },
  resource: 'none',
  costClass: 'free',
  ordered: false,
  enumerable: true,
  support: (model) => supportOf(model, 'aspectRatio', (value) => value),
  requirement: (model, option) => {
    assertOffered(model, 'aspectRatio', option);
    return 0;
  },
  wire: (model, option) => {
    assertOffered(model, 'aspectRatio', option);
    return { aspectRatio: option } satisfies ProviderParams;
  },
  resolution: 'nearestBelow',
  promptDescription: 'The shape of the generated media.',
  deliversAtHoldCeiling: true,
};

/**
 * What one unit costs at one resolution on this model, or nothing when the model
 * states no rate for it. The price kind decides whether the resolution keys the
 * lookup at all: a per-image price is never looked up by dimension key, and the
 * shared curve is what enforces that.
 */
function resolutionUnitCost(model: MediaModel, option: OptionId): bigint | undefined {
  return perUnitReferenceCostNanoUsd(
    model,
    model.pricing.kind === 'perSecond' ? option : undefined
  );
}

/**
 * The resolutions this axis offers: those the model declares AND states a rate
 * for. The catalog carries the declared domain and the price matrix as separate
 * members, so a row may name a resolution its own matrix does not key; taking
 * the offered set from both is what keeps every later step from indexing that
 * matrix by a key it does not hold. It narrows the axis's declared support
 * rather than rebuilding it, so the shape and the mandatory rule stay stated
 * once, where `supportOf` states them.
 */
function offeredResolutions(model: MediaModel): DimensionSupport {
  const declared = supportOf(model, 'resolution', (value) => value);
  return {
    ...declared,
    options: declared.options.filter(
      (option) => resolutionUnitCost(model, option.optionId) !== undefined
    ),
  };
}

/**
 * The cost of an option this axis offers. It refuses an option the model states
 * no rate for with the same error an undeclared one gets, because on this axis
 * they are the same thing: a resolution with no rate is not among the offered.
 */
function assertResolutionPriced(model: MediaModel, option: OptionId): bigint {
  const cost = resolutionUnitCost(model, option);
  if (cost === undefined) {
    throw new RangeError(`model '${model.modelId}' does not offer resolution option '${option}'`);
  }
  return cost;
}

/**
 * Resolution: the axis that keys the price. Its requirement is the per-unit
 * reference cost — one image, or one second at that resolution — which is money
 * out of `spendable`, added to the turn. `ordered` because a higher resolution
 * never costs less, so the affordable set is a downward-closed prefix.
 *
 * A model priced per image still declares resolutions; every one of them
 * requires the same per-image rate.
 */
export const RESOLUTION_DIMENSION: DimensionSpecOf<'resolution', MediaModel> = {
  id: 'resolution',
  param: { type: 'string', wire: 'providerOptions' },
  resource: 'money',
  costClass: 'additive',
  ordered: true,
  enumerable: true,
  support: (model) => offeredResolutions(model),
  requirement: (model, option) => assertResolutionPriced(model, option),
  wire: (model, option) => {
    assertResolutionPriced(model, option);
    return { resolution: option } satisfies ProviderParams;
  },
  resolution: 'nearestBelow',
  promptDescription: 'The resolution the media is generated at.',
  deliversAtHoldCeiling: true,
};

/**
 * Duration: the axis that SCALES the per-unit reference cost rather than adding
 * to it, so its cost class is `multiplicative` and its requirement is the second
 * count itself. It is declared NOT enumerable: a duration is continuous wherever
 * the catalog states no discrete set, so it may be pinned but can never be
 * handed to a classifier — `openDimension` refuses it, which is where that rule
 * is enforced rather than remembered.
 *
 * `deliversAtHoldCeiling: false` follows from the cost class: the hold precedes
 * an open dimension's resolution, so a multiplicative axis shrinks what is
 * delivered even when the cheapest option is chosen. The registry refuses the
 * pair declared any other way.
 */
export const DURATION_DIMENSION: DimensionSpecOf<'durationSeconds', MediaModel> = {
  id: 'durationSeconds',
  param: { type: 'integer', wire: 'providerOptions' },
  resource: 'money',
  costClass: 'multiplicative',
  ordered: true,
  enumerable: false,
  support: (model) => supportOf(model, 'durationSeconds', (value) => `${value}s`),
  requirement: (model, option) => {
    assertOffered(model, 'durationSeconds', option);
    return Number(option);
  },
  wire: (model, option) => {
    assertOffered(model, 'durationSeconds', option);
    return { durationSeconds: Number(option) } satisfies ProviderParams;
  },
  resolution: 'nearestBelow',
  promptDescription: 'How many seconds of media to generate.',
  deliversAtHoldCeiling: false,
};

export const MEDIA_DIMENSIONS = defineDimensions(MEDIA_DIMENSION_IDS, [
  ASPECT_RATIO_DIMENSION,
  RESOLUTION_DIMENSION,
  DURATION_DIMENSION,
]);

export function mediaDimensionFor(id: MediaDimensionId): DimensionSpec<MediaModel> {
  return MEDIA_DIMENSIONS[id];
}
