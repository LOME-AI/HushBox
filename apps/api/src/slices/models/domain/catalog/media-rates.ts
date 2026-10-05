import { DECIMAL_USD_PATTERN } from '@hushbox/shared';
import { compareDecimal } from './price-schedule.js';
import type { ImagePricingEntry } from './gateway-metadata.js';

/**
 * The per-unit rates a media listing states, read as the vendor's exact decimal
 * USD strings, before any fee. Each family yields the rates a call can be billed
 * at, so the reserve can take the dearest of them: the call sends neither the
 * variant an image row names nor an audio flag, so any of them can bill it.
 */

/** One nano-USD, the smallest amount the catalog states. */
const ONE_NANO_USD = '0.000000001';

/**
 * A readable vendor rate, with one below 1 nano-USD read as `0`: the bake would
 * round it up to 1 nano, a positive rate the schedule accepts, so two spellings
 * of a free rate would land differently.
 */
function readRate(usd: string): string {
  return compareDecimal(usd, ONE_NANO_USD) < 0 ? '0' : usd;
}

/** The member `prefers` ranks above every other, the first listed on a tie. */
function preferredOf(
  values: readonly [string, ...string[]],
  prefers: (candidate: string, best: string) => boolean
): string {
  let best = values[0];
  for (const candidate of values) if (prefers(candidate, best)) best = candidate;
  return best;
}

function dearestOf(rates: readonly [string, ...string[]]): string {
  return preferredOf(rates, (rate, best) => compareDecimal(rate, best) > 0);
}

function cheapestOf(rates: readonly [string, ...string[]]): string {
  return preferredOf(rates, (rate, best) => compareDecimal(rate, best) < 0);
}

// --- image -----------------------------------------------------------------

/** OpenRouter image billing units that price one output image. */
const PER_IMAGE_UNITS: ReadonlySet<string> = new Set(['image', 'per_image', 'per_output_image']);

