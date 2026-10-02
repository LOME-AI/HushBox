import { z } from 'zod';
import { providerOfModelId } from '@hushbox/shared';
import { unavailableError, validationError } from '../../../../lib/errors/index.js';
import {
  ResultAsync,
  err,
  errAsync,
  fromPromise,
  ok,
  okAsync,
} from '../../../../lib/result/index.js';
import type { DomainError, DomainErrorCode } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { ModelReasoning } from '@hushbox/shared';

/**
 * OpenRouter catalog discovery. Four public endpoints (no API key):
 *   `/models`         — language + multimodal models (modalities, pricing,
 *                       flat supported_parameters, deprecation).
 *   `/endpoints/zdr`  — the authoritative, endpoint-granular ZDR set;
 *                       `zdrReachable` is membership by `model_id`.
 *   `/images/models`  — image models; per-model pricing is fetched N+1 from
 *                       `/images/models/{id}/endpoints`.
 *   `/videos/models`  — video models; pricing lives in a heterogeneous
 *                       `pricing_skus` dict (see the normalizer's interpreter).
 *
 * SYNTHETIC-CONTRACT NOTE: implementation agents hold no credentials, so the
 * wire shapes below are authored from OpenRouter's documented metadata
 * format and exercised only through injected fixtures — the typed
 * `GatewayCatalog` seam consumed by normalization is what stays stable.
 */

// --- paging (shared by all four lists) -------------------------------------

/**
 * The paging container every gateway list carries: the page after this one is
 * reachable only through `links.next`, which the last page omits or nulls.
 * `links` stays UNTYPED ALL THE WAY DOWN, deliberately: this file's wire shapes
 * were authored from documented metadata rather than recorded from the gateway,
 * so no shape anywhere under `links` — including `links` itself not being an
 * object — may fail the parse and take an otherwise good catalog refresh down
 * with it. Reading it is `nextPage`'s job, and it treats a shape it cannot read
 * as a walk that ended early rather than as a bad body.
 */
const listLinksSchema = z.unknown().optional();

// --- /models (language + multimodal) ---------------------------------------

const modelsPricingSchema = z.looseObject({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  input_cache_read: z.string().optional(),
});

const modelsEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  // Model creation timestamp, UNIX SECONDS. Carried through to the descriptor's
  // required `releasedAt`; a model missing it is excluded at normalization.
  created: z.number().nullish(),
  context_length: z.number().nullish(),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  pricing: modelsPricingSchema.nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  // Top-level per-model reasoning metadata (211/342 models). Effort strings
  // stay raw — unknown upstream levels are carried, never a parse failure.
  // `supported_efforts: null` (all efforts accepted) is distinct from absent
  // (no effort selection — budget-or-nothing), so the tristate is preserved.
  reasoning: z
    .looseObject({
      mandatory: z.boolean().nullish(),
      supported_efforts: z.array(z.string()).nullish(),
      default_effort: z.string().nullish(),
      default_enabled: z.boolean().nullish(),
    })
    .nullish(),
  expiration_date: z.string().nullish(),
  // Aggregate stats of the currently selected top/default provider; its
  // `max_completion_tokens` is the model's output-token ceiling
  // (integer|null upstream, null semantics undocumented).
  top_provider: z
    .looseObject({
      max_completion_tokens: z.number().nullish(),
    })
    .nullish(),
});

const modelsResponseSchema = z.looseObject({
  data: z.array(modelsEntrySchema),
  links: listLinksSchema,
});

// --- /endpoints/zdr (authoritative ZDR membership) -------------------------

const zdrResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ model_id: z.string().min(1) })),
  links: listLinksSchema,
});

// --- /images/models --------------------------------------------------------

/**
 * OpenRouter describes each image parameter as a typed object, not a bare
 * list: `{type:'enum', values:[…]}`, `{type:'range', min, max}`, or
 * `{type:'boolean'}`. Only the surfaces the descriptor exposes are extracted
 * (enum values for resolution / aspect_ratio, the range max for n); a field
 * whose shape does not match its expected type parses to `undefined`
 * per-field, so one model's odd parameter never fails the whole list — the
 * model is still cataloged, just without that one control.
 */
