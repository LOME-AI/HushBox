import {
  MODALITIES,
  PRICING_KIND_BY_FAMILY,
  applyMarkupCeilFromUsdDecimal,
  applyMarkupInverseFloorToPicoUsd,
  callShapeFamilyFor,
  isRunnableModelShape,
} from '@hushbox/shared';
import { callCeilingRates } from '@hushbox/shared/affordability/price/reservation';
import { ModelPricingSchema, ceilingOf } from '@hushbox/shared/affordability/price/schedule';
import {
  MEDIA_PARAMETER_NAMES,
  exceedsModelAgeLimit,
  mediaParameterSpecs,
  priceFloorVerdict,
  topContextExemptionTokens,
} from '@hushbox/shared/affordability';
import { isNonConversational } from './non-chat-exclusions.js';
import { imageRates, ratesDiffer, smallestResolution, videoRates } from './media-rates.js';
import {
  anchorScheduleOf,
  chargesNothing,
  endpointsInBand,
  providerBaseOf,
  soldLanguageContexts,
} from './price-schedule.js';
import { usdRateToNanoUsd } from '../pricing/usd-rate.js';
import type {
  ExcludeReason,
  Modality,
  ModelDescriptor,
  ParamSpec as ParameterSpec,
} from '@hushbox/shared';
import type { TokenPricing, TokenRates } from '@hushbox/shared/affordability/price/schedule';
import type {
  GatewayModelMetadata,
  ImageMetadata,
  ImageSupportedParameters,
  LanguageMetadata,
  LanguageTokenPricing,
  VideoMetadata,
  ZdrEndpoint,
} from './gateway-metadata.js';
import type { ImageRates } from './media-rates.js';
import type { CatalogLimits, DecimalSchedule, PicoLimits } from './price-schedule.js';
import type { z } from 'zod';

/** A token rate pair as ingestion writes it: integer nano-USD decimal strings. */
type StoredTokenRates = Readonly<Record<'input' | 'output', string>>;

/**
 * A price as ingestion writes it: the JSON form `ModelPricingSchema` parses,
 * each rate an integer nano-USD decimal string. An image's anchor is its
 * cheapest per-image row and its dearest its dearest row; a video's two sides
 * are both each resolution's dearest per-second SKU, since a call sends no audio
 * flag and so cannot choose between them. Every row's price is parsed before it is persisted — a token price by
 * {@link textPricingFromEndpoints}, a media price by
 * {@link excludeUnrepresentable} — so a form the schema refuses is excluded
 * rather than written.
 */
export type StoredPricing =
  | {
      readonly kind: 'tokens';
      readonly anchor: {
        readonly base: StoredTokenRates;
        readonly tiers: readonly {
          readonly abovePromptTokens: number;
          readonly rates: StoredTokenRates;
        }[];
      };
      readonly anchorContextTokens: number;
    }
  | MediaStoredPricing;

type MediaStoredPricing =
  | { readonly kind: 'perImage'; readonly anchor: string; readonly dearest: string }
  | {
      readonly kind: 'perSecond';
      readonly anchor: Readonly<Record<string, string>>;
      readonly dearest: Readonly<Record<string, string>>;
    };

/**
 * Descriptor content: the wire form of `ModelDescriptor` minus the fields
 * stamped at persist time (`fetchedAt`) or injected at read time
 * (`popularityRank`). Skip-unchanged content-compares exactly this shape —
 * a refresh that changes nothing here writes nothing. `version` is part of
 * the content (stamped by normalize), so a descriptor-version bump rewrites
 * every row the next refresh admits, by construction.
 */
export type DescriptorContent = Omit<
  z.input<typeof ModelDescriptor>,
  'fetchedAt' | 'popularityRank' | 'pricing'
> & { readonly pricing: StoredPricing };

/**
 * The persisted descriptor contract version. '4' = pricing is a typed price
 * schedule of BILLABLE rates (ceil-marked-up at normalize; BILLING.md §Fee
 * Structure) whose token price names its anchor endpoint's context. The
 * catalog read path refuses any other version on a row it has not already set
 * aside as unsellable: '3' rows carry no anchor context, '2' rows flat rates
 * the schedule cannot parse, and '1' rows pre-fee provider rates.
 */
export const DESCRIPTOR_VERSION = '4';

/**
 * The per-refresh inputs a single model's commercial admission depends on but
 * cannot derive from itself (BILLING.md §Catalog Admission).
 */
export interface CatalogAdmission {
  /**
   * Sold context at or above which a language model bypasses the price floor
   * and the age cutoff. It is the top-context percentile over the sold contexts
   * of the language models with an eligible endpoint, so it is a property of the
   * whole catalog — which is why it arrives here rather than being computed per
   * model.
   */
  readonly contextExemptionTokens: number;
  /** The refresh clock, epoch ms. The age cutoff is measured back from it. */
  readonly nowMs: number;
}

/** Every gateway model's ZDR endpoints, keyed by model id; an unlisted id is not ZDR-reachable. */
export type ZdrListing = ReadonlyMap<string, readonly ZdrEndpoint[]>;

type NormalizeOutcome =
  | {
      kind: 'normalized';
      content: DescriptorContent;
      pricingFallbacks?: readonly string[];
      bandOpenEndpoints?: number;
    }
  | { kind: 'excluded'; modelId: string; reason: ExcludeReason };

