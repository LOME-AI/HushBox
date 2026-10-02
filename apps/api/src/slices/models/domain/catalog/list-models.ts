import { PRICING_KIND_BY_FAMILY, PROVIDER_MAP, SMART_MODEL_ID, modelSchema } from '@hushbox/shared';
import { smartPoolRange } from '@hushbox/shared/affordability/price/display';
import { pricingToWire, tokenPricingOf } from '@hushbox/shared/affordability/price/wire';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import { dispatchFamilyFor } from '../dispatch.js';
import { listDescriptors, readExposedCatalog } from './list-descriptors.js';
import {
  isTextModel,
  premiumThresholdFor,
  trialEligibilityAgainst,
} from '../smart-model/trial-eligibility.js';
import type {
  Model,
  ModelDescriptor,
  ModelsListResponse,
  NanoUSD,
  WireModelPricing,
} from '@hushbox/shared';
import type { TokenPricing } from '@hushbox/shared/affordability/price/schedule';
import type { CatalogRowDefect, ListDescriptorsDeps, RowDefect } from './list-descriptors.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';

/**
 * The public catalog projection: exposed descriptors → the shared
 * `ModelsListResponse` wire contract (`Model[]` + `premiumModelIds`) the web
 * picker and the marketing site consume. Pricing is projected as BILLABLE
 * integer nano-USD rates: the served keys of the descriptor's price, its anchor
 * with its long-context rates, and beside a media anchor the dearest unit a
 * hold reserves — the catalog bakes the markup once at ingestion, so applying a
 * fee to these rates anywhere downstream would charge it twice.
 */

/**
 * Display provider + name, matching the legacy split: an OpenRouter display
 * name like "Google: Gemini 2.5 Pro" carries its provider before the colon;
 * otherwise the descriptor's provider slug maps through `PROVIDER_MAP` (the
 * slug itself is the fallback — more informative than legacy's 'Unknown').
 */
export function modelDisplayOf(descriptor: ModelDescriptor): {
  readonly name: string;
  readonly provider: string;
} {
  const raw = descriptor.name;
  if (raw !== undefined) {
    const colonIndex = raw.indexOf(':');
    if (colonIndex > 0) {
      const provider = raw.slice(0, colonIndex).trim();
      const name = raw.slice(colonIndex + 1).trim();
      if (provider.length > 0 && name.length > 0) return { provider, name };
    }
  }
  return {
    provider: PROVIDER_MAP[descriptor.provider] ?? descriptor.provider,
    name: raw ?? descriptor.id,
  };
}

/** Enum ParamSpec values as display strings, or undefined when absent. */
function enumValues(descriptor: ModelDescriptor, key: string): string[] | undefined {
  const spec = descriptor.parameters[key];
  if (spec?.type !== 'enum' || spec.values === undefined) return undefined;
  return spec.values.map(String);
}

/** Enum ParamSpec values as positive integers (video durations), or undefined. */
function enumIntegers(descriptor: ModelDescriptor, key: string): number[] | undefined {
  const spec = descriptor.parameters[key];
  if (spec?.type !== 'enum' || spec.values === undefined) return undefined;
  const integers = spec.values
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0);
  return integers.length > 0 ? integers : undefined;
}

/**
 * Billable nano pricing for a descriptor, carrying ONLY its own modality's rate
 * dimension: a price that charges by another family's unit serves no rate, so
 * the schema's modality-pricing refinement drops the row (fail-closed on
 * unpriceable models) rather than serving a foreign rate.
 */
function modalityPricing(descriptor: ModelDescriptor, family: ListedFamily): WireModelPricing {
  return descriptor.pricing.kind === PRICING_KIND_BY_FAMILY[family]
    ? pricingToWire(descriptor.pricing)
    : {};
}

/** Optional capability-list spreads sourced from the descriptor's ParamSpecs. */
function capabilityLists(
  descriptor: ModelDescriptor,
  family: ListedFamily
): Partial<
  Pick<
    Model,
    'supportedAspectRatios' | 'supportedVideoResolutions' | 'supportedVideoDurationsSeconds'
  >
> {
  if (family === 'language') return {};
  const aspectRatios = enumValues(descriptor, 'aspectRatio');
  const resolutions = family === 'video' ? enumValues(descriptor, 'resolution') : undefined;
  const durations = family === 'video' ? enumIntegers(descriptor, 'durationSeconds') : undefined;
  return {
    ...(aspectRatios === undefined ? {} : { supportedAspectRatios: aspectRatios }),
    ...(resolutions === undefined ? {} : { supportedVideoResolutions: resolutions }),
    ...(durations === undefined ? {} : { supportedVideoDurationsSeconds: durations }),
  };
}

const MODALITY_BY_FAMILY = { language: 'text', image: 'image', video: 'video' } as const;

/** The families the list serves (embedding stays hidden — no adapter ships). */
type ListedFamily = keyof typeof MODALITY_BY_FAMILY;

