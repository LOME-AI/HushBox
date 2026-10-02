/**
 * The dimension registry's published surface, not a directory barrel.
 *
 * `docs/BILLING.md` §Where the Code Lives names "the dimension registry as
 * data" a structural seam, and keeps the machinery around it unexported. So the
 * derivations in `derive.ts` — the reserve contribution, the prompt section, the
 * answer parser, the fallback, per-model resolution, the partition split — are
 * absent here rather than absent one level up: a name this file does not carry
 * cannot reach either package entry point, whichever of them stars it.
 * In-module consumers import `derive.ts` directly.
 */

export { DIMENSIONS, dimensionFor } from './registry.ts';
export { MEDIA_DIMENSIONS, MEDIA_REFERENCE_UNITS, mediaDimensionFor } from './media.ts';
export { MEDIA_PARAMETER_NAMES, mediaParameterSpecs } from './media-params.ts';
export { mediaModelFrom } from './media-model.ts';
export {
  DIMENSION_COST_CLASSES,
  DIMENSION_IDS,
  DIMENSION_RESOLUTIONS,
  DIMENSION_RESOURCES,
  MEDIA_DIMENSION_IDS,
} from './types.ts';
export type { MediaCallQuantity } from './media.ts';
export type { DeclaredMediaDomains, MediaParameterName } from './media-params.ts';
export type { MediaModel } from './media-model.ts';
export type {
  AnyDimensionId,
  DimensionCostClass,
  DimensionId,
  DimensionModel,
  DimensionOption,
  DimensionResolution,
  DimensionResource,
  DimensionSpec,
  DimensionSupport,
  MediaDimensionId,
  OpenDimension,
  OptionId,
  OptionLabel,
  ProviderParams,
  ReserveContribution,
} from './types.ts';