/** A media family's outcome: per-unit rates as vendor decimal USD strings until the per-unit gates bake them. */
type MediaOutcome =
  | {
      kind: 'normalized';
      content: DescriptorContent & { readonly pricing: MediaStoredPricing };
      pricingFallbacks?: readonly string[];
    }
  | { kind: 'excluded'; modelId: string; reason: ExcludeReason };

/**
 * OpenRouter `supported_parameters` names → canonical descriptor ParamSpecs
 * for language models. Data, not per-model code: a name missing here is
 * skipped (the model still works with defaults). Canonical names match the
 * SDK call-shape the adapters wire.
 */
const SUPPORTED_PARAMETER_SPECS: Readonly<
  Record<string, { readonly name: string; readonly spec: ParameterSpec }>
> = {
  temperature: {
    name: 'temperature',
    spec: { type: 'number', min: 0, max: 2, wire: 'firstClass' },
  },
  top_p: { name: 'topP', spec: { type: 'number', min: 0, max: 1, wire: 'firstClass' } },
  max_tokens: {
    name: 'maxOutputTokens',
    spec: { type: 'integer', min: 1, wire: 'firstClass' },
  },
};

/** Gateway parameter names that signal behaviors rather than call params. */
const BEHAVIOR_PARAMETERS: Readonly<Record<string, string>> = {
  tools: 'tools',
  reasoning: 'reasoning',
};

/**
 * Every `supported_parameters` member this normalizer recognizes: the union of
 * {@link SUPPORTED_PARAMETER_SPECS} and {@link BEHAVIOR_PARAMETERS}, the only
 * readers of that wire list. Published so the live wire-format check pins
 * exactly the vocabulary the catalog derives from — a member the gateway stops
 * sending silently drops a control, because an unrecognized name is skipped by
 * design.
 */
export const RECOGNIZED_SUPPORTED_PARAMETERS: readonly string[] = [
  ...Object.keys(SUPPORTED_PARAMETER_SPECS),
  ...Object.keys(BEHAVIOR_PARAMETERS),
];

const MODALITY_SET: ReadonlySet<string> = new Set(MODALITIES);

function knownModalities(values: readonly string[]): Modality[] {
  return values.filter((value): value is Modality => MODALITY_SET.has(value));
}

function seedParameters(supportedParameters: readonly string[]): Record<string, ParameterSpec> {
  const parameters: Record<string, ParameterSpec> = {};
  for (const gatewayName of supportedParameters) {
    const known = SUPPORTED_PARAMETER_SPECS[gatewayName];
    if (known !== undefined) parameters[known.name] = known.spec;
  }
  return parameters;
}

function languageBehaviors(supportedParameters: readonly string[]): string[] {
  const behaviors = ['streaming'];
  for (const gatewayName of supportedParameters) {
    const behavior = BEHAVIOR_PARAMETERS[gatewayName];
    if (behavior !== undefined) behaviors.push(behavior);
  }
  return behaviors;
}

/** The optional display-name spread: present only when the source carries one. */
function nameOf(model: GatewayModelMetadata): { name?: string } {
  return model.name === undefined ? {} : { name: model.name };
}

/** The optional description spread: present only when the source carries one. */
function descriptionOf(model: GatewayModelMetadata): { description?: string } {
  return model.description === undefined ? {} : { description: model.description };
}

/** The optional reasoning spread: present only when the gateway entry carried
 * a top-level reasoning object (absence stays absence in the persisted jsonb). */
function reasoningOf(model: LanguageMetadata): Pick<DescriptorContent, 'reasoning'> {
  return model.reasoning === undefined ? {} : { reasoning: model.reasoning };
}

function inputsOrText(values: readonly string[]): Modality[] {
  const known = knownModalities(values);
  return known.length > 0 ? known : ['text'];
}

// --- language --------------------------------------------------------------

/**
 * A language row STATING a token limit that is not a whole positive count
 * within the safe-integer range is UNREPRESENTABLE DATA, not a smaller limit:
 * both limits count whole tokens and the gateway types neither with `.int()`,
 * so a fractional, zero or negative one describes no window and no ceiling,
 * and an unsafe one is not a count the price core can resolve a tier at. It is excluded with an alert, the way
 * `CODE-RULES.md` §Registries already handles an unknown pricing unit — the
 * alternative is a row degraded into a shape indistinguishable from a correct
 * one, since an omitted key is exactly what a gateway stating nothing produces.
 *
 * An ABSENT limit is deliberately not this: many gateway entries state no output
 * ceiling and some state no window, and absence is a representable state the
 * descriptor carries by omitting the key.
 *
 * Placement is deliberate — LAST in {@link normalizeLanguage}, after the
 * deprecation, modality, release-date and commercial gates, matching
 * {@link declaresNoAspectRatio}. A row already hidden for another reason keeps
 * that reason, so the hourly refresh stays quiet and the alert fires only when
 * an unrepresentable limit would otherwise reach a sellable row.
 */
function declaresUnrepresentableTokenLimit(model: LanguageMetadata): boolean {
  return [model.contextLength, model.maxCompletionTokens].some(
    (count) => count !== undefined && !(Number.isSafeInteger(count) && count > 0)
  );
}