/** One descriptor → a shared-contract `Model` candidate (unvalidated). */
function wireCandidate(descriptor: ModelDescriptor, family: ListedFamily): unknown {
  const { provider, name } = modelDisplayOf(descriptor);
  const contextLength = family === 'language' ? (descriptor.limits['contextLength'] ?? 0) : 0;
  const maxOutputTokens = family === 'language' ? descriptor.limits['maxOutputTokens'] : undefined;
  return {
    id: descriptor.id,
    name,
    provider,
    modality: MODALITY_BY_FAMILY[family],
    contextLength,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    pricing: modalityPricing(descriptor, family),
    description: descriptor.description ?? name,
    supportedParameters: [...descriptor.behaviors, ...Object.keys(descriptor.parameters)],
    created: descriptor.releasedAt,
    ...capabilityLists(descriptor, family),
    ...(descriptor.popularityRank === undefined
      ? {}
      : { popularityRank: descriptor.popularityRank }),
    ...(descriptor.reasoning === undefined ? {} : { reasoning: descriptor.reasoning }),
  };
}

/**
 * A descriptor the Smart Model price range (and pool) can be computed over.
 *
 * The text leg looks redundant beside the two rate legs and is not. Catalog
 * normalization refuses a LANGUAGE-sourced row over its output modality in two
 * separate places: the language path refuses outputs matching no call-shape
 * family, and group resolution refuses the merged content over
 * `isRunnableModelShape`, which is what kills multi-output and embedding-output
 * rows. Token pricing is applied to whatever those two admit, image and video
 * outputs included, so a text→image row carries both per-token rates. Such a row
 * never lists — its wire candidate states no per-image rate and `modelSchema`
 * refuses it — but {@link smartModelRows} builds the pool from the raw
 * descriptors, so this leg is the only thing keeping it out of the price range
 * the Smart Model row advertises.
 */
function isPriceableTextDescriptor(descriptor: ModelDescriptor): boolean {
  return isTextModel(descriptor) && tokenPricingOf(descriptor.pricing) !== undefined;
}

/**
 * The pool's token prices. `isPriceableTextDescriptor` gates pool membership on
 * a token price, so a pool entry without one means the pool was built some
 * other way; it refuses rather than dropping the entry, which would narrow the
 * range the Smart Model row advertises.
 */
function poolPricings(pool: readonly ModelDescriptor[]): readonly TokenPricing[] {
  return pool.map((entry) => {
    const pricing = tokenPricingOf(entry.pricing);
    /* v8 ignore next -- unreachable: the pool filter tests this same narrowing,
       so the guard only narrows the lookup */
    if (pricing === undefined)
      throw new RangeError('smart model pool: an entry has no token price');
    return pricing;
  });
}

/**
 * The synthetic Smart Model entry — a virtual list row the UI can select; the
 * backend resolves the real model per message. Headline prices track the
 * cheapest pool rates (the real lower bound); min/max carry the display range.
 */
function smartModelCandidate(pool: readonly ModelDescriptor[]): unknown {
  const { minPricing, maxPricing } = smartPoolRange(poolPricings(pool));
  const contexts = pool.map((entry) => entry.limits['contextLength'] ?? 0);
  return {
    id: SMART_MODEL_ID,
    name: 'Smart Model',
    provider: 'HushBox',
    modality: 'text',
    contextLength: Math.max(...contexts),
    pricing: minPricing,
    description: 'Automatically picks the best model for each message.',
    supportedParameters: [],
    isSmartModel: true,
    minPricing,
    maxPricing,
  };
}

/**
 * The list-level premium classification (legacy `processModels` semantics):
 * a text model is premium exactly when the trial gate would refuse it as
 * `premium` (top price quartile OR recent release OR minimal-exchange
 * unaffordability — the one shared predicate, so the list and the paid tier
 * gate never disagree); every non-text model is premium (media modalities
 * require an account, mirroring legacy's all-media-premium ids).
 */
function isPremiumListed(
  descriptor: ModelDescriptor,
  priceThresholdNanoUsd: NanoUSD | undefined,
  nowMs: number
): boolean {
  if (!isTextModel(descriptor)) return true;
  const verdict = trialEligibilityAgainst(descriptor, priceThresholdNanoUsd, nowMs);
  return !verdict.eligible && verdict.reason === 'premium';
}

interface WireCatalog {
  readonly response: ModelsListResponse;
  /** Model ids whose wire projection failed the shared contract (hidden). */
  readonly dropped: readonly string[];
}

/** The validated Smart Model rows (none when no priceable text pool exists). */
function smartModelRows(descriptors: readonly ModelDescriptor[], dropped: string[]): Model[] {
  const pool = descriptors.filter((entry) => isPriceableTextDescriptor(entry));
  if (pool.length === 0) return [];
  const parsed = modelSchema.safeParse(smartModelCandidate(pool));
  if (!parsed.success) {
    dropped.push(SMART_MODEL_ID);
    return [];
  }
  return [parsed.data];
}

/**
 * Exposed descriptors → the wire response. Legacy list order is preserved:
 * text models, then the synthetic Smart Model entry, then media models. A
 * projection that fails the shared `modelSchema` is dropped (hidden is the
 * safe failure mode — one bad row never takes down the list); the schema
 * parse also strips anything beyond the shared contract.
 */