const enumParameterSchema = z.looseObject({
  type: z.literal('enum'),
  values: z.array(z.string()),
});

const rangeParameterSchema = z.looseObject({
  type: z.literal('range'),
  min: z.number(),
  max: z.number(),
});

const imageEnumValues = z
  .unknown()
  .optional()
  .transform((value) => enumParameterSchema.safeParse(value).data?.values);

const imageRangeMax = z
  .unknown()
  .optional()
  .transform((value) => rangeParameterSchema.safeParse(value).data?.max);

const imageSupportedParametersSchema = z
  .looseObject({
    resolution: imageEnumValues,
    aspect_ratio: imageEnumValues,
    n: imageRangeMax,
  })
  .nullish();

const imagesEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  supported_parameters: imageSupportedParametersSchema,
  endpoints: z.string().nullish(),
});

const imagesResponseSchema = z.looseObject({
  data: z.array(imagesEntrySchema),
  links: listLinksSchema,
});

/** N+1 per-image-model endpoint detail carrying the pricing rows. The body is
 * `{id, endpoints:[{…, pricing:[…]}]}`; pricing rows carry `billable` as a
 * semantic role string (`output_image`, `input_image`, …), `unit` (image /
 * token / megapixel), and a numeric `cost_usd`. */
const imagePricingRowSchema = z.looseObject({
  billable: z.string().nullish(),
  unit: z.string(),
  cost_usd: z.union([z.number(), z.string()]),
});

const imageEndpointsResponseSchema = z.looseObject({
  endpoints: z
    .array(z.looseObject({ pricing: z.array(imagePricingRowSchema).nullish() }))
    .nullish(),
});

// --- /videos/models --------------------------------------------------------

const videosEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  supported_resolutions: z.array(z.string()).nullish(),
  supported_aspect_ratios: z.array(z.string()).nullish(),
  supported_durations: z.array(z.union([z.number(), z.string()])).nullish(),
  // A list of the frame anchors the model accepts (e.g. `["first_frame"]`);
  // a non-empty list means the model takes image inputs.
  supported_frame_images: z.array(z.string()).nullish(),
  generate_audio: z.boolean().nullish(),
  seed: z.boolean().nullish(),
  pricing_skus: z.record(z.string(), z.string()).nullish(),
});

const videosResponseSchema = z.looseObject({
  data: z.array(videosEntrySchema),
  links: listLinksSchema,
});

// --- typed catalog seam ----------------------------------------------------

/** Language token rates as decimal USD strings, exactly as OpenRouter reports. */
export interface LanguageTokenPricing {
  readonly prompt?: string | undefined;
  readonly completion?: string | undefined;
  readonly cacheRead?: string | undefined;
}

export interface ImagePricingEntry {
  /** The billing role this rate prices (`output_image`, `input_image`, …);
   * only `output_image` is the generation charge. Absent on rows that omit it. */
  readonly billable: string | undefined;
  readonly unit: string;
  readonly costUsd: string;
}

export interface ImageSupportedParameters {
  readonly resolution: readonly string[];
  readonly aspectRatio: readonly string[];
  readonly maxN: number | undefined;
}

export interface LanguageMetadata {
  /** Human-readable display name — carried through to the frontend catalog. */
  readonly name?: string | undefined;
  /** Human-readable model summary — feeds the Smart Model classifier prompt. */
  readonly description?: string | undefined;
  readonly source: 'language';
  readonly id: string;
  readonly provider: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedParameters: readonly string[];
  readonly contextLength: number | undefined;
  /** Output-token ceiling from the gateway's `top_provider.max_completion_tokens`;
   * absent when the gateway reports none (null or missing). */
  readonly maxCompletionTokens?: number | undefined;
  readonly pricing: LanguageTokenPricing | undefined;
  /** Top-level per-model reasoning metadata, camelCased into the shared
   * descriptor shape; absent when the entry carries no reasoning object. */
  readonly reasoning?: ModelReasoning | undefined;
  /** Release timestamp, UNIX SECONDS (the gateway's `created`). */
  readonly releasedAt: number | undefined;
  readonly deprecated: boolean;
  /** OpenRouter top-weekly usage rank, 0-based (lower = more used); the entry's
   * index in the `?sort=top-weekly` response. The sort param is
   * undocumented-but-live; fail-soft (absent → undefined → the frontend
   * degrades to unranked order). Never persisted in the descriptor JSONB —
   * carried to the `popularity_rank` column only. */
  readonly popularityRank?: number | undefined;
}