export type ImageRates =
  | {
      readonly kind: 'priced';
      /** The cheapest per-image row. */
      readonly anchor: string;
      /** The dearest per-image row, variant rows included. */
      readonly dearest: string;
    }
  | { readonly kind: 'token' }
  | { readonly kind: 'megapixel' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' };

interface ImagePricingScan {
  readonly perImage: string[];
  sawUnreadablePerImage: boolean;
  sawToken: boolean;
  sawMegapixel: boolean;
  sawUnknownUnit: boolean;
}

/** Classify one pricing entry into the running scan. Only `output_image` rows count. */
function scanImagePricingEntry(entry: ImagePricingEntry, scan: ImagePricingScan): void {
  if (entry.billable !== 'output_image') return;
  if (PER_IMAGE_UNITS.has(entry.unit)) {
    if (DECIMAL_USD_PATTERN.test(entry.costUsd)) scan.perImage.push(readRate(entry.costUsd));
    else scan.sawUnreadablePerImage = true;
  } else if (entry.unit.includes('token')) scan.sawToken = true;
  else if (entry.unit.includes('megapixel')) scan.sawMegapixel = true;
  else scan.sawUnknownUnit = true;
}

/**
 * An image model's output rates. Only the `output_image` charge sets the
 * per-image rate; input-* roles (reference / text / image inputs) are never the
 * generation price and are ignored.
 *
 * With at least one readable per-image row, the model is priced over those rows
 * unless any other output_image row is listed — an unparseable per-image value,
 * an unrecognized unit, a per-token or a per-megapixel row — in which case it is
 * the loud `unknown`: the reserve must cover every row the provider can bill,
 * and that row's per-image figure is unknown.
 *
 * With no readable per-image row, the outcome is the first that applies, in
 * this order: a per-token row makes it the quiet `token` (a growing set of image
 * models), else a per-megapixel row the quiet `megapixel` (e.g. the flux.2
 * family), else an unrecognized unit or an unparseable per-image value the loud
 * `unknown`, else — no output rows at all, common for preview models — the
 * quiet `missing`.
 */
export function imageRates(entries: readonly ImagePricingEntry[]): ImageRates {
  const scan: ImagePricingScan = {
    perImage: [],
    sawUnreadablePerImage: false,
    sawToken: false,
    sawMegapixel: false,
    sawUnknownUnit: false,
  };
  for (const entry of entries) scanImagePricingEntry(entry, scan);
  const [first, ...rest] = scan.perImage;
  if (first === undefined) return unpricedImageRates(scan);
  const sawUnpriceable =
    scan.sawUnreadablePerImage || scan.sawUnknownUnit || scan.sawToken || scan.sawMegapixel;
  if (sawUnpriceable) return { kind: 'unknown' };
  const rates: [string, ...string[]] = [first, ...rest];
  return { kind: 'priced', anchor: cheapestOf(rates), dearest: dearestOf(rates) };
}

/** The outcome of a scan that read no per-image rate, by the precedence {@link imageRates} states. */
function unpricedImageRates(scan: ImagePricingScan): Exclude<ImageRates, { kind: 'priced' }> {
  if (scan.sawToken) return { kind: 'token' };
  if (scan.sawMegapixel) return { kind: 'megapixel' };
  if (scan.sawUnknownUnit || scan.sawUnreadablePerImage) return { kind: 'unknown' };
  return { kind: 'missing' };
}

/** Whether a priced image's rows bill at more than one rate. */
export function ratesDiffer(rates: Extract<ImageRates, { kind: 'priced' }>): boolean {
  return compareDecimal(rates.anchor, rates.dearest) !== 0;
}

/** A listed image resolution's size: `768` is 768, `1.5K` is 1,500. */
function resolutionSize(resolution: string): number {
  const match = /^(\d+(?:\.\d+)?)(k?)$/i.exec(resolution);
  if (match === null) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * (match[2] === '' ? 1 : 1000);
}

/** The smallest-sized of a non-empty resolution list; an unsized value never wins over a sized one. */
export function smallestResolution(resolutions: readonly [string, ...string[]]): string {
  return preferredOf(
    resolutions,
    (resolution, smallest) => resolutionSize(resolution) < resolutionSize(smallest)
  );
}

// --- video -----------------------------------------------------------------

/** Shift a decimal USD-cents string two places right of the point:
 * "5" → "0.05", "5.5" → "0.055", "123" → "1.23" — exact string math. */
function centsToUsd(cents: string): string {
  const dot = cents.indexOf('.');
  const whole = dot === -1 ? cents : cents.slice(0, dot);
  const fraction = dot === -1 ? '' : cents.slice(dot + 1);
  const digits = whole + fraction;
  const pointPos = whole.length - 2;
  if (pointPos <= 0) return `0.${'0'.repeat(-pointPos)}${digits}`;
  return `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

interface VideoRate {
  /** `null` = flat: it can bill any resolution. */
  readonly resolution: string | null;
  /** Decimal USD per second. */
  readonly usd: string;
}

type VideoSkuOutcome =
  | { readonly kind: 'rate'; readonly rate: VideoRate }
  | { readonly kind: 'skip' }
  | { readonly kind: 'token' }
  | { readonly kind: 'unknown' };

/** A SKU key's role, read from its markers before rate parsing:
 * `video_tokens*` → token-priced; `*_input` / `image_to_video*` → an input mode
 * the call never sends, dropped. `undefined` = a per-second rate key to parse. */
function videoSkuMarker(key: string): 'token' | 'skip' | undefined {
  if (key.includes('video_tokens')) return 'token';
  if (key.includes('_input') || key.includes('image_to_video')) return 'skip';
  return undefined;
}

interface ParsedVideoRateKey {
  readonly unit: 'usd' | 'cents';
  /** `null` = flat (no resolution suffix). */
  readonly resolution: string | null;
}

/** Parse a per-second rate key: strip the `text_to_video_` mode prefix and the
 * `_with_audio` / `_without_audio` marker, read the unit prefix
 * (`duration_seconds` = USD/sec, `cents_per_video_output_second` = cents/sec),
 * and take the resolution suffix (empty → flat). An unrecognized unit returns
 * `undefined` (→ unknown). */
function parseVideoRateKey(key: string): ParsedVideoRateKey | undefined {
  let rest = key;
  if (rest.startsWith('text_to_video_')) rest = rest.slice('text_to_video_'.length);
  rest = rest.replace('_without_audio', '').replace('_with_audio', '');
  let unit: 'usd' | 'cents';
  if (rest.startsWith('cents_per_video_output_second')) {
    unit = 'cents';
    rest = rest.slice('cents_per_video_output_second'.length);
  } else if (rest.startsWith('duration_seconds')) {
    unit = 'usd';
    rest = rest.slice('duration_seconds'.length);
  } else {
    return undefined;
  }
  const token = rest.replace(/^_/, '');
  return { unit, resolution: token.length > 0 ? token : null };
}

/**
 * Classify one `pricing_skus` entry. Markers first (token / dropped input mode),
 * then a per-second `rate` (`duration_seconds[...]` USD or
 * `cents_per_video_output_second[...]` cents). An unrecognized unit, or a value
 * that is not a decimal, is `unknown` — the fail-closed net for a novel
 * taxonomy, and for a rate the reserve could not cover.
 */
function classifyVideoSku(key: string, value: string): VideoSkuOutcome {
  const marker = videoSkuMarker(key);
  if (marker !== undefined) return { kind: marker };
  const parsed = parseVideoRateKey(key);
  if (parsed === undefined) return { kind: 'unknown' };
  if (!DECIMAL_USD_PATTERN.test(value)) return { kind: 'unknown' };
  const usd = parsed.unit === 'cents' ? centsToUsd(value) : value;
  return { kind: 'rate', rate: { resolution: parsed.resolution, usd: readRate(usd) } };
}

type VideoRates =
  | {
      readonly kind: 'priced';
      /** Decimal USD per second, keyed exactly by the declared resolutions. */
      readonly perSecondByResolution: Record<string, string>;
      readonly fallbacks: readonly string[];
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'token' }
  | { readonly kind: 'unknown' };

/** Collect every SKU's rate, or reject the whole model on the first `token` /
 * `unknown` SKU (both make the model unpriceable-as-declared). */
function collectVideoRates(
  skus: Readonly<Record<string, string>>
): { readonly rates: readonly VideoRate[] } | { readonly reject: 'token' | 'unknown' } {
  const rates: VideoRate[] = [];
  for (const [key, value] of Object.entries(skus)) {
    const outcome = classifyVideoSku(key, value);
    if (outcome.kind === 'token' || outcome.kind === 'unknown') return { reject: outcome.kind };
    if (outcome.kind === 'rate') rates.push(outcome.rate);
  }
  return { rates };
}

/**
 * Build the per-resolution price matrix whose KEYS EXACTLY EQUAL the model's
 * declared `supported_resolutions` (case-preserved), so the estimator's strict
 * exact-key lookup can never miss. Each resolution takes the dearest rate that
 * can bill it — its own rates and the flat ones, with and without audio — since
 * the call sends no audio flag. When a resolution has no such rate but the
 * model prices some other resolution, its max known rate is SUBSTITUTED and
 * flagged (`fallbacks`): the one loud price-substitution, alerted for a human to
 * verify. A model with no usable rate at all is `unknown` (fail-closed); a model
 * that declares no resolutions is `empty`.
 */
export function videoRates(
  resolutions: readonly string[],
  skus: Readonly<Record<string, string>>
): VideoRates {
  const collected = collectVideoRates(skus);
  if ('reject' in collected) return { kind: collected.reject };
  const { rates } = collected;
  if (resolutions.length === 0) return { kind: 'empty' };
  const [first, ...rest] = rates.map((rate) => rate.usd);
  if (first === undefined) return { kind: 'unknown' };
  const substitute = dearestOf([first, ...rest]);
  const perSecondByResolution: Record<string, string> = {};
  const fallbacks: string[] = [];
  for (const resolution of resolutions) {
    const [own, ...others] = rates
      .filter(
        (rate) =>
          rate.resolution === null || rate.resolution.toLowerCase() === resolution.toLowerCase()
      )
      .map((rate) => rate.usd);
    perSecondByResolution[resolution] =
      own === undefined ? substitute : dearestOf([own, ...others]);
    if (own === undefined) fallbacks.push(resolution);
  }
  return { kind: 'priced', perSecondByResolution, fallbacks };
}