/**
 * Every derived limit reaches the descriptor; an unbounded one omits its key.
 * Reached only past {@link declaresUnrepresentableTokenLimit}, so a limit here
 * is a whole positive count: the gateway's own, or a ZDR endpoint's.
 */
function languageLimits(text: PricedText): DescriptorContent['limits'] {
  return {
    ...(text.contextLength === undefined ? {} : { contextLength: text.contextLength }),
    ...(text.maxOutputTokens === undefined ? {} : { maxOutputTokens: text.maxOutputTokens }),
  };
}

/** A text model's price and limits, read off its ZDR endpoints. */
export type TextPricing =
  | {
      readonly kind: 'priced';
      /** The anchor schedule, billable. */
      readonly pricing: TokenPricing;
      /** The same schedule as ingestion writes it. */
      readonly stored: StoredPricing;
      /** The anchor's base rates before the fee, nano-USD, for the commercial floor. */
      readonly providerBase: { readonly input: bigint; readonly output: bigint };
      /** The smaller of the gateway's output cap and the largest eligible endpoint's; absent when neither states one. */
      readonly maxOutputTokens: number | undefined;
      /** The smaller of the gateway's context and the largest eligible endpoint's; absent when neither states one. */
      readonly contextLength: number | undefined;
      /** Standard-tier endpoints above the base ceiling that a short call's `max_price` still admits. */
      readonly bandOpenEndpoints: number;
    }
  | { readonly kind: 'excluded'; readonly reason: ExcludeReason };

type PricedText = Extract<TextPricing, { kind: 'priced' }>;

/** One vendor decimal, already checked against the decimal pattern, baked billable with one round-up. */
function bakedRate(rate: string): string {
  const baked = applyMarkupCeilFromUsdDecimal(rate);
  if (baked === undefined) throw new Error('bakedRate: the schedule carries only decimal rates');
  return baked.toString(10);
}

function bakedRates(rates: LanguageTokenPricing): StoredTokenRates {
  return { input: bakedRate(rates.prompt), output: bakedRate(rates.completion) };
}

/** The decimal schedule baked billable, each rate once from the vendor's exact decimal. */
function bakedSchedule(
  schedule: DecimalSchedule,
  anchorContextTokens: number
): Extract<StoredPricing, { kind: 'tokens' }> {
  return {
    kind: 'tokens',
    anchorContextTokens,
    anchor: {
      base: bakedRates(schedule.base),
      tiers: schedule.tiers.map((tier) => ({
        abovePromptTokens: tier.abovePromptTokens,
        rates: bakedRates(tier.rates),
      })),
    },
  };
}

/** The `max_price` a pair of ceiling rates un-bakes to, per key. */
function maxPricePico(rates: TokenRates): PicoLimits {
  return {
    input: applyMarkupInverseFloorToPicoUsd(rates.input),
    output: applyMarkupInverseFloorToPicoUsd(rates.output),
  };
}

/**
 * A text model's stored price: its anchor's schedule, each rate baked billable
 * once from the vendor's exact decimal. A price that charges nothing is
 * `zero-priced`, and one with a single zero rate cannot be represented, since
 * every rate is positive. Its band count is the standard-tier endpoints above the
 * base ceiling within a short call's `max_price`: the ceiling at the largest
 * prompt the anchor itself serves, which is its own dearest rate.
 */
export function textPricingFromEndpoints(
  endpoints: readonly ZdrEndpoint[],
  catalog: CatalogLimits
): TextPricing {
  const anchored = anchorScheduleOf(endpoints, catalog);
  if (anchored.kind === 'excluded') return anchored;
  if (chargesNothing(anchored.schedule)) return { kind: 'excluded', reason: 'zero-priced' };
  const stored = bakedSchedule(anchored.schedule, anchored.anchorReach);
  const parsed = ModelPricingSchema.safeParse(stored);
  if (!parsed.success || parsed.data.kind !== 'tokens') {
    return { kind: 'excluded', reason: 'unknown-pricing-unit' };
  }
  return {
    kind: 'priced',
    pricing: parsed.data,
    stored,
    providerBase: providerBaseOf(anchored.schedule),
    maxOutputTokens: anchored.maxOutputTokens,
    contextLength: anchored.contextLength,
    bandOpenEndpoints: endpointsInBand(
      anchored.standardBases,
      maxPricePico(ceilingOf(parsed.data.anchor).base),
      maxPricePico(callCeilingRates(parsed.data, anchored.anchorReach))
    ),
  };
}

/**
 * The commercial admission rules (BILLING.md §Catalog Admission), over the
 * PRE-FEE rates — the markup IS the margin, so the raw rate is what decides
 * whether a percentage of it is worth having. Called before fee baking, on the
 * language path only: image and video price per unit, so a per-token floor has
 * no meaning for them and none is applied. The zero-rate rule is NOT
 * language-only — {@link excludeZeroPriced} applies it to the per-unit
 * families; the combined-rate verdict stays here because it is the same
 * arithmetic the floor needs and because it must outrank the floor and the age
 * cutoff.
 *
 * Reason order is fixed and load-bearing: a zero rate earns nothing so it is
 * unconditional and first, then the floor, then age. A model failing both the
 * floor and the age cutoff therefore reports one stable reason, which is what
 * keeps the refresh summary's counts comparable across runs.
 */