export interface ImageMetadata {
  /** Human-readable display name — carried through to the frontend catalog. */
  readonly name?: string | undefined;
  /** Human-readable model summary — feeds the Smart Model classifier prompt. */
  readonly description?: string | undefined;
  readonly source: 'image';
  readonly id: string;
  readonly provider: string;
  readonly inputModalities: readonly string[];
  readonly supportedParameters: ImageSupportedParameters;
  readonly endpointPricing: readonly ImagePricingEntry[];
  /** Release timestamp, UNIX SECONDS (the gateway's `created`). */
  readonly releasedAt: number | undefined;
}

export interface VideoMetadata {
  /** Human-readable display name — carried through to the frontend catalog. */
  readonly name?: string | undefined;
  /** Human-readable model summary — feeds the Smart Model classifier prompt. */
  readonly description?: string | undefined;
  readonly source: 'video';
  readonly id: string;
  readonly provider: string;
  readonly supportsFrameImages: boolean;
  readonly generateAudio: boolean;
  readonly seed: boolean;
  readonly resolutions: readonly string[];
  readonly aspectRatios: readonly string[];
  readonly durations: readonly string[];
  readonly pricingSkus: Readonly<Record<string, string>>;
  /** Release timestamp, UNIX SECONDS (the gateway's `created`). */
  readonly releasedAt: number | undefined;
}

export type GatewayModelMetadata = LanguageMetadata | ImageMetadata | VideoMetadata;

/**
 * Why a list walk ended before the gateway said the list was over.
 * Absent when it ended because the list did — the only outcome that means the
 * list below is the whole list.
 *
 * A cut-off walk is a SHORT list, not a failed one: the refresh proceeds on
 * what it has, and entries past the cut go undiscovered. It rides the result
 * rather than this module's log so the caller that already holds the
 * `Telemetry` port can surface it, and so nothing here has to reach for a seam
 * it does not have. What that costs differs per list; `fetchListPages` and the
 * cut-off fields on {@link GatewayCatalog} spell out where it costs more.
 */
export type ListWalkCutoff = 'unfollowable-next-link' | 'page-budget-spent';

/**
 * A model the gateway listed that this refresh could not catalog, and the
 * taxonomy code of the failure that left it out. Only the image list produces
 * one: it is the only list whose entries each need a second, per-model request,
 * so it is the only one where a single model can fail on its own.
 *
 * It rides the result for the reason a {@link ListWalkCutoff} does — the caller
 * holds the `Telemetry` port and this module does not — and it exists so that a
 * model missing from the catalog is a reported exclusion rather than a silently
 * shorter list.
 */
export interface ModelExclusion {
  readonly id: string;
  readonly reason: DomainErrorCode;
}

export interface GatewayCatalog {
  readonly models: readonly GatewayModelMetadata[];
  /** Models the gateway listed that this refresh could not read the detail for;
   * empty when every listed model was cataloged. See {@link ModelExclusion}. */
  readonly excludedModels: readonly ModelExclusion[];
  /** Authoritative endpoint-granular ZDR membership, keyed by model id. */
  readonly zdrModelIds: ReadonlySet<string>;
  /** Present only when the language model list was walked short — see
   * {@link ListWalkCutoff}. */
  readonly modelsWalkCutoff?: ListWalkCutoff;
  /**
   * Present only when the ZDR list was walked short. The loudest of the four:
   * `zdrModelIds` is read as plain membership and an id missing from it is
   * treated as not ZDR-reachable, so a short ZDR list does not degrade a
   * ranking — it hides models fail-closed, and nothing downstream can tell
   * that apart from a model the gateway genuinely does not offer ZDR for.
   */
  readonly zdrWalkCutoff?: ListWalkCutoff;
  /** Present only when the image model list was walked short. */
  readonly imageModelsWalkCutoff?: ListWalkCutoff;
  /** Present only when the video model list was walked short. */
  readonly videoModelsWalkCutoff?: ListWalkCutoff;
}

