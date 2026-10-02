/**
 * What a user is shown of a model's price: the anchor's rates. A long-context
 * tier applies only past its threshold, so it is never the headline; it is
 * listed beside it.
 */

import { isExpensiveModelNano, nanoPricePer1k, nanoPriceRangePer1k } from '../estimate/format.ts';
import { nanoUSD, parseNanoUSD, serializeNanoUSD } from '../money/nano-usd.ts';
import { mediaRatesFor, scheduleFor } from './schedule.ts';
import { pricingFromWire } from './wire.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { Model, WireModelPricing } from '../../schemas/api/models.ts';
import type { MediaPricing, TokenPricing, TokenRates } from './schedule.ts';

export function anchorBaseRatesNanoUsd(pricing: TokenPricing): TokenRates {
  return scheduleFor(pricing, 'display').base;
}

/**
 * The anchor's base input and output rates added: the one quantity the premium
 * price threshold and the cheapest-model comparisons read, through
 * `combinedRateNanoUsd`, and the display sort reads directly. Exact bigint
 * addition, because it decides a paid-access boundary.
 */
export function combinedAnchorRateNanoUsd(pricing: TokenPricing): NanoUSD {
  const { input, output } = anchorBaseRatesNanoUsd(pricing);
  return nanoUSD(input + output);
}

/**
 * Everything a surface shows or orders by of a served row's price. A field is
 * absent when the row states no price the schedule can represent, so an
 * unpriced row is never shown, sorted or picked as a free one.
 */
export interface ModelPriceDisplay {
  /** The anchor's base input rate per 1k tokens, as `$X`. */
  readonly inputPer1k?: string;
  /** The anchor's base output rate per 1k tokens, as `$X`. */
  readonly outputPer1k?: string;
  /** The anchor's base input rate per token, for a surface that formats it its own way. */
  readonly inputNanoUsd?: NanoUSD;
  /** The anchor's base output rate per token, for a surface that formats it its own way. */
  readonly outputNanoUsd?: NanoUSD;
  /**
   * The anchor's long-context rates per 1k tokens, ascending by threshold, each
   * applying to a request whose prompt tokens are strictly above it; empty when
   * it has none.
   */
  readonly longContext: readonly {
    readonly abovePromptTokens: number;
    readonly inputPer1k?: string;
    readonly outputPer1k?: string;
  }[];
  /** Whether the anchor's base rates together reach the expensive-model threshold. */
  readonly expensive: boolean;
  /**
   * One figure a row is ranked by: the combined base rate of a token row, the
   * per-image anchor, or the cheapest per-second anchor across a video row's
   * resolutions.
   */
  readonly sortKeyNanoUsd?: bigint;
  /** An image row's anchor per image. */
  readonly perImageNanoUsd?: NanoUSD;
  /** A video row's anchor per second, by resolution. */
  readonly perSecondNanoUsd?: Readonly<Record<string, NanoUSD>>;
  /** The Smart Model row's pool range of input rates per 1k tokens, when both bounds are served. */
  readonly inputRangePer1k?: string;
  /** The Smart Model row's pool range of output rates per 1k tokens, when both bounds are served. */
  readonly outputRangePer1k?: string;
  /** The same input range per token, when both bounds are served. */
  readonly inputRangeNanoUsd?: NanoUSDRange;
  /** The same output range per token, when both bounds are served. */
  readonly outputRangeNanoUsd?: NanoUSDRange;
}

/** A pool's lowest and highest rate for one leg. */
interface NanoUSDRange {
  readonly min: NanoUSD;
  readonly max: NanoUSD;
}

type WireTokenRateKey = 'inputPerToken' | 'outputPerToken';

/** The range a served pool states for one rate, or `undefined` when either bound is missing. */
function servedRange(model: Model, key: WireTokenRateKey): NanoUSDRange | undefined {
  const low = model.minPricing?.[key];
  const high = model.maxPricing?.[key];
  if (low === undefined || high === undefined) return undefined;
  return { min: parseNanoUSD(low), max: parseNanoUSD(high) };
}

type SmartRangeFields =
  | 'inputRangePer1k'
  | 'outputRangePer1k'
  | 'inputRangeNanoUsd'
  | 'outputRangeNanoUsd';

