/**
 * What a dimension declares (`docs/BILLING.md` §The Dimension Framework, §Data
 * Structures). Everything about a turn that varies and affects cost is a
 * dimension — model choice, reasoning effort, web search, media resolution and
 * everything added later are the same kind of object, priced by one mechanism.
 *
 * A dimension author declares what the dimension IS. Everything a dimension
 * could get wrong about money is computed from that declaration by `derive.ts`:
 * the reserve contribution, the prompt section, the answer parsing, the failure
 * fallback, the greying reasons, and whether a classifier call is bought.
 */

import type { ModelId } from '../model/model-id.ts';
import type { ParamSpec as ParameterSpec } from '../model/param-spec.ts';
import type { PriceableModel } from '../model/priceable-model.ts';

/**
 * The closed dimension id set. Adding a member is a contract change, not a
 * registry entry: `DimensionId` appears in `Selection.pinned` and in every
 * produced option set.
 */
export const DIMENSION_IDS = ['model', 'effort'] as const;

export type DimensionId = (typeof DIMENSION_IDS)[number];

/**
 * An option's stable identifier — the wire and storage vocabulary. Never
 * displayed and never sent to the classifier: those read {@link OptionLabel}.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- the alias IS the contract: `OptionId` and `OptionLabel` are the specification's two distinct vocabularies for one rung, and every signature here has to say which it takes. Collapsing either to `string` erases exactly the distinction §Reasoning Effort 1 exists to enforce, and a brand would force casts at every catalog and label-map boundary.
export type OptionId = string;

/** A user-facing option word. One rung, one label (§Reasoning Effort 1). */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- see OptionId above; these two must remain nameable and distinct in signatures.
export type OptionLabel = string;

/**
 * What a dimension consumes, and therefore the UNIT its `requirement` speaks.
 * The set is closed: adding one is an architecture decision.
 *
 * `money` and `moneyPerToken` are both nano-USD and are deliberately distinct
 * units. `money` is an amount out of `spendable` — an option that costs this
 * many nano-USD. `moneyPerToken` is a RATE: the option's cost depends on how
 * many tokens the turn buys, so no amount exists until a ceiling is supplied.
 * The model dimension is the rate case — `cost(m, tokens)` is a function of the
 * ceiling, and the ceiling depends on the funding, which is why §The hold
 * expresses an open model dimension's term as `MAX over candidates
 * cost(m, ceiling(m))` rather than as a per-option constant.
 */
export const DIMENSION_RESOURCES = ['money', 'moneyPerToken', 'completionTokens', 'none'] as const;

export type DimensionResource = (typeof DIMENSION_RESOURCES)[number];

/** How a dimension's requirement combines with the rest of the turn. */
export const DIMENSION_COST_CLASSES = ['partition', 'additive', 'multiplicative', 'free'] as const;

export type DimensionCostClass = (typeof DIMENSION_COST_CLASSES)[number];

/**
 * How a model that does not offer the requested option resolves — a choice from
 * a closed set, never a callback (§Derived, never declared). A free-form
 * resolver is how an upward resolution enters against a downward-only rule.
 *
 * - `nearestBelow` — the greatest offered option below the request; refuses when
 *   nothing sits below it.
 * - `lowestOfferedWhenMandatory` — `nearestBelow`, plus the one upward
 *   exception: a model that MANDATES this dimension and whose whole ladder sits
 *   above the request runs at its lowest offered option, because downward is
 *   impossible for it.
 */
export const DIMENSION_RESOLUTIONS = ['nearestBelow', 'lowestOfferedWhenMandatory'] as const;

export type DimensionResolution = (typeof DIMENSION_RESOLUTIONS)[number];

export interface DimensionOption {
  readonly optionId: OptionId;
  readonly label: OptionLabel;
}

/**
 * What ONE model offers on ONE dimension, read from its catalog row — never
 * hand-written. `options` is ascending by requirement for an `ordered`
 * dimension, which is what makes the feasible set a downward-closed prefix.
 */
export interface DimensionSupport {
  readonly options: readonly DimensionOption[];
  /**
   * Whether this model cannot opt out of the dimension. Only the
   * `lowestOfferedWhenMandatory` rule reads it; it is the carve-out's entire
   * precondition, so it is declared data rather than inferred at the call site.
   */
  readonly mandatory: boolean;
}

/** The provider-call fragment an option becomes. */
export type ProviderParams = Readonly<Record<string, unknown>>;

/**
 * The least a model projection must carry to be a dimension's subject: an
 * identifier, so a declaration that mis-prices names the row it mis-priced.
 * Everything else a dimension reads is the projection's own business, which is
 * what lets `PriceableModel` (per token) and `MediaModel` (per unit) each
 * declare dimensions without either learning the other's money shape.
 */
export interface DimensionModel {
  readonly modelId: ModelId;
}

/**
 * The dimension ids of the per-unit-priced modalities. A SEPARATE closed set
 * from {@link DIMENSION_IDS} rather than more members of it: `Selection.pinned`
 * is keyed by the token-path ids and `defineDimensions` demands one entry per
 * id, so one flat set would force every media dimension onto every text turn.
 * A modality registers its own dimensions over its own projection.
 */