interface FetchGatewayCatalogOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** Image-endpoints N+1 fan-out width. Threaded from the caller so dev can
   * raise it above the production cap; omitted → {@link ENDPOINT_FETCH_CONCURRENCY}. */
  readonly endpointConcurrency?: number;
  /** Per-request gateway fetch deadline; omitted → {@link FETCH_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
}

/**
 * How many image-endpoint requests the N+1 fan-out runs at once. Six is
 * Cloudflare Workers' simultaneous-outbound-connection allowance per
 * invocation, but this bounds the per-model tree alone and not a refresh:
 * {@link fetchGatewayCatalog} combines four list legs that each issue their
 * request as they are constructed, so the fan-out runs beside up to three list
 * walks still in flight and a refresh peaks at nine connections. The overshoot
 * is accepted rather than overlooked — excess connections queue rather than
 * fail, so it costs a marginally slower refresh and nothing else. Dev
 * (`wrangler`-free `catalog:refresh`) has no such allowance and passes a higher
 * `endpointConcurrency`, which raises that peak with it.
 */
const ENDPOINT_FETCH_CONCURRENCY = 6;

/**
 * The deadline every gateway request carries. These are static metadata
 * documents, so ten seconds sits far above a healthy response and far below
 * what an hourly refresh is worth waiting out: with no deadline a connection
 * the gateway accepts and never answers holds the whole refresh open until the
 * platform kills the invocation, and the catalog goes another hour stale.
 */
const FETCH_TIMEOUT_MS = 10_000;

type FetchWhat =
  | 'models list'
  | 'ZDR list'
  | 'image models list'
  | 'image model endpoints'
  | 'video models list';

function fetchJson(
  options: FetchGatewayCatalogOptions,
  url: string,
  what: FetchWhat
): ResultAsync<unknown, DomainError> {
  const signal = AbortSignal.timeout(options.requestTimeoutMs ?? FETCH_TIMEOUT_MS);
  return fromPromise(options.fetch(url, { signal }), (cause) =>
    unavailableError(`${what} fetch failed`, cause)
  ).andThen((response) => {
    if (!response.ok) {
      return errAsync<unknown, DomainError>(
        unavailableError(`${what} returned HTTP ${String(response.status)}`)
      );
    }
    return fromPromise(response.json(), (cause) =>
      validationError(`${what} returned a non-JSON body`, cause)
    );
  });
}

function languageTokenPricingOf(
  pricing: z.infer<typeof modelsEntrySchema>['pricing']
): LanguageTokenPricing | undefined {
  if (pricing === undefined || pricing === null) return undefined;
  return {
    prompt: pricing.prompt,
    completion: pricing.completion,
    cacheRead: pricing.input_cache_read,
  };
}

/** Gateway snake_case reasoning → the shared camelCase shape. Null scalar
 * sub-fields collapse to absent; a null `supported_efforts` is kept (the
 * upstream all-accepted marker, distinct from absent). */
function reasoningOf(
  raw: z.infer<typeof modelsEntrySchema>['reasoning']
): ModelReasoning | undefined {
  if (raw === undefined || raw === null) return undefined;
  return {
    ...(raw.mandatory === undefined || raw.mandatory === null ? {} : { mandatory: raw.mandatory }),
    ...(raw.supported_efforts === undefined ? {} : { supportedEfforts: raw.supported_efforts }),
    ...(raw.default_effort === undefined || raw.default_effort === null
      ? {}
      : { defaultEffort: raw.default_effort }),
    ...(raw.default_enabled === undefined || raw.default_enabled === null
      ? {}
      : { defaultEnabled: raw.default_enabled }),
  };
}

/** Null (undocumented upstream semantics) and absent both collapse to
 * "no ceiling known" — consumers fall back to context length. */
function maxCompletionTokensOf(
  raw: z.infer<typeof modelsEntrySchema>['top_provider']
): number | undefined {
  return raw?.max_completion_tokens ?? undefined;
}