function commercialExclusionReason(
  base: PricedText['providerBase'],
  contextLength: number,
  releasedAtSeconds: number,
  admission: CatalogAdmission
): ExcludeReason | undefined {
  const verdict = priceFloorVerdict(base.input, base.output);
  if (verdict === 'zero') return 'zero-priced';
  if (contextLength >= admission.contextExemptionTokens) return undefined;
  if (verdict === 'below-floor') return 'below-price-floor';
  return exceedsModelAgeLimit(releasedAtSeconds, admission.nowMs) ? 'too-old' : undefined;
}

function normalizeLanguage(
  model: LanguageMetadata,
  endpoints: readonly ZdrEndpoint[],
  admission: CatalogAdmission
): NormalizeOutcome {
  if (model.deprecated) {
    return { kind: 'excluded', modelId: model.id, reason: 'deprecated' };
  }
  const outputs = knownModalities(model.outputModalities);
  if (callShapeFamilyFor(outputs) === undefined) {
    return { kind: 'excluded', modelId: model.id, reason: 'unclassifiable-modality' };
  }
  if (model.releasedAt === undefined || model.releasedAt <= 0) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-release-date' };
  }
  const text = textPricingFromEndpoints(endpoints, {
    maxOutputTokens: model.maxCompletionTokens,
    contextLength: model.contextLength,
    supportedParameters: model.supportedParameters,
  });
  if (text.kind === 'excluded') {
    return { kind: 'excluded', modelId: model.id, reason: text.reason };
  }
  const commercial = commercialExclusionReason(
    text.providerBase,
    text.contextLength ?? 0,
    model.releasedAt,
    admission
  );
  if (commercial !== undefined) {
    return { kind: 'excluded', modelId: model.id, reason: commercial };
  }
  if (declaresUnrepresentableTokenLimit(model)) {
    return { kind: 'excluded', modelId: model.id, reason: 'unrepresentable-token-limit' };
  }
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    version: DESCRIPTOR_VERSION,
    inputs: inputsOrText(model.inputModalities),
    outputs,
    releasedAt: model.releasedAt,
    parameters: seedParameters(model.supportedParameters),
    // Behaviors key off the canonical family of the FINAL outputs: a
    // text→media entry (file-part outputs, no text) is media-classified by
    // exposure gating and dispatch, so it carries media behaviors (none
    // today), never streaming/language.
    behaviors:
      callShapeFamilyFor(outputs) === 'language'
        ? languageBehaviors(model.supportedParameters)
        : [],
    limits: languageLimits(text),
    pricing: text.stored,
    zdrReachable: true,
    ...nameOf(model),
    ...descriptionOf(model),
    ...reasoningOf(model),
  };
  return { kind: 'normalized', content, bandOpenEndpoints: text.bandOpenEndpoints };
}

// --- image -----------------------------------------------------------------

/**
 * A media row that describes no aspect-ratio domain is UNREPRESENTABLE DATA, not
 * a model with an open axis: nothing downstream can offer the user a shape to
 * pick, and the alternative to refusing it is a fabricated global default —
 * exactly the hand-written second domain the catalog's own ParamSpecs replace.
 * So it is excluded with an alert, the way `CODE-RULES.md` §Registries already
 * handles an unknown pricing unit.
 *
 * Read off the minted specs rather than the gateway metadata so it asks the same
 * question every consumer asks: "does this model's descriptor carry a domain
 * under the axis name the dimensions look up?"
 *
 * Placement is deliberate — LAST in each media normalizer, after the pricing
 * gates and downstream of the ZDR/non-conversational pre-gate. A row already
 * hidden for another reason keeps that reason, so the hourly refresh stays quiet
 * and the alert fires only when a shapeless model would otherwise be sellable.
 */
function declaresNoAspectRatio(parameters: Readonly<Record<string, ParameterSpec>>): boolean {
  return parameters[MEDIA_PARAMETER_NAMES.aspectRatio] === undefined;
}

/**
 * Where an image's rows bill at different rates the resolution picks the row, so
 * the resolution spec defaults to the smallest listed size, which a call that
 * names none is sent; the reserve stays the dearest row whatever is sent.
 */
function imageParameters(
  params: ImageSupportedParameters,
  rates: Extract<ImageRates, { kind: 'priced' }>
): Record<string, ParameterSpec> {
  const specs: Record<string, ParameterSpec> = mediaParameterSpecs({
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
  });
  const resolution = specs[MEDIA_PARAMETER_NAMES.resolution];
  const [first, ...rest] = params.resolution;
  if (resolution !== undefined && first !== undefined && ratesDiffer(rates)) {
    specs[MEDIA_PARAMETER_NAMES.resolution] = {
      ...resolution,
      default: smallestResolution([first, ...rest]),
    };
  }
  if (params.maxN !== undefined) {
    specs['n'] = { type: 'integer', min: 1, max: params.maxN, wire: 'providerOptions' };
  }
  return specs;
}

/**
 * The ZDR endpoint tags an image call may pin with `provider.only`: each ZDR
 * listing tag an image endpoint carries, once. The listing and the image
 * endpoints are joined by tag, so an endpoint that no ZDR row accounts for is
 * non-ZDR. The pin is empty — the model cannot be pinned — when any endpoint
 * has no tag, since the pin cannot speak for an endpoint it cannot name, or
 * when a non-ZDR endpoint's tag is a pinned tag or a variant under one, because
 * `only` admits a base slug's every variant (OpenRouter's base-slug rule).
 */
