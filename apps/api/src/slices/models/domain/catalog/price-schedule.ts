import { DECIMAL_USD_PATTERN } from '@hushbox/shared';
import { usdRateToNanoUsd } from '../pricing/usd-rate.js';
import type { ExcludeReason } from '@hushbox/shared';
import type {
  EndpointPricing,
  GatewayModelMetadata,
  LanguageTokenPricing,
  RawOverride,
  ZdrEndpoint,
} from './gateway-metadata.js';

/**
 * A text model's anchor schedule, read off its ZDR endpoints in the vendor's
 * exact decimal USD. Pure selection over listed prices: every schedule rate
 * this module returns is one the listing states, untouched, so the one round-up that makes
 * it billable stays at the ingestion fee seam in `normalize.ts`.
 *
 * Every standard-tier ZDR endpoint is price-checked, because a call that
 * omits a parameter can be routed to an endpoint that does not support it. An
 * endpoint is eligible — to anchor, and to count toward the output cap and the
 * context — when it accepts every parameter HushBox may send the model and
 * states readable limits. The anchor is the eligible endpoint with the lowest
 * base prompt + completion among those whose maximum completion covers the
 * output cap, and an unbounded cap is covered only by an endpoint stating no
 * maximum; its rates, long-context tiers and time-window fold form the
 * schedule, and prompt sizes past its context take the cheapest eligible
 * endpoint whose context covers them.
 */

/**
 * The price keys the schedule reads. Prompt and completion form it; a cached
 * read, a 5-minute cache write, reasoning and a request fee are each checked
 * against it or the ceiling. `input_cache_write_1h` is accepted unbounded,
 * because HushBox sends no `cache_control` and so never triggers that write.
 */
const REPRESENTED_PRICE_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'completion',
  'input_cache_read',
  'input_cache_write',
  'input_cache_write_1h',
  'internal_reasoning',
  'request',
]);

/** Prices a text call never triggers: no tool HushBox sends is the vendor's
 * search, the listed price already has `discount` applied, and no text call
 * carries or asks for audio or images. */
const IGNORED_PRICE_KEYS: ReadonlySet<string> = new Set([
  'web_search',
  'discount',
  'image',
  'audio',
  'input_audio_cache',
  'image_output',
  'image_token',
]);

const CONDITION_KEYS: ReadonlySet<string> = new Set([
  'min_prompt_tokens',
  'utc_start',
  'utc_end',
  'utc_days',
]);

/** The keys an override may carry besides the represented rates. */
const OVERRIDE_NON_RATE_KEYS: ReadonlySet<string> = new Set([
  ...CONDITION_KEYS,
  ...IGNORED_PRICE_KEYS,
]);

/** Service-tier variants a request reaches only by asking for them, which HushBox never does. */
const SERVICE_TIER_VARIANTS: ReadonlySet<string> = new Set(['flex', 'priority', 'fast']);

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const WEEKDAY_NAMES: ReadonlySet<unknown> = new Set(WEEKDAYS);

const MINUTES_PER_DAY = 24 * 60;

/**
 * Where each of a model's ZDR endpoints lands; every endpoint lands in exactly
 * one. `unsupported-parameter` is a priced, checked endpoint lacking a
 * parameter HushBox may send; `reachable` accepts them all. Either can serve a
 * call, and only a `reachable` one with readable limits can anchor.
 */
export const ENDPOINT_BUCKETS = [
  'service-tier',
  'unsupported-parameter',
  'unreadable',
  'unrepresentable',
  'reachable',
] as const;

export type EndpointBucket = (typeof ENDPOINT_BUCKETS)[number];

/** Rates applying to a whole request whose prompt tokens exceed the threshold. */
export interface DecimalTier {
  readonly abovePromptTokens: number;
  readonly rates: LanguageTokenPricing;
}

export interface DecimalSchedule {
  readonly base: LanguageTokenPricing;
  readonly tiers: readonly DecimalTier[];
}

/**
 * The model's own limits and the parameters HushBox may send it. An eligible
 * endpoint must accept every parameter; only the anchor must cover the output
 * cap.
 */
export interface CatalogLimits {
  readonly maxOutputTokens: number | undefined;
  readonly contextLength: number | undefined;
  readonly supportedParameters: readonly string[];
}