function languageMetadata(
  entry: z.infer<typeof modelsEntrySchema>,
  popularityRank: number
): LanguageMetadata {
  return {
    source: 'language',
    id: entry.id,
    provider: providerOfModelId(entry.id),
    name: entry.name,
    description: entry.description ?? undefined,
    inputModalities: entry.architecture?.input_modalities ?? [],
    outputModalities: entry.architecture?.output_modalities ?? [],
    supportedParameters: entry.supported_parameters ?? [],
    contextLength: entry.context_length ?? undefined,
    maxCompletionTokens: maxCompletionTokensOf(entry.top_provider),
    pricing: languageTokenPricingOf(entry.pricing),
    reasoning: reasoningOf(entry.reasoning),
    releasedAt: entry.created ?? undefined,
    deprecated: typeof entry.expiration_date === 'string' && entry.expiration_date.length > 0,
    popularityRank,
  };
}

function imageSupportedParameters(
  raw: z.infer<typeof imageSupportedParametersSchema>
): ImageSupportedParameters {
  return {
    resolution: raw?.resolution ?? [],
    aspectRatio: raw?.aspect_ratio ?? [],
    maxN: raw?.n,
  };
}

/** Render OpenRouter's numeric `cost_usd` (e.g. `3e-05`) as a plain decimal
 * string `usdRateToNanoUsd` can parse. The 12-decimal rendering is lossy at the
 * bottom — a non-zero rate at or below 5e-13 renders as `0.000000000000` — so
 * such a rate keeps its exponent form, which `usdRateToNanoUsd` refuses: it is
 * rejected as an unrepresentable rate rather than sold for nothing. A rate that
 * is genuinely zero still renders `0` and stays parseable, because charging
 * nothing is a commercial exclusion rather than a data defect. */
function decimalCostString(value: number | string): string {
  if (typeof value === 'string') return value;
  const plain = String(value);
  if (!plain.includes('e') && !plain.includes('E')) return plain;
  const fixed = value.toFixed(12);
  return Number(fixed) === 0 ? plain : fixed;
}

function imagePricingEntries(body: unknown): ImagePricingEntry[] {
  const parsed = imageEndpointsResponseSchema.parse(body);
  const rows = (parsed.endpoints ?? []).flatMap((endpoint) => endpoint.pricing ?? []);
  return rows.map((row) => ({
    billable: row.billable ?? undefined,
    unit: row.unit,
    costUsd: decimalCostString(row.cost_usd),
  }));
}

function videoMetadata(entry: z.infer<typeof videosEntrySchema>): VideoMetadata {
  return {
    source: 'video',
    id: entry.id,
    provider: providerOfModelId(entry.id),
    name: entry.name,
    description: entry.description ?? undefined,
    supportsFrameImages: (entry.supported_frame_images ?? []).length > 0,
    generateAudio: entry.generate_audio ?? false,
    seed: entry.seed ?? false,
    resolutions: entry.supported_resolutions ?? [],
    aspectRatios: entry.supported_aspect_ratios ?? [],
    durations: (entry.supported_durations ?? []).map(String),
    pricingSkus: entry.pricing_skus ?? {},
    releasedAt: entry.created ?? undefined,
  };
}

type ModelsEntry = z.infer<typeof modelsEntrySchema>;

/**
 * How many pages one list walk may fetch. The visited set below stops a
 * gateway that points back at a page already read; it cannot stop one that
 * keeps emitting fresh links, so the walk carries an absolute bound as well.
 * At the gateway's 500-entry page this is two orders of magnitude above the
 * live catalog.
 */
const MAX_LIST_PAGES = 50;

type NextPage =
  | { readonly kind: 'follow'; readonly url: string }
  | { readonly kind: 'complete' }
  | { readonly kind: 'cutoff'; readonly reason: ListWalkCutoff };

/** The only walk-ending answer with more than one cause: a `links` no link can
 * be read out of, a `next` that is not a followable absolute URL, and a `next`
 * naming a page already fetched all leave the operator reading one response
 * body to find out which. */
const UNFOLLOWABLE: NextPage = { kind: 'cutoff', reason: 'unfollowable-next-link' };

/**
 * Whether a page's `links` is a container a `next` can be read out of. An array
 * is not, deliberately: `'next' in value` would quietly answer "no more pages"
 * for a shape we do not understand, which is the silent short list this whole
 * walk exists to end.
 */
function isLinksObject(links: unknown): links is Record<string, unknown> {
  return typeof links === 'object' && links !== null && !Array.isArray(links);
}