export function pinnableZdrTags(
  zdrTags: readonly string[],
  endpointTags: readonly (string | null)[]
): readonly string[] {
  const zdrRows = new Map<string, number>();
  for (const tag of zdrTags) zdrRows.set(tag, (zdrRows.get(tag) ?? 0) + 1);
  const pinned = new Set<string>();
  const nonZdr: string[] = [];
  for (const tag of endpointTags) {
    if (tag === null) return [];
    const rows = zdrRows.get(tag) ?? 0;
    if (rows > 0) {
      zdrRows.set(tag, rows - 1);
      pinned.add(tag);
    } else {
      nonZdr.push(tag);
    }
  }
  const collides = nonZdr.some((tag) =>
    [...pinned].some((pin) => tag === pin || tag.startsWith(`${pin}/`))
  );
  return collides ? [] : [...pinned];
}

function normalizeImage(model: ImageMetadata, zdrEndpoints: readonly ZdrEndpoint[]): MediaOutcome {
  const [firstTag, ...restTags] = pinnableZdrTags(
    zdrEndpoints.map((endpoint) => endpoint.tag),
    model.endpoints.map((endpoint) => endpoint.providerTag)
  );
  if (firstTag === undefined) {
    return { kind: 'excluded', modelId: model.id, reason: 'non-zdr' };
  }
  const zdrPin: readonly [string, ...string[]] = [firstTag, ...restTags];
  if (model.releasedAt === undefined || model.releasedAt <= 0) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-release-date' };
  }
  // Only a pinned endpoint can serve the call, so only its rows price it.
  const priced = imageRates(
    model.endpoints
      .filter((endpoint) => endpoint.providerTag !== null && zdrPin.includes(endpoint.providerTag))
      .flatMap((endpoint) => endpoint.pricing)
  );
  // Deterministic-only support: an image model we cannot price at admission or
  // settlement is excluded, never exposed unpriced. Token-priced, megapixel-
  // priced, and no-pricing (empty endpoints) are quiet, expected shapes;
  // anything else unrecognizable is the loud defect.
  if (priced.kind === 'token') {
    return { kind: 'excluded', modelId: model.id, reason: 'token-priced-image' };
  }
  if (priced.kind === 'megapixel') {
    return { kind: 'excluded', modelId: model.id, reason: 'megapixel-priced-image' };
  }
  if (priced.kind === 'missing') {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-pricing' };
  }
  if (priced.kind === 'unknown') {
    return { kind: 'excluded', modelId: model.id, reason: 'unknown-pricing-unit' };
  }
  const parameters = imageParameters(model.supportedParameters, priced);
  if (declaresNoAspectRatio(parameters)) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-aspect-ratio' };
  }
  const content: Extract<MediaOutcome, { kind: 'normalized' }>['content'] = {
    id: model.id,
    provider: model.provider,
    version: DESCRIPTOR_VERSION,
    inputs: inputsOrText(model.inputModalities),
    outputs: ['image'],
    releasedAt: model.releasedAt,
    parameters,
    behaviors: [],
    limits: {},
    pricing: { kind: 'perImage', anchor: priced.anchor, dearest: priced.dearest },
    zdrReachable: true,
    zdrPin,
    ...nameOf(model),
    ...descriptionOf(model),
  };
  return { kind: 'normalized', content };
}

// --- video -----------------------------------------------------------------

function videoParameters(model: VideoMetadata): Record<string, ParameterSpec> {
  // Durations are valued as integer seconds so a numeric request duration matches
  // the ParamSpec compiler's strict enum membership (the wire catalog carries
  // durations as strings). Non-integer/absent durations drop out, mirroring the
  // client-facing `supportedVideoDurationsSeconds` filter.
  const durationSeconds = model.durations
    .map(Number)
    .filter((seconds) => Number.isInteger(seconds) && seconds > 0);
  const specs: Record<string, ParameterSpec> = mediaParameterSpecs({
    resolution: model.resolutions,
    aspectRatio: model.aspectRatios,
    durationSeconds,
  });
  if (model.generateAudio) specs['generateAudio'] = { type: 'boolean', wire: 'providerOptions' };
  if (model.seed) specs['seed'] = { type: 'integer', wire: 'providerOptions' };
  return specs;
}