export type AnchorSchedule =
  | { readonly kind: 'excluded'; readonly reason: ExcludeReason }
  | {
      readonly kind: 'scheduled';
      readonly schedule: DecimalSchedule;
      /** The largest prompt the anchor endpoint itself serves: where the schedule carries its own dearest rate. */
      readonly anchorReach: number;
      /** Every standard-tier endpoint's base rates, time windows folded: the pool a call can be routed to. */
      readonly standardBases: readonly LanguageTokenPricing[];
      readonly maxOutputTokens: number | undefined;
      readonly contextLength: number | undefined;
    };

// --- exact decimals ----------------------------------------------------------

export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

function decimalOf(text: string): Decimal {
  const [whole = '', fraction = ''] = text.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

function scaledTo(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

export function compareDecimal(a: string, b: string): number {
  const left = decimalOf(a);
  const right = decimalOf(b);
  const scale = Math.max(left.scale, right.scale);
  const difference = scaledTo(left, scale) - scaledTo(right, scale);
  if (difference === 0n) return 0;
  return difference < 0n ? -1 : 1;
}

export function sumDecimal(a: string, b: string): Decimal {
  const left = decimalOf(a);
  const right = decimalOf(b);
  const scale = Math.max(left.scale, right.scale);
  return { units: scaledTo(left, scale) + scaledTo(right, scale), scale };
}

export function compareSums(a: LanguageTokenPricing, b: LanguageTokenPricing): number {
  const left = sumDecimal(a.prompt, a.completion);
  const right = sumDecimal(b.prompt, b.completion);
  const scale = Math.max(left.scale, right.scale);
  const difference = scaledTo(left, scale) - scaledTo(right, scale);
  if (difference === 0n) return 0;
  return difference < 0n ? -1 : 1;
}

function maxDecimal(a: string, b: string): string {
  return compareDecimal(a, b) >= 0 ? a : b;
}

function isZeroDecimal(text: string): boolean {
  return decimalOf(text).units === 0n;
}

/** The least whole count of 10⁻¹² USD at or above a decimal USD rate. */
function picoUsdCeilOf(rate: string): bigint {
  const value = decimalOf(rate);
  if (value.scale <= 12) return value.units * 10n ** BigInt(12 - value.scale);
  const divisor = 10n ** BigInt(value.scale - 12);
  return (value.units + divisor - 1n) / divisor;
}

function maxRates(a: LanguageTokenPricing, b: LanguageTokenPricing): LanguageTokenPricing {
  return {
    prompt: maxDecimal(a.prompt, b.prompt),
    completion: maxDecimal(a.completion, b.completion),
  };
}

function sameRates(a: LanguageTokenPricing, b: LanguageTokenPricing): boolean {
  return (
    compareDecimal(a.prompt, b.prompt) === 0 && compareDecimal(a.completion, b.completion) === 0
  );
}

// --- one endpoint's price ----------------------------------------------------

/** One price entry with every key resolved: the top level, or an override over it. */
type PriceEntry = Readonly<Record<string, string>> & LanguageTokenPricing;

interface EndpointSchedule {
  readonly schedule: DecimalSchedule;
  /** Every listed entry with absent keys inherited from the top level. */
  readonly entries: readonly PriceEntry[];
}

type PriceReading =
  | { readonly kind: 'read'; readonly price: EndpointSchedule }
  | { readonly kind: 'unrepresentable' };

const UNREPRESENTABLE: PriceReading = { kind: 'unrepresentable' };

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_USD_PATTERN.test(value);
}

/** The represented rates of a top-level price or an override, or undefined when one is not a decimal. */
function representedRates(
  source: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>
): Record<string, string> | undefined {
  const rates: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (REPRESENTED_PRICE_KEYS.has(key)) {
      if (!isDecimal(value)) return undefined;
      rates[key] = value;
    } else if (!allowed.has(key)) {
      return undefined;
    }
  }
  return rates;
}

/**
 * A price the token schedule cannot bound: a request fee, reasoning dearer than
 * completion, or a cached read dearer than the prompt it stands in for. Each is
 * a charge the hold, which prices every token at the prompt or completion rate,
 * would not cover.
 */