/**
 * What the walk does with a page's `next` value: follow it, stop because the
 * list is over, or stop short and say why.
 *
 * Absent or null `next` is the documented last page — the list is over and
 * nothing was cut off. Absolute URLs only: resolving a relative link against
 * the current page would turn any unparseable string into a plausible URL on
 * our own origin and then fetch it. A link naming a page already fetched is
 * unfollowable in the same sense — following it repeats a page, and repeating
 * forever is the only way that ends.
 */
function nextPageFrom(next: unknown, fetched: ReadonlySet<string>): NextPage {
  if (next === undefined || next === null) return { kind: 'complete' };
  if (typeof next !== 'string' || !URL.canParse(next)) return UNFOLLOWABLE;
  if (fetched.size >= MAX_LIST_PAGES) return { kind: 'cutoff', reason: 'page-budget-spent' };
  const url = new URL(next).toString();
  return fetched.has(url) ? UNFOLLOWABLE : { kind: 'follow', url };
}

/**
 * What the walk does after this page, read from the page's whole `links` value.
 *
 * No outcome refuses the catalog refresh. Following the list is what keeps it
 * whole, but a gateway detail we did not anticipate is data we cannot
 * represent, and this catalog excludes what it cannot represent rather than
 * crashing on it — so an unreadable `links`, at any depth, ends the walk and
 * reports itself upward instead.
 */
function nextPage(links: unknown, fetched: ReadonlySet<string>): NextPage {
  if (links === undefined || links === null) return { kind: 'complete' };
  return isLinksObject(links) ? nextPageFrom(links['next'], fetched) : UNFOLLOWABLE;
}

/** One page of a gateway list: its entries, and the paging container the walk
 * reads the next page URL out of. */
interface ListPage<TEntry> {
  readonly entries: readonly TEntry[];
  readonly links: unknown;
}

/** What a walk over one list produced, and why it stopped short when it did. */
interface Walked<TResult> {
  readonly result: TResult;
  readonly cutoff?: ListWalkCutoff;
}

/** A pageable gateway list: what to call it in a fetch failure, and how to read
 * one of its pages. */
interface PagedList<TEntry> {
  readonly what: FetchWhat;
  readonly parsePage: (body: unknown) => Result<ListPage<TEntry>, DomainError>;
}

/** Where a walk is: the page to fetch, the pages already fetched, and what
 * they yielded. */
interface WalkPosition<TEntry> {
  readonly url: string;
  readonly fetched: ReadonlySet<string>;
  readonly collected: readonly TEntry[];
}

/** The page reader every list shares: entries out of `data`, paging out of
 * `links`, and a schema-drift error naming the list. Structural in the schema so
 * each list keeps its own entry type. */
function pageParser<TEntry>(
  schema: {
    safeParse: (body: unknown) => z.ZodSafeParseResult<{ data: TEntry[]; links?: unknown }>;
  },
  driftMessage: string
): (body: unknown) => Result<ListPage<TEntry>, DomainError> {
  return (body) => {
    const parsed = schema.safeParse(body);
    return parsed.success
      ? ok<ListPage<TEntry>, DomainError>({ entries: parsed.data.data, links: parsed.data.links })
      : err<ListPage<TEntry>, DomainError>(validationError(driftMessage, parsed.error));
  };
}

const MODELS_LIST: PagedList<ModelsEntry> = {
  what: 'models list',
  parsePage: pageParser(modelsResponseSchema, 'models list schema drift'),
};

const ZDR_LIST: PagedList<z.infer<typeof zdrResponseSchema>['data'][number]> = {
  what: 'ZDR list',
  parsePage: pageParser(zdrResponseSchema, 'ZDR list schema drift'),
};

const IMAGES_LIST: PagedList<z.infer<typeof imagesEntrySchema>> = {
  what: 'image models list',
  parsePage: pageParser(imagesResponseSchema, 'image models list schema drift'),
};

const VIDEOS_LIST: PagedList<z.infer<typeof videosEntrySchema>> = {
  what: 'video models list',
  parsePage: pageParser(videosResponseSchema, 'video models list schema drift'),
};