function normalizeVideo(model: VideoMetadata, zdrReachable: boolean): MediaOutcome {
  if (model.releasedAt === undefined || model.releasedAt <= 0) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-release-date' };
  }
  const priced = videoRates(model.resolutions, model.pricingSkus);
  if (priced.kind === 'token') {
    return { kind: 'excluded', modelId: model.id, reason: 'token-priced-video' };
  }
  if (priced.kind === 'unknown') {
    return { kind: 'excluded', modelId: model.id, reason: 'unknown-pricing-unit' };
  }
  // A model that declares no resolution states no rate for any call it could
  // take, and a per-second price must price at least one resolution.
  if (priced.kind === 'empty') {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-pricing' };
  }
  const parameters = videoParameters(model);
  if (declaresNoAspectRatio(parameters)) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-aspect-ratio' };
  }
  const inputs: Modality[] = model.supportsFrameImages ? ['text', 'image'] : ['text'];
  const content: Extract<MediaOutcome, { kind: 'normalized' }>['content'] = {
    id: model.id,
    provider: model.provider,
    version: DESCRIPTOR_VERSION,
    inputs,
    outputs: ['video'],
    releasedAt: model.releasedAt,
    parameters,
    behaviors: [],
    limits: {},
    pricing: {
      kind: 'perSecond',
      anchor: priced.perSecondByResolution,
      dearest: priced.perSecondByResolution,
    },
    zdrReachable,
    ...nameOf(model),
    ...descriptionOf(model),
  };
  const { fallbacks } = priced;
  return fallbacks.length > 0
    ? { kind: 'normalized', content, pricingFallbacks: fallbacks }
    : { kind: 'normalized', content };
}

/** The firm per-model gate, applied before family dispatch so it lives in one
 * family-agnostic place. A model `/endpoints/zdr` does not list is `non-zdr`
 * before any other check; a listed one is next excluded if it is a
 * non-conversational specialty model; `undefined` means the model passes to
 * normalization. Listing is necessary for reachability, not sufficient: a
 * listed language model is reachable only with an eligible standard-tier
 * endpoint, which its own path checks after its deprecation, modality and
 * release-date gates, and a listed image model only with a pin
 * ({@link pinnableZdrTags}). */
function nonChatExclusionReason(
  model: GatewayModelMetadata,
  listed: boolean
): ExcludeReason | undefined {
  if (!listed) return 'non-zdr';
  if (isNonConversational(model.id, model.provider, model.name)) return 'non-conversational';
  return undefined;
}

/** Every vendor decimal rate of a media price baked billable, as
 * {@link bakedRate} bakes a token rate. Applied once, in {@link perUnitGates},
 * so every per-unit family bakes fees identically. The same-id merge only picks
 * among already-baked prices and never re-applies. */
function billablePricing(pricing: MediaStoredPricing): MediaStoredPricing {
  switch (pricing.kind) {
    case 'perImage': {
      return {
        kind: 'perImage',
        anchor: bakedRate(pricing.anchor),
        dearest: bakedRate(pricing.dearest),
      };
    }
    case 'perSecond': {
      return {
        kind: 'perSecond',
        anchor: billableRates(pricing.anchor),
        dearest: billableRates(pricing.dearest),
      };
    }
  }
}

function billableRates(rates: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rates).map(([resolution, rate]) => [resolution, bakedRate(rate)])
  );
}

/** Every rate a media price states, the per-second matrix flattened. */
function statedRates(pricing: MediaStoredPricing): string[] {
  switch (pricing.kind) {
    case 'perImage': {
      return [pricing.anchor, pricing.dearest];
    }
    case 'perSecond': {
      return [...Object.values(pricing.anchor), ...Object.values(pricing.dearest)];
    }
  }
}

/**
 * A model that names its rates and charges nothing for any of them earns
 * nothing, so it cannot be sold — the rule {@link textPricingFromEndpoints}
 * applies to a token price, stated once here over the per-unit families'
 * pricing. A rate the gateway states below nano-USD precision converts to a
 * zero rate, so it is excluded by this gate too.
 *
 * Every price reaching here states at least one rate: a video row that
 * declares no resolution is excluded before it arrives.
 */
function pricesNothing(pricing: MediaStoredPricing): boolean {
  return statedRates(pricing).every((rate) => usdRateToNanoUsd(rate) === '0');
}

/** The per-unit zero-rate gate, applied BEFORE fee baking: a markup on a zero
 * rate is still zero, but the rule is about the provider's rate, so it reads
 * the pre-fee one. */
function excludeZeroPriced(outcome: MediaOutcome): MediaOutcome {
  if (outcome.kind === 'excluded' || !pricesNothing(outcome.content.pricing)) return outcome;
  return { kind: 'excluded', modelId: outcome.content.id, reason: 'zero-priced' };
}

/** The one place per-unit provider rates become billable. */
function bakeFees(outcome: MediaOutcome): MediaOutcome {
  if (outcome.kind === 'excluded') return outcome;
  return {
    ...outcome,
    content: { ...outcome.content, pricing: billablePricing(outcome.content.pricing) },
  };
}

/**
 * A billable price the schedule cannot represent is excluded with an alert,
 * never persisted: every rate must be positive, so a video model with a zero
 * resolution beside priced ones is refused here. Placed after {@link excludeZeroPriced}, so a model that prices
 * nothing at all keeps its quiet commercial reason.
 */
function excludeUnrepresentable(outcome: MediaOutcome): NormalizeOutcome {
  if (outcome.kind === 'excluded') return outcome;
  if (ModelPricingSchema.safeParse(outcome.content.pricing).success) return outcome;
  return { kind: 'excluded', modelId: outcome.content.id, reason: 'unknown-pricing-unit' };
}