export function buildModelsListResponse(
  descriptors: readonly ModelDescriptor[],
  nowMs: number
): WireCatalog {
  const textModels: Model[] = [];
  const mediaModels: Model[] = [];
  const premiumModelIds: string[] = [];
  const dropped: string[] = [];
  // Once for the catalog, never once per descriptor: the threshold is a
  // percentile over the whole priceable text pool, so recomputing it inside the
  // loop made the read quadratic in catalog size for an unchanging value.
  const priceThresholdNanoUsd = premiumThresholdFor(descriptors);

  for (const descriptor of descriptors) {
    const family = dispatchFamilyFor(descriptor);
    if (family === undefined || family === 'embedding') {
      dropped.push(descriptor.id);
      continue;
    }
    const parsed = modelSchema.safeParse(wireCandidate(descriptor, family));
    if (!parsed.success) {
      dropped.push(descriptor.id);
      continue;
    }
    (family === 'language' ? textModels : mediaModels).push(parsed.data);
    if (isPremiumListed(descriptor, priceThresholdNanoUsd, nowMs)) {
      premiumModelIds.push(descriptor.id);
    }
  }

  return {
    response: {
      models: [...textModels, ...smartModelRows(descriptors, dropped), ...mediaModels],
      premiumModelIds,
    },
    dropped,
  };
}

/**
 * The route-facing read: the exposed catalog (`listDescriptors`' ZDR- and
 * exposure-filtered set — nothing hidden there can reappear here) projected to
 * the wire contract.
 *
 * Deliberately silent. Every way a row can drop out of this list — a descriptor
 * that fails its contract, an unclassifiable call shape, a projection the shared
 * schema refuses — is a permanent defect in data we wrote ourselves, unchanged
 * between one visitor's read and the next. Reporting it here emitted the same
 * error once per visitor; {@link auditCatalogHealth} reports it once per
 * refresh, which is the only moment the answer can change.
 */
export function listModels(
  deps: ListDescriptorsDeps,
  nowMs: number
): ResultAsync<ModelsListResponse, DomainError> {
  return listDescriptors(deps, nowMs).map(
    (descriptors) => buildModelsListResponse(descriptors, nowMs).response
  );
}

/** One line per corrupt row so the ids are recoverable from the line stream,
 * and one Sentry page per cause so a catalog full of them is one repair. */
function reportRowDefects(telemetry: Telemetry, defects: readonly CatalogRowDefect[]): void {
  const causes = new Set<RowDefect>();
  for (const { modelId, defect } of defects) {
    causes.add(defect);
    if (defect === 'descriptor-invalid') {
      telemetry.error('stored model descriptor failed contract validation — hidden', {
        modelName: modelId,
        errorCode: FINGERPRINT_CODES.modelDescriptorInvalid,
      });
    } else {
      telemetry.error('model outputs match no call-shape family — hidden', {
        modelName: modelId,
        errorCode: FINGERPRINT_CODES.modelFamilyUnclassifiable,
      });
    }
  }
  if (causes.has('descriptor-invalid')) {
    telemetry.captureError(
      new Error('stored model descriptor failed contract validation'),
      FINGERPRINT_CODES.modelDescriptorInvalid
    );
  }
  if (causes.has('family-unclassifiable')) {
    telemetry.captureError(
      new Error('model outputs match no call-shape family'),
      FINGERPRINT_CODES.modelFamilyUnclassifiable
    );
  }
}

/** The same shape for the rows the wire projection refuses. */
function reportProjectionDrops(telemetry: Telemetry, dropped: readonly string[]): void {
  for (const modelId of dropped) {
    telemetry.error('model failed wire projection — hidden from the list', {
      modelName: modelId,
      errorCode: FINGERPRINT_CODES.modelProjectionInvalid,
    });
  }
  if (dropped.length > 0) {
    telemetry.captureError(
      new Error('model failed wire projection'),
      FINGERPRINT_CODES.modelProjectionInvalid
    );
  }
}

/**
 * Reports every row the catalog read and the wire projection had to drop. Run
 * once per refresh — the catalog changes only when a refresh writes it, so this
 * is the one moment a row's health can have changed, and reporting anywhere else
 * repeats a standing condition at the reader's rate rather than the data's.
 *
 * Watched through Sentry, on the three fingerprints it pages:
 * `modelDescriptorInvalid`, `modelFamilyUnclassifiable`, `modelProjectionInvalid`.
 * Best-effort, as telemetry is: it reports on the refresh's work and is never
 * part of it.
 */
export async function auditCatalogHealth(deps: ListDescriptorsDeps, nowMs: number): Promise<void> {
  const read = await readExposedCatalog(deps, nowMs);
  if (read.isErr()) {
    // On the descriptor-version refusal there is nothing to add: that standing
    // condition already fails every product read of the catalog, the loudest
    // signal available. On a failed query of the catalog table, a one-off on
    // this read alone, the best-effort audit skips this run rather than fail the
    // refresh.
    return;
  }
  const { descriptors, defects } = read.value;
  reportRowDefects(deps.telemetry, defects);
  reportProjectionDrops(deps.telemetry, buildModelsListResponse(descriptors, nowMs).dropped);
}