/**
 * Walks one list from a page URL to the end of it, accumulating entries in
 * gateway order. Following `links.next` is not optional for any of the four:
 * every list is paged, and a walk that stops at the first page silently drops
 * every entry past the cut. What that costs differs per list — a short
 * `/models` also derives popularity rank from a truncated ordering, and a short
 * ZDR list hides models fail-closed — but no list can afford it.
 */
function fetchListPages<TEntry>(
  options: FetchGatewayCatalogOptions,
  list: PagedList<TEntry>,
  from: WalkPosition<TEntry>
): ResultAsync<Walked<readonly TEntry[]>, DomainError> {
  return fetchJson(options, from.url, list.what).andThen((body) =>
    list.parsePage(body).asyncAndThen((page) => {
      const entries = [...from.collected, ...page.entries];
      const step = nextPage(page.links, from.fetched);
      if (step.kind === 'complete') {
        return okAsync<Walked<readonly TEntry[]>, DomainError>({ result: entries });
      }
      if (step.kind === 'cutoff') {
        return okAsync<Walked<readonly TEntry[]>, DomainError>({
          result: entries,
          cutoff: step.reason,
        });
      }
      return fetchListPages(options, list, {
        url: step.url,
        fetched: new Set([...from.fetched, step.url]),
        collected: entries,
      });
    })
  );
}

/** Walks a list from its first page, which counts against the visited set so a
 * `next` pointing back at it ends the walk. */
function walkList<TEntry>(
  options: FetchGatewayCatalogOptions,
  list: PagedList<TEntry>,
  firstUrl: string
): ResultAsync<Walked<readonly TEntry[]>, DomainError> {
  return fetchListPages(options, list, {
    url: firstUrl,
    fetched: new Set([firstUrl]),
    collected: [],
  });
}

/** Carries a walk's cutoff onto the catalog under the field naming that list;
 * absent when the walk reached the end of the list. */
function cutoffField<TName extends string>(
  name: TName,
  cutoff: ListWalkCutoff | undefined
): Partial<Record<TName, ListWalkCutoff>> {
  return cutoff === undefined ? {} : ({ [name]: cutoff } as Record<TName, ListWalkCutoff>);
}

function fetchLanguageModels(
  options: FetchGatewayCatalogOptions
): ResultAsync<Walked<readonly LanguageMetadata[]>, DomainError> {
  return walkList(options, MODELS_LIST, `${options.baseUrl}/models?sort=top-weekly`).map(
    (walk) => ({
      // The gateway returns entries already ordered by top-weekly usage across
      // the whole paged list, so the accumulated index IS the popularity rank
      // (0-based, lower = more used).
      result: walk.result.map((entry, index) => languageMetadata(entry, index)),
      ...(walk.cutoff === undefined ? {} : { cutoff: walk.cutoff }),
    })
  );
}

function fetchZdrModelIds(
  options: FetchGatewayCatalogOptions
): ResultAsync<Walked<ReadonlySet<string>>, DomainError> {
  return walkList(options, ZDR_LIST, `${options.baseUrl}/endpoints/zdr`).map((walk) => ({
    result: new Set(walk.result.map((row) => row.model_id)),
    ...(walk.cutoff === undefined ? {} : { cutoff: walk.cutoff }),
  }));
}

function fetchImageModel(
  options: FetchGatewayCatalogOptions,
  entry: z.infer<typeof imagesEntrySchema>
): ResultAsync<ImageMetadata, DomainError> {
  const url = `${options.baseUrl}/images/models/${entry.id}/endpoints`;
  return fetchJson(options, url, 'image model endpoints').andThen((body) => {
    try {
      return okAsync<ImageMetadata, DomainError>({
        source: 'image',
        id: entry.id,
        provider: providerOfModelId(entry.id),
        name: entry.name,
        description: entry.description ?? undefined,
        inputModalities: entry.architecture?.input_modalities ?? ['text'],
        supportedParameters: imageSupportedParameters(entry.supported_parameters),
        endpointPricing: imagePricingEntries(body),
        releasedAt: entry.created ?? undefined,
      });
    } catch (error) {
      return err<ImageMetadata, DomainError>(
        validationError('image model endpoints schema drift', error)
      );
    }
  });
}

/** What one image model's endpoint detail came to: the metadata, or the
 * exclusion standing in for a model whose detail could not be read. */