export const MEDIA_DIMENSION_IDS = ['aspectRatio', 'resolution', 'durationSeconds'] as const;

export type MediaDimensionId = (typeof MEDIA_DIMENSION_IDS)[number];

/** Any registered dimension's id, across every modality's registry. */
export type AnyDimensionId = DimensionId | MediaDimensionId;

/**
 * A dimension declaration over one model projection. `M` defaults to
 * `PriceableModel` — the token path, which every existing dimension declares
 * over — so a media dimension is the only declaration that names its projection.
 */
export interface DimensionSpec<M extends DimensionModel = PriceableModel> {
  readonly id: AnyDimensionId;

  /**
   * The option domain, declared in the catalog's own parameter-spec language:
   * values, range, default. `ParamSpec` is CONSUMED, not extended — it is a
   * `z.strictObject` persisted inside the jsonb model descriptor, so it cannot
   * carry function fields and rejects new keys. Declaring the domain here keeps
   * option values single-sourced instead of inventing a second domain language.
   *
   * `values` present ⇒ a fixed literal domain, and every option a model's
   * `support` yields must be a member (enforced by `dimensionSupportFor`).
   * `values` absent ⇒ the domain is the catalog itself — the model dimension,
   * and every media dimension, whose option set is per model — finite per turn
   * but not expressible as a literal list.
   */
  readonly param: ParameterSpec;

  readonly resource: DimensionResource;
  readonly costClass: DimensionCostClass;

  /** ordered ⇒ a single ceiling losslessly represents the feasible set. */
  readonly ordered: boolean;
  /** enumerable ⇒ may be opened (handed to the classifier). */
  readonly enumerable: boolean;

  /** What this model offers, derived from its catalog row — never hand-written. */
  readonly support: (model: M) => DimensionSupport;

  /**
   * The requirement of one option, in `resource` units: `bigint` nano-USD for
   * `money`, `bigint` nano-USD per token for `moneyPerToken`, a token count for
   * `completionTokens`, a multiplier for a `multiplicative` dimension. Throws on
   * an option the model does not offer — a requirement for an unoffered option
   * is a caller defect, not a zero.
   */
  readonly requirement: (model: M, option: OptionId) => bigint | number;

  /** The provider fragment an option becomes. The only place a param name appears. */
  readonly wire: (model: M, option: OptionId) => ProviderParams;

  readonly resolution: DimensionResolution;

  /** One sentence naming the axis. Option lines are generated from labels. */
  readonly promptDescription: string;

  /**
   * False when the hold's worst option shrinks the delivered ceiling. Because
   * the hold precedes an open dimension's resolution, a `multiplicative`
   * dimension's worst option shrinks what is delivered even when the cheapest
   * option is chosen; declaring it makes the consequence visible rather than
   * discovered.
   */
  readonly deliversAtHoldCeiling: boolean;
}

/**
 * A declaration bound to the id it registers under. `defineDimensions` takes
 * this form rather than a bare {@link DimensionSpec}: a foreign id passes both
 * of its runtime guards (nothing missing, nothing duplicated) while making the
 * frozen record's declared keys a lie about its own contents, so which modality
 * a declaration belongs to has to be stated in its type.
 */
export type DimensionSpecOf<
  Id extends AnyDimensionId,
  M extends DimensionModel = PriceableModel,
> = DimensionSpec<M> & { readonly id: Id };

/**
 * A dimension the classifier may choose from. Obtainable only through
 * `openDimension`, so a non-enumerable dimension cannot reach a classifier —
 * a closed set of distinct options is what presentation requires, and a
 * continuous dimension has none.
 */
export interface OpenDimension<M extends DimensionModel = PriceableModel> {
  readonly spec: DimensionSpec<M>;
}

/**
 * What an open dimension's worst option requires of the hold, in the dimension's
 * own declared resource. Derived from `resource` + `costClass` alone — a
 * dimension author never states it.
 *
 * The arms are separate units, and only `money` is an amount out of `spendable`.
 * `moneyPerToken` is a rate and cannot be added to a hold: a consumer that needs
 * money must price a turn cost per candidate — `cost(m, tokens)` over the
 * ceiling it is solving for, then `MAX` across the presented candidates for an
 * open dimension (§The hold). The rate's own role is to be the requirement's
 * unit — a per-token number computable from a catalog row alone. It is not a
 * turn cost, and it is not the candidate order of §Smart Model 1, which is on
 * turn cost (`maxCallCost`) with an identifier tiebreak.
 */
export type ReserveContribution =
  | { readonly kind: 'none' }
  | { readonly kind: 'money'; readonly nanoUsd: bigint }
  | { readonly kind: 'moneyPerToken'; readonly nanoUsdPerToken: bigint }
  | { readonly kind: 'completionTokens'; readonly tokens: number }
  | { readonly kind: 'ceilingMultiplier'; readonly factor: number };