function exceedsTheSchedule(entry: PriceEntry): boolean {
  const { prompt, completion } = entry;
  const request = entry['request'];
  const reasoning = entry['internal_reasoning'];
  const cacheRead = entry['input_cache_read'];
  return (
    (request !== undefined && !isZeroDecimal(request)) ||
    (reasoning !== undefined && compareDecimal(reasoning, completion) > 0) ||
    (cacheRead !== undefined && compareDecimal(cacheRead, prompt) > 0)
  );
}

interface Window {
  readonly days: readonly string[];
  /** Covered minutes of the UTC day, as half-open [start, end) spans. */
  readonly spans: readonly (readonly [number, number])[];
}

const WHOLE_WEEK: Window = { days: WEEKDAYS, spans: [[0, MINUTES_PER_DAY]] };

function minutesOfClock(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  const hours = Math.trunc(value / 100);
  const minutes = value % 100;
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/**
 * The days and minutes an override's time conditions cover, read wrap-aware as
 * the vendor defines them (`t >= start || t < end` when the end is not after
 * the start). Undefined when a condition cannot be read.
 */
function windowOf(override: RawOverride): Window | undefined {
  const days = override['utc_days'] ?? [...WEEKDAYS];
  if (!Array.isArray(days) || !days.every((day: unknown) => WEEKDAY_NAMES.has(day))) {
    return undefined;
  }
  const hasStart = override['utc_start'] !== undefined;
  const hasEnd = override['utc_end'] !== undefined;
  if (!hasStart && !hasEnd) return { ...WHOLE_WEEK, days };
  const start = minutesOfClock(override['utc_start']);
  const end = minutesOfClock(override['utc_end']);
  if (start === undefined || end === undefined) return undefined;
  const spans: (readonly [number, number])[] =
    end > start
      ? [[start, end]]
      : [
          [start, MINUTES_PER_DAY],
          [0, end],
        ];
  return { days, spans };
}

/** Whether a set of windows covers every minute of every weekday. */
function tilesEveryWeekday(windows: readonly Window[]): boolean {
  return WEEKDAYS.every((day) => {
    const spans = windows
      .filter((window) => window.days.includes(day))
      .flatMap((window) => window.spans)
      .toSorted((a, b) => a[0] - b[0]);
    let covered = 0;
    for (const [start, end] of spans) {
      if (start > covered) return false;
      covered = Math.max(covered, end);
    }
    return covered >= MINUTES_PER_DAY;
  });
}

function thresholdOf(override: RawOverride): number | undefined | 'unreadable' {
  const threshold = override['min_prompt_tokens'];
  if (threshold === undefined) return undefined;
  return typeof threshold === 'number' && Number.isInteger(threshold) && threshold > 0
    ? threshold
    : 'unreadable';
}

interface ReadOverride {
  readonly threshold: number | undefined;
  readonly window: Window | undefined;
  readonly entry: PriceEntry;
}

function readOverride(override: RawOverride, top: PriceEntry): ReadOverride | undefined {
  const threshold = thresholdOf(override);
  const rates = representedRates(override, OVERRIDE_NON_RATE_KEYS);
  if (threshold === 'unreadable' || rates === undefined) return undefined;
  const timed =
    override['utc_start'] !== undefined ||
    override['utc_end'] !== undefined ||
    override['utc_days'] !== undefined;
  const window = timed ? windowOf(override) : undefined;
  if (timed && window === undefined) return undefined;
  return { threshold, window, entry: { ...top, ...rates } };
}

function tokenRatesOf(entry: PriceEntry): LanguageTokenPricing {
  return { prompt: entry.prompt, completion: entry.completion };
}

/**
 * Time windows fold by per-rate maximum, but only when the windows at one
 * threshold cover every weekday: the top level is whichever window applies
 * when the listing is read, so a rate outside every listed window is unseen.
 */
function windowsTile(overrides: readonly ReadOverride[]): boolean {
  const thresholds = new Set(overrides.map((override) => override.threshold));
  return [...thresholds].every((threshold) => {
    const atThreshold = overrides.filter((override) => override.threshold === threshold);
    if (atThreshold.every((override) => override.window === undefined)) return true;
    const windows = atThreshold.map((override) => override.window ?? WHOLE_WEEK);
    return tilesEveryWeekday(windows);
  });
}

/**
 * The endpoint's schedule: base is the top level folded with every
 * threshold-free entry; each threshold becomes a tier carrying the cumulative
 * maximum of base and every entry at or below it. A cumulative maximum bounds
 * the price whichever order the vendor's "later entries win" applies in, and it
 * never falls as tiers rise.
 */
function readEndpointPrice(endpoint: ZdrEndpoint): PriceReading {
  const top = endpoint.pricing === 'unreadable' ? undefined : topEntryOf(endpoint.pricing);
  const overrides = top === undefined ? undefined : readOverrides(endpoint.overrides, top);
  if (top === undefined || overrides === undefined || !windowsTile(overrides)) {
    return UNREPRESENTABLE;
  }
  const entries = [top, ...overrides.map((override) => override.entry)];
  if (entries.some((entry) => exceedsTheSchedule(entry))) return UNREPRESENTABLE;
  return { kind: 'read', price: { schedule: foldedSchedule(top, overrides), entries } };
}

/** The top-level price, or undefined when it lists no prompt or completion rate or an unknown key. */
function topEntryOf(pricing: EndpointPricing): PriceEntry | undefined {
  const rates = representedRates(pricing, IGNORED_PRICE_KEYS);
  const prompt = rates?.['prompt'];
  const completion = rates?.['completion'];
  return prompt === undefined || completion === undefined
    ? undefined
    : { ...rates, prompt, completion };
}

function readOverrides(
  overrides: readonly RawOverride[],
  top: PriceEntry
): ReadOverride[] | undefined {
  const read: ReadOverride[] = [];
  for (const override of overrides) {
    const entry = readOverride(override, top);
    if (entry === undefined) return undefined;
    read.push(entry);
  }
  return read;
}

function foldedSchedule(top: PriceEntry, overrides: readonly ReadOverride[]): DecimalSchedule {
  let base = tokenRatesOf(top);
  for (const override of overrides) {
    if (override.threshold === undefined) base = maxRates(base, tokenRatesOf(override.entry));
  }
  const thresholds = [
    ...new Set(overrides.flatMap((override) => override.threshold ?? [])),
  ].toSorted((a, b) => a - b);
  let below = base;
  const tiers = thresholds.map((threshold) => {
    for (const override of overrides) {
      if (override.threshold !== undefined && override.threshold <= threshold) {
        below = maxRates(below, tokenRatesOf(override.entry));
      }
    }
    return { abovePromptTokens: threshold, rates: below };
  });
  return { base, tiers };
}

// --- reachability ------------------------------------------------------------

function isServiceTier(tag: string): boolean {
  const slash = tag.indexOf('/');
  if (slash === -1) return false;
  return tag
    .slice(slash + 1)
    .split(/[/-]/)
    .some((token) => SERVICE_TIER_VARIANTS.has(token));
}

/** Whether an endpoint accepts a cap on its output; one that does not ignores the cap a call sends. */
function acceptsOutputCap(parameters: readonly string[]): boolean {
  return parameters.includes('max_tokens') || parameters.includes('max_completion_tokens');
}

/** Whether an endpoint accepts each of `tools` and `reasoning` the model may be sent. */
function acceptsModelParameters(
  parameters: readonly string[],
  modelParameters: readonly string[]
): boolean {
  return (
    (!modelParameters.includes('tools') || parameters.includes('tools')) &&
    (!modelParameters.includes('reasoning') || parameters.includes('reasoning'))
  );
}

interface ClassifiedEndpoint {
  readonly endpoint: ZdrEndpoint;
  readonly bucket: EndpointBucket;
  readonly price?: EndpointSchedule;
}

/**
 * An endpoint with no readable price or parameter list, or one that accepts no
 * output cap and so bills an output nothing bounds, is a price the schedule
 * cannot represent.
 */
function classify(endpoint: ZdrEndpoint, modelParameters: readonly string[]): ClassifiedEndpoint {
  if (isServiceTier(endpoint.tag)) return { endpoint, bucket: 'service-tier' };
  const parameters = endpoint.supportedParameters;
  if (endpoint.pricing === 'unreadable' || parameters === 'unreadable') {
    return { endpoint, bucket: 'unreadable' };
  }
  const reading = readEndpointPrice(endpoint);
  if (reading.kind !== 'read' || !acceptsOutputCap(parameters)) {
    return { endpoint, bucket: 'unrepresentable' };
  }
  return acceptsModelParameters(parameters, modelParameters)
    ? { endpoint, bucket: 'reachable', price: reading.price }
    : { endpoint, bucket: 'unsupported-parameter', price: reading.price };
}

/** A count of 0 in every bucket. */
export function emptyEndpointBuckets(): Record<EndpointBucket, number> {
  return {
    'service-tier': 0,
    'unsupported-parameter': 0,
    unreadable: 0,
    unrepresentable: 0,
    reachable: 0,
  };
}

/** How many of a model's ZDR endpoints land in each bucket. */
export function endpointBucketCounts(
  endpoints: readonly ZdrEndpoint[],
  modelParameters: readonly string[]
): Record<EndpointBucket, number> {
  const counts = emptyEndpointBuckets();
  for (const endpoint of endpoints) counts[classify(endpoint, modelParameters).bucket] += 1;
  return counts;
}

// --- the anchor --------------------------------------------------------------

/** An endpoint that may anchor, with its limits read. */
interface Eligible {
  readonly endpoint: ZdrEndpoint;
  readonly price: EndpointSchedule;
  readonly maxCompletionTokens: number | undefined;
  readonly contextLength: number | undefined;
}

/**
 * A gateway limit, or unstated when it is not a whole positive count within
 * the safe-integer range: such a row is excluded by the normalizer's own
 * token-limit gate, which runs after pricing so that a row hidden for another
 * reason keeps that reason. An unsafe count read as stated would reach the
 * tier resolver, which refuses it by throwing.
 */
function statedLimit(limit: number | undefined): number | undefined {
  return limit !== undefined && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/** The smaller of two limits, either of which may be unstated (unbounded). */
function smallerLimit(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** The largest of the endpoints' limits, unbounded when any states none. */
function largestLimit(limits: readonly (number | undefined)[]): number | undefined {
  let largest = 0;
  for (const limit of limits) {
    if (limit === undefined) return undefined;
    largest = Math.max(largest, limit);
  }
  return largest;
}

/** Cheapest first: base prompt + completion, then completion, then prompt, then tag, then provider name. */
function cheaperFirst(a: Eligible, b: Eligible): number {
  const left = a.price.schedule.base;
  const right = b.price.schedule.base;
  return (
    compareSums(left, right) ||
    compareDecimal(left.completion, right.completion) ||
    compareDecimal(left.prompt, right.prompt) ||
    a.endpoint.tag.localeCompare(b.endpoint.tag) ||
    a.endpoint.providerName.localeCompare(b.endpoint.providerName)
  );
}

function cheapest(candidates: readonly Eligible[]): Eligible | undefined {
  return candidates.toSorted(cheaperFirst)[0];
}

function rateAt(schedule: DecimalSchedule, promptTokens: number): LanguageTokenPricing {
  let rates = schedule.base;
  for (const tier of schedule.tiers) {
    if (promptTokens > tier.abovePromptTokens) rates = tier.rates;
  }
  return rates;
}

/** A 5-minute cache write dearer than five quarters of the prompt rate it is written at: the ceiling would not cover it. */
function cacheWriteAboveCeiling(price: EndpointSchedule): boolean {
  return price.entries.some((entry) => {
    const write = entry['input_cache_write'];
    if (write === undefined) return false;
    const writeValue = decimalOf(write);
    const promptValue = decimalOf(entry.prompt);
    const scale = Math.max(writeValue.scale, promptValue.scale);
    return 4n * scaledTo(writeValue, scale) > 5n * scaledTo(promptValue, scale);
  });
}

interface Segment {
  /** Prompts strictly above this many tokens are served here, up to the next segment. */
  readonly above: number;
  readonly schedule: DecimalSchedule;
}

/**
 * Prompt sizes past the anchor's context are served by the cheapest eligible
 * endpoint whose context covers them: one segment per distinct larger context
 * below the model's.
 */
function contextSegments(
  anchor: Eligible,
  eligible: readonly Eligible[],
  contextLength: number | undefined
): Segment[] {
  const anchorContext = anchor.contextLength;
  if (anchorContext === undefined) return [];
  const boundaries = [
    anchorContext,
    ...eligible.flatMap((candidate) => {
      const context = candidate.contextLength;
      return context !== undefined && context > anchorContext ? [context] : [];
    }),
  ];
  const segments: Segment[] = [];
  for (const above of [...new Set(boundaries)].toSorted((a, b) => a - b)) {
    if (contextLength !== undefined && above >= contextLength) break;
    const covering = cheapest(
      eligible.filter(
        (candidate) => candidate.contextLength === undefined || candidate.contextLength > above
      )
    );
    if (covering === undefined) break;
    segments.push({ above, schedule: covering.price.schedule });
  }
  return segments;
}

/**
 * The model's schedule: the anchor's rates up to its context and each
 * segment's above it, at every threshold any of them changes price, as a
 * cumulative maximum. A tier no prompt can reach — at or above the model's
 * context — is dropped, and so is one that changes no rate.
 */
function mergedSchedule(
  anchor: Eligible,
  segments: readonly Segment[],
  contextLength: number | undefined
): DecimalSchedule {
  const anchorSchedule = anchor.price.schedule;
  const servedBy = (promptTokens: number): DecimalSchedule => {
    let schedule = anchorSchedule;
    for (const segment of segments) {
      if (promptTokens > segment.above) schedule = segment.schedule;
    }
    return schedule;
  };
  const limit = segments[0]?.above;
  const thresholds = new Set<number>([
    ...anchorSchedule.tiers
      .map((tier) => tier.abovePromptTokens)
      .filter((threshold) => limit === undefined || threshold < limit),
    ...segments.flatMap((segment, index) => {
      const next = segments[index + 1]?.above;
      return [
        segment.above,
        ...segment.schedule.tiers
          .map((tier) => tier.abovePromptTokens)
          .filter(
            (threshold) => threshold > segment.above && (next === undefined || threshold < next)
          ),
      ];
    }),
  ]);
  const base = anchorSchedule.base;
  let below = base;
  const tiers: DecimalTier[] = [];
  for (const threshold of [...thresholds].toSorted((a, b) => a - b)) {
    if (contextLength !== undefined && threshold >= contextLength) break;
    const rates = maxRates(below, rateAt(servedBy(threshold + 1), threshold + 1));
    if (!sameRates(rates, below)) tiers.push({ abovePromptTokens: threshold, rates });
    below = rates;
  }
  return { base, tiers };
}

const UNREPRESENTABLE_PRICE: AnchorSchedule = {
  kind: 'excluded',
  reason: 'unrepresentable-endpoint-price',
};

/** An eligible endpoint with its limits read, or nothing when it is not eligible. */
function eligibleOf(entry: ClassifiedEndpoint): Eligible[] {
  const { maxCompletionTokens, contextLength } = entry.endpoint;
  if (entry.bucket !== 'reachable' || entry.price === undefined) return [];
  if (maxCompletionTokens === 'unreadable' || contextLength === 'unreadable') return [];
  return [{ endpoint: entry.endpoint, price: entry.price, maxCompletionTokens, contextLength }];
}

/** The context a model is sold with: the smaller of the gateway's and the largest eligible endpoint's. */
function soldContextOf(
  catalogContext: number | undefined,
  eligible: readonly Eligible[]
): number | undefined {
  return smallerLimit(
    statedLimit(catalogContext),
    largestLimit(eligible.map((entry) => entry.contextLength))
  );
}

/**
 * The pool the catalog's context exemption is measured over: every language
 * model with an eligible standard-tier endpoint in the ZDR listing, whatever
 * its final disposition, each at the context it would be sold with. Media
 * entries are left out because a per-unit-priced model carries no token
 * context, and a model without an eligible endpoint because
 * {@link anchorScheduleOf} never schedules it; either would move a text
 * model's exemption for a reason unrelated to text capability. A model whose
 * sold context is unbounded is left out too: it is an unstated window, not a
 * zero-token one, and counting it as zero drags the percentile down and
 * exempts models from the price floor that have not earned it.
 */
export function soldLanguageContexts(
  models: readonly GatewayModelMetadata[],
  zdr: ReadonlyMap<string, readonly ZdrEndpoint[]>
): number[] {
  return models.flatMap((model) => {
    if (model.source !== 'language') return [];
    const eligible = (zdr.get(model.id) ?? []).flatMap((endpoint) =>
      eligibleOf(classify(endpoint, model.supportedParameters))
    );
    if (eligible.length === 0) return [];
    const context = soldContextOf(model.contextLength, eligible);
    return context === undefined ? [] : [context];
  });
}

/**
 * A text model's anchor schedule from its ZDR endpoints.
 * `unrepresentable-endpoint-price` when any standard-tier endpoint lists a
 * price the schedule cannot bound, because a call can still be routed to it;
 * `non-zdr` when no endpoint is eligible to anchor.
 */
export function anchorScheduleOf(
  endpoints: readonly ZdrEndpoint[],
  catalog: CatalogLimits
): AnchorSchedule {
  const standard = endpoints
    .map((endpoint) => classify(endpoint, catalog.supportedParameters))
    .filter((entry) => entry.bucket !== 'service-tier');
  if (standard.some((entry) => entry.price === undefined)) return UNREPRESENTABLE_PRICE;
  const eligible = standard.flatMap((entry) => eligibleOf(entry));
  if (eligible.length === 0) return { kind: 'excluded', reason: 'non-zdr' };
  const maxOutputTokens = smallerLimit(
    statedLimit(catalog.maxOutputTokens),
    largestLimit(eligible.map((entry) => entry.maxCompletionTokens))
  );
  const contextLength = soldContextOf(catalog.contextLength, eligible);
  const anchor = cheapest(
    eligible.filter(
      (entry) =>
        entry.maxCompletionTokens === undefined ||
        (maxOutputTokens !== undefined && entry.maxCompletionTokens >= maxOutputTokens)
    )
  );
  if (anchor === undefined) {
    throw new Error('anchorScheduleOf: the largest-cap eligible endpoint always covers the cap');
  }
  if (cacheWriteAboveCeiling(anchor.price)) return UNREPRESENTABLE_PRICE;
  const segments = contextSegments(anchor, eligible, contextLength);
  return {
    kind: 'scheduled',
    schedule: mergedSchedule(anchor, segments, contextLength),
    anchorReach: smallerLimit(anchor.contextLength, contextLength) ?? Number.MAX_SAFE_INTEGER,
    standardBases: standard.flatMap((entry) =>
      entry.price === undefined ? [] : [entry.price.schedule.base]
    ),
    maxOutputTokens,
    contextLength,
  };
}

// --- what ingestion reads off the schedule -----------------------------------

/** A pre-fee nano figure read from a schedule decimal, for the commercial floor. */
function providerNano(rate: string): bigint {
  const nano = usdRateToNanoUsd(rate);
  if (nano === undefined) throw new Error('providerNano: the schedule carries only decimal rates');
  return BigInt(nano);
}

/** The schedule's base rates before the fee, in nano-USD. */
export function providerBaseOf(schedule: DecimalSchedule): {
  readonly input: bigint;
  readonly output: bigint;
} {
  return {
    input: providerNano(schedule.base.prompt),
    output: providerNano(schedule.base.completion),
  };
}

/** Whether every rate of the schedule is zero once read to nano-USD. */
export function chargesNothing(schedule: DecimalSchedule): boolean {
  return [schedule.base, ...schedule.tiers.map((tier) => tier.rates)].every(
    (rates) => providerNano(rates.prompt) === 0n && providerNano(rates.completion) === 0n
  );
}

/** Two `max_price` limits, in 10⁻¹² USD a token per key. */
export interface PicoLimits {
  readonly input: bigint;
  readonly output: bigint;
}

/**
 * How many of the given endpoint base rates sit above the base limit on either
 * key while both rates sit at or below the max limit — the endpoints a fallback
 * can serve above the base hold. Compared in USD, as the vendor compares
 * `max_price`.
 */
export function endpointsInBand(
  bases: readonly LanguageTokenPricing[],
  baseLimit: PicoLimits,
  maxLimit: PicoLimits
): number {
  return bases.filter((rates) => {
    const prompt = picoUsdCeilOf(rates.prompt);
    const completion = picoUsdCeilOf(rates.completion);
    const aboveBase = prompt > baseLimit.input || completion > baseLimit.output;
    return aboveBase && prompt <= maxLimit.input && completion <= maxLimit.output;
  }).length;
}