function smartRanges(model: Model): Pick<ModelPriceDisplay, SmartRangeFields> {
  const input = servedRange(model, 'inputPerToken');
  const output = servedRange(model, 'outputPerToken');
  return {
    ...(input === undefined
      ? {}
      : {
          inputRangePer1k: nanoPriceRangePer1k(input.min, input.max),
          inputRangeNanoUsd: input,
        }),
    ...(output === undefined
      ? {}
      : {
          outputRangePer1k: nanoPriceRangePer1k(output.min, output.max),
          outputRangeNanoUsd: output,
        }),
  };
}

function tokenDisplay(pricing: TokenPricing): ModelPriceDisplay {
  const { base, tiers } = scheduleFor(pricing, 'display');
  return {
    inputPer1k: nanoPricePer1k(base.input),
    outputPer1k: nanoPricePer1k(base.output),
    inputNanoUsd: base.input,
    outputNanoUsd: base.output,
    longContext: tiers.map((tier) => ({
      abovePromptTokens: tier.abovePromptTokens,
      inputPer1k: nanoPricePer1k(tier.rates.input),
      outputPer1k: nanoPricePer1k(tier.rates.output),
    })),
    expensive: isExpensiveModelNano(base.input, base.output),
    sortKeyNanoUsd: combinedAnchorRateNanoUsd(pricing),
  };
}

/** The value `pick` prefers over every other, refusing an empty list: it has no extremum. */
function extreme(values: readonly bigint[], pick: (a: bigint, b: bigint) => boolean): bigint {
  const [first, ...rest] = values;
  if (first === undefined) throw new RangeError('no rate to take an extremum of');
  let found = first;
  for (const value of rest) if (pick(value, found)) found = value;
  return found;
}

function lowerThan(a: bigint, b: bigint): boolean {
  return a < b;
}

function mediaDisplay(pricing: MediaPricing): ModelPriceDisplay {
  if (pricing.kind === 'perImage') {
    const perImage = mediaRatesFor(pricing, 'display');
    return {
      longContext: [],
      expensive: false,
      perImageNanoUsd: perImage,
      sortKeyNanoUsd: perImage,
    };
  }
  const perSecond = mediaRatesFor(pricing, 'display');
  return {
    longContext: [],
    expensive: false,
    perSecondNanoUsd: perSecond,
    // A per-second anchor prices at least one resolution, so it has a cheapest.
    sortKeyNanoUsd: extreme(Object.values(perSecond), lowerThan),
  };
}

const UNPRICED: ModelPriceDisplay = { longContext: [], expensive: false };

function pricedDisplay(model: Model): ModelPriceDisplay {
  const pricing = pricingFromWire(model);
  if (pricing === undefined) return UNPRICED;
  return pricing.kind === 'tokens' ? tokenDisplay(pricing) : mediaDisplay(pricing);
}

/** What a surface shows of a served row's price, read off its anchor. */
export function modelPriceDisplay(model: Model): ModelPriceDisplay {
  return { ...pricedDisplay(model), ...smartRanges(model) };
}

/** A served token rate pair, both legs present. */
export type WireTokenRates = Required<Pick<WireModelPricing, WireTokenRateKey>>;

function lowest(values: readonly bigint[]): string {
  return serializeNanoUSD(nanoUSD(extreme(values, lowerThan)));
}

function highest(values: readonly bigint[]): string {
  return serializeNanoUSD(nanoUSD(extreme(values, (a, b) => a > b)));
}

/**
 * The Smart Model row's served range: each anchor base rate's minimum and
 * maximum across the pool, leg by leg, so the two bounds of one row may come
 * from different models. An empty pool has no extremum, and a zero would publish
 * a free rate, so it refuses instead.
 */
export function smartPoolRange(pool: readonly TokenPricing[]): {
  readonly minPricing: WireTokenRates;
  readonly maxPricing: WireTokenRates;
} {
  const rates = pool.map((pricing) => anchorBaseRatesNanoUsd(pricing));
  const inputs = rates.map((rate) => rate.input);
  const outputs = rates.map((rate) => rate.output);
  return {
    minPricing: { inputPerToken: lowest(inputs), outputPerToken: lowest(outputs) },
    maxPricing: { inputPerToken: highest(inputs), outputPerToken: highest(outputs) },
  };
}