/**
 * OpenRouter metadata → descriptor content (version-stamped, fee-baked;
 * `fetchedAt` is stamped at persist time). Membership in `/endpoints/zdr` by
 * model id is necessary for `zdrReachable`: an unlisted model is hidden as
 * `non-zdr` (fail-closed). A listed video model is reachable; a listed image
 * model is reachable only with a pin of its ZDR endpoint tags, which also
 * bounds the endpoints that price it; a listed language model is reachable
 * only with an eligible standard-tier endpoint, and its price and limits come
 * from its ZDR endpoints. Modalities
 * come from `architecture.*_modalities` (language) or the endpoint the model
 * was discovered on (image/video).
 *
 * `admission` carries the pool-relative commercial inputs; only the language
 * path consumes them, and only {@link normalizeCatalog} can derive them.
 */
export function normalizeModel(
  model: GatewayModelMetadata,
  zdr: ZdrListing,
  admission: CatalogAdmission
): NormalizeOutcome {
  const endpoints = zdr.get(model.id) ?? [];
  const excludedReason = nonChatExclusionReason(model, zdr.has(model.id));
  if (excludedReason !== undefined) {
    return { kind: 'excluded', modelId: model.id, reason: excludedReason };
  }
  return normalizeBySource(model, endpoints, admission);
}

/** The per-unit families' gates, each written once for every per-unit family:
 * the zero-rate exclusion, then fee baking, then the schedule's parse. */
function perUnitGates(outcome: MediaOutcome): NormalizeOutcome {
  return excludeUnrepresentable(bakeFees(excludeZeroPriced(outcome)));
}

function normalizeBySource(
  model: GatewayModelMetadata,
  endpoints: readonly ZdrEndpoint[],
  admission: CatalogAdmission
): NormalizeOutcome {
  switch (model.source) {
    case 'language': {
      return normalizeLanguage(model, endpoints, admission);
    }
    case 'image': {
      return perUnitGates(normalizeImage(model, endpoints));
    }
    case 'video': {
      return perUnitGates(normalizeVideo(model, true));
    }
  }
}

// --- dedupe + merge (one catalog, one row per id) --------------------------

/** One deduped catalog id: either a single merged descriptor or an exclusion.
 * The catalog is single-row-per-model (`model_catalog` UNIQUE(model_id)), so a
 * slug advertised by more than one endpoint must resolve to ONE descriptor —
 * not two rows racing to overwrite each other and oscillating between refreshes. */
export type CatalogEntry =
  | {
      readonly kind: 'normalized';
      readonly modelId: string;
      readonly content: DescriptorContent;
      /** Resolutions whose price was substituted (video fallback — §Solution 2a);
       * telemetry-only, never persisted. Present only when non-empty. */
      readonly pricingFallbacks?: readonly string[];
      /** Standard-tier endpoints a short call's `max_price` admits above the base
       * ceiling; telemetry-only, never persisted. Present only when above 0. */
      readonly bandOpenEndpoints?: number;
    }
  | { readonly kind: 'excluded'; readonly modelId: string; readonly reason: ExcludeReason };

/** Fixed merge order so a folded descriptor is identical no matter the order the
 * endpoints were fetched in — the property that kills refresh oscillation. The
 * language entry (richest: streaming, tool behaviors, token params) is the fold
 * base whenever present. */
const SOURCE_MERGE_PRIORITY: Readonly<Record<GatewayModelMetadata['source'], number>> = {
  language: 0,
  image: 1,
  video: 2,
};

/** Canonical order for language behaviors, so a merged behaviors list is stable
 * regardless of which sibling contributed each behavior. */
const LANGUAGE_BEHAVIOR_ORDER: readonly string[] = ['streaming', 'tools', 'reasoning'];

/** Union of two modality lists in the closed MODALITIES order (deterministic). */
function unionModalities(a: readonly Modality[], b: readonly Modality[]): Modality[] {
  const present = new Set<Modality>([...a, ...b]);
  return MODALITIES.filter((modality) => present.has(modality));
}

/** Behaviors recomputed against the MERGED outputs' family: language behaviors
 * (streaming, …) survive a text+media merge; a non-language merged family
 * carries none. Deterministic order regardless of sibling contribution order. */
function mergedBehaviors(
  outputs: readonly Modality[],
  a: readonly string[],
  b: readonly string[]
): string[] {
  if (callShapeFamilyFor(outputs) !== 'language') return [];
  const present = new Set<string>([...a, ...b]);
  const ordered = LANGUAGE_BEHAVIOR_ORDER.filter((behavior) => present.has(behavior));
  const extras = [...present]
    .filter((behavior) => !LANGUAGE_BEHAVIOR_ORDER.includes(behavior))
    .toSorted((x, y) => x.localeCompare(y));
  return [...ordered, ...extras];
}

/**
 * The price a merged descriptor carries: one price, never a union of two. The
 * base's price when it charges by the merged outputs' family, else the next
 * sibling's when that one does, else the base's — so a slug advertised by a
 * language endpoint and an image endpoint, merged into an image model, carries
 * its per-image rate.
 */
function mergedPricing(
  outputs: readonly Modality[],
  base: StoredPricing,
  next: StoredPricing
): StoredPricing {
  const family = callShapeFamilyFor(outputs);
  if (family === undefined) return base;
  const kind = PRICING_KIND_BY_FAMILY[family];
  if (base.kind !== kind && next.kind === kind) return next;
  return base;
}

/** Fold `next` into `base` (base takes precedence on scalar/key conflicts).
 * Outputs and inputs union; behaviors recompute against the merged outputs. */