type ImageDetail =
  | { readonly kind: 'cataloged'; readonly model: ImageMetadata }
  | { readonly kind: 'excluded'; readonly exclusion: ModelExclusion };

/**
 * One image model's endpoint detail, settled either way. A failure here is one
 * model's, so it excludes that model rather than the fetch it belongs to: the
 * per-model request is the only place in a refresh where a single entry can
 * fail alone, and collapsing the batch on it would let one unreadable endpoint
 * document cost an hourly refresh its whole catalog.
 */
function fetchImageDetail(
  options: FetchGatewayCatalogOptions,
  entry: z.infer<typeof imagesEntrySchema>
): ResultAsync<ImageDetail, DomainError> {
  return fetchImageModel(options, entry)
    .map((model): ImageDetail => ({ kind: 'cataloged', model }))
    .orElse((error) =>
      ok<ImageDetail, DomainError>({
        kind: 'excluded',
        exclusion: { id: entry.id, reason: error.code },
      })
    );
}

/** The N+1 endpoint detail for every image model the walk found, in chunks of
 * {@link ENDPOINT_FETCH_CONCURRENCY}. Unchanged by paging: it fans out over the
 * accumulated list rather than over one page. */
function fetchImageDetails(
  options: FetchGatewayCatalogOptions,
  entries: readonly z.infer<typeof imagesEntrySchema>[]
): ResultAsync<ImageDetail[], DomainError> {
  const concurrency = options.endpointConcurrency ?? ENDPOINT_FETCH_CONCURRENCY;
  const chunks: (typeof entries)[number][][] = [];
  for (let index = 0; index < entries.length; index += concurrency) {
    chunks.push(entries.slice(index, index + concurrency));
  }
  let chain: ResultAsync<ImageDetail[], DomainError> = okAsync([]);
  for (const chunk of chunks) {
    chain = chain.andThen((collected) =>
      ResultAsync.combine(chunk.map((entry) => fetchImageDetail(options, entry))).map((batch) => [
        ...collected,
        ...batch,
      ])
    );
  }
  return chain;
}

/** An image list walk plus the models it listed that could not be cataloged. */
interface ImageWalk extends Walked<readonly ImageMetadata[]> {
  readonly excluded: readonly ModelExclusion[];
}

function fetchImageModels(
  options: FetchGatewayCatalogOptions
): ResultAsync<ImageWalk, DomainError> {
  return walkList(options, IMAGES_LIST, `${options.baseUrl}/images/models`).andThen((walk) =>
    fetchImageDetails(options, walk.result).map((details) => ({
      result: details.flatMap((detail) => (detail.kind === 'cataloged' ? [detail.model] : [])),
      excluded: details.flatMap((detail) => (detail.kind === 'excluded' ? [detail.exclusion] : [])),
      ...(walk.cutoff === undefined ? {} : { cutoff: walk.cutoff }),
    }))
  );
}

function fetchVideoModels(
  options: FetchGatewayCatalogOptions
): ResultAsync<Walked<readonly VideoMetadata[]>, DomainError> {
  return walkList(options, VIDEOS_LIST, `${options.baseUrl}/videos/models`).map((walk) => ({
    result: walk.result.map((entry) => videoMetadata(entry)),
    ...(walk.cutoff === undefined ? {} : { cutoff: walk.cutoff }),
  }));
}

export function fetchGatewayCatalog(
  options: FetchGatewayCatalogOptions
): ResultAsync<GatewayCatalog, DomainError> {
  return ResultAsync.combine([
    fetchLanguageModels(options),
    fetchImageModels(options),
    fetchVideoModels(options),
    fetchZdrModelIds(options),
  ]).map(([language, image, video, zdr]) => ({
    models: [...language.result, ...image.result, ...video.result],
    excludedModels: image.excluded,
    zdrModelIds: zdr.result,
    // Four independent walks, four independent cutoffs: one field cannot say
    // which list was cut, and which list it is decides what the truncation
    // costs.
    ...cutoffField('modelsWalkCutoff', language.cutoff),
    ...cutoffField('zdrWalkCutoff', zdr.cutoff),
    ...cutoffField('imageModelsWalkCutoff', image.cutoff),
    ...cutoffField('videoModelsWalkCutoff', video.cutoff),
  }));
}