function mergeContent(base: DescriptorContent, next: DescriptorContent): DescriptorContent {
  const outputs = unionModalities(base.outputs, next.outputs);
  const name = base.name ?? next.name;
  const description = base.description ?? next.description;
  // Only language sources carry reasoning, so at most one sibling declares it
  // — base precedence is deterministic regardless of contribution order.
  const reasoning = base.reasoning ?? next.reasoning;
  // Only image sources carry a pin, so at most one sibling declares it.
  const zdrPin = base.zdrPin ?? next.zdrPin;
  return {
    id: base.id,
    provider: base.provider,
    version: base.version,
    inputs: unionModalities(base.inputs, next.inputs),
    outputs,
    releasedAt: base.releasedAt,
    parameters: { ...next.parameters, ...base.parameters },
    behaviors: mergedBehaviors(outputs, base.behaviors, next.behaviors),
    limits: { ...next.limits, ...base.limits },
    pricing: mergedPricing(outputs, base.pricing, next.pricing),
    zdrReachable: base.zdrReachable,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(zdrPin === undefined ? {} : { zdrPin }),
  };
}

/** A normalized catalog entry, carrying `pricingFallbacks` only when non-empty
 * and `bandOpenEndpoints` only when above 0. */
function normalizedEntry(
  modelId: string,
  content: DescriptorContent,
  fallbacks: readonly string[],
  bandOpen: number
): CatalogEntry {
  return {
    kind: 'normalized',
    modelId,
    content,
    ...(fallbacks.length > 0 ? { pricingFallbacks: fallbacks } : {}),
    ...(bandOpen > 0 ? { bandOpenEndpoints: bandOpen } : {}),
  };
}

/** Resolve one id's siblings into a single entry: fold the normalized ones in
 * merge order; excluded only when every sibling is excluded (a normalized
 * sibling wins — the model is exposed via its merged form). */
function resolveGroup(
  modelId: string,
  siblings: readonly GatewayModelMetadata[],
  zdr: ZdrListing,
  admission: CatalogAdmission
): CatalogEntry {
  const ordered = siblings.toSorted(
    (a, b) => SOURCE_MERGE_PRIORITY[a.source] - SOURCE_MERGE_PRIORITY[b.source]
  );
  let content: DescriptorContent | undefined;
  let excludedReason: ExcludeReason | undefined;
  const fallbacks: string[] = [];
  let bandOpen = 0;
  for (const model of ordered) {
    const outcome = normalizeModel(model, zdr, admission);
    if (outcome.kind === 'excluded') {
      excludedReason ??= outcome.reason;
      continue;
    }
    fallbacks.push(...(outcome.pricingFallbacks ?? []));
    bandOpen += outcome.bandOpenEndpoints ?? 0;
    content = content === undefined ? outcome.content : mergeContent(content, outcome.content);
  }
  if (content === undefined) {
    // A group always has ≥1 sibling, so with no normalized content a reason is set.
    return { kind: 'excluded', modelId, reason: excludedReason ?? 'deprecated' };
  }
  const reason = mergedExclusionReason(content);
  if (reason !== undefined) return { kind: 'excluded', modelId, reason };
  return normalizedEntry(modelId, content, fallbacks, bandOpen);
}

/** Why the MERGED content of one id is not admitted, or `undefined` when it is. */
function mergedExclusionReason(content: DescriptorContent): ExcludeReason | undefined {
  // Admission enforces the shared runnability predicate on the MERGED content:
  // a slug advertised across endpoints (e.g. /models + /images) folds to a
  // multi-output descriptor no turn can run — deny it here so "in catalog ⟺
  // runs correctly" holds, and it is never persisted.
  if (!isRunnableModelShape(content)) return 'non-runnable-shape';
  // An image model reached only through a language row has no image endpoint to
  // pin, and on the Images API the pin is the only request-level ZDR mechanism.
  if (callShapeFamilyFor(content.outputs) === 'image' && content.zdrPin === undefined) {
    return 'non-zdr';
  }
  return undefined;
}

/**
 * Normalize a full catalog into one {@link CatalogEntry} per model id, merging
 * duplicate ids across endpoints into a single descriptor. The `model_catalog`
 * table is one-row-per-model, so a slug advertised by more than one endpoint
 * must resolve to ONE descriptor — not rows racing to overwrite each other and
 * oscillating between refreshes.
 *
 * This is also where catalog admission's top-context exemption is measured, and
 * the only place it can be: the threshold is a percentile over the pool, so no
 * per-model function can derive it. `nowMs` is the refresh clock the age cutoff
 * is measured back from, injected so normalization stays a pure function.
 */
export function normalizeCatalog(
  models: readonly GatewayModelMetadata[],
  zdr: ZdrListing,
  nowMs: number
): CatalogEntry[] {
  const groups = new Map<string, GatewayModelMetadata[]>();
  const order: string[] = [];
  for (const model of models) {
    const existing = groups.get(model.id);
    if (existing === undefined) {
      groups.set(model.id, [model]);
      order.push(model.id);
    } else {
      existing.push(model);
    }
  }
  const admission: CatalogAdmission = {
    contextExemptionTokens: topContextExemptionTokens(soldLanguageContexts(models, zdr)),
    nowMs,
  };
  return order.map((modelId) => resolveGroup(modelId, groups.get(modelId) ?? [], zdr, admission));
}
