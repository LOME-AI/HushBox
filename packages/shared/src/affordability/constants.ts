import {
  charStorageNanoUsd,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
} from './estimate/storage-rate.ts';
import { NANO_USD_PER_CENT, NANO_USD_PER_DOLLAR } from './money/nano-usd.ts';

/** HushBox's profit margin on AI model usage (5%) */
export const HUSHBOX_FEE_RATE = 0.05;

/** Credit card processing fee (4.5%) */
export const CREDIT_CARD_FEE_RATE = 0.045;

/** AI provider overhead fee (5.5%) */
export const PROVIDER_FEE_RATE = 0.055;

/**
 * Total combined fee rate applied to all model usage.
 * SINGLE SOURCE OF TRUTH for fee calculations.
 * Sum of HUSHBOX_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE.
 * Setting any individual rate to 0 cascades through every fee-rendering surface
 * (legal, email, marketing, billing UI, README, pricing SVG) via FEE_CATEGORIES
 * in `./money/fees.ts`.
 */
export const TOTAL_FEE_RATE = HUSHBOX_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE;

/**
 * Threshold per 1k tokens (input + output combined, with fees) above which
 * models show an expensive warning. Value is in USD.
 */
export const EXPENSIVE_MODEL_THRESHOLD_PER_1K = 0.1;

/** Characters that fit in one kilobyte */
export const CHARACTERS_PER_KILOBYTE = 1000;

/** Kilobytes in one gigabyte */
export const KILOBYTES_PER_GIGABYTE = 1_000_000;

/** Monthly cost to store one gigabyte in USD */
export const MONTHLY_COST_PER_GB = 0.5;

/** Months in a year */
export const MONTHS_PER_YEAR = 12;

/** Number of years to retain storage */
export const STORAGE_YEARS = 50;

/**
 * Cost per character for storage in USD: the canonical nano rate expressed in
 * dollars for display. `STORAGE_COST_PER_CHARACTER_NANO` is the source, and the
 * cost-model constants above only record how that rate was chosen — changing
 * one of them does not move the rate, and recomputing the rate from them here
 * would be a second implementation of it, free to drift from the money path.
 */
export const STORAGE_COST_PER_CHARACTER =
  Number(STORAGE_COST_PER_CHARACTER_NANO) / Number(NANO_USD_PER_DOLLAR);

/**
 * Text storage for a character count, in dollars — {@link charStorageNanoUsd}'s
 * display twin, and the one home for that product on the display side. Surfaces
 * that render the storage share do float arithmetic over float dollar inputs, so
 * they need the figure in dollars; each one converting for itself is how two
 * views of the same page come to disagree.
 *
 * Deriving from the exact nano product rather than multiplying
 * {@link STORAGE_COST_PER_CHARACTER} keeps the result the nearest double to the
 * true cost: the rate float is already rounded, so multiplying it rounds twice.
 */
export function charStorageDollars(chars: number): number {
  return Number(charStorageNanoUsd(chars)) / Number(NANO_USD_PER_DOLLAR);
}

/**
 * Cost per 1000 characters for storage in USD.
 * Derived: STORAGE_COST_PER_CHARACTER * 1000 = $0.0003
 */
export const STORAGE_COST_PER_1K_CHARS = STORAGE_COST_PER_CHARACTER * 1000;

/** R2 actual ($0.015) + 2x markup for backup/ops/margin */
export const MEDIA_MONTHLY_COST_PER_GB = 0.03;

/**
 * Storage cost per byte for media in USD, converted from its canonical nano
 * rate for the same reason as the per-character rate above.
 * $0.000000018/byte → $0.018 per 1MB, $0.072 per 4MB image
 */
export const MEDIA_STORAGE_COST_PER_BYTE =
  Number(MEDIA_STORAGE_COST_PER_BYTE_NANO) / Number(NANO_USD_PER_DOLLAR);

/**
 * Conservative byte estimate for a generated image (encrypted).
 * Used for pre-flight budget reservation — overestimates so the user is
 * never charged more than reserved. Actual cost uses real sizeBytes.
 */
export const ESTIMATED_IMAGE_BYTES = 8_000_000;

/**
 * Conservative byte estimate per second of generated video (encrypted).
 * Used only for pre-flight reservation. Worst-case 1080p; actual cost
 * uses real `sizeBytes` from the R2 upload.
 */
export const ESTIMATED_VIDEO_BYTES_PER_SECOND = 5_000_000;

/**
 * Conservative byte estimate per second of generated audio (encrypted).
 * 256 kbps ≈ 32 KB/s — well above typical TTS output. Used only for
 * pre-flight reservation; actual cost uses real `sizeBytes` from R2.
 */
export const ESTIMATED_AUDIO_BYTES_PER_SECOND = 32_000;

/**
 * Maximum allowed negative balance in cents for paid users.
 * Paid users get this cushion above their actual balance.
 * $0.50 = 50 cents
 */
export const MAX_ALLOWED_NEGATIVE_BALANCE_CENTS = 50;

/**
 * Maximum estimated cost per message for trial users in cents.
 * Trial users are limited to cheap messages to prevent abuse.
 * $0.01 = 1 cent
 */
export const MAX_TRIAL_MESSAGE_COST_CENTS = 1;

/**
 * The same trial per-message ceiling at nano-USD scale — the one binding every
 * trial verdict compares against, on the client and on the Worker alike. It
 * lives here rather than beside any one caller because the client's trial
 * affordability and the server's trial cap must give a single answer
 * (`docs/CODE-RULES.md` §One Implementation, Shared), and this is the narrowest
 * scope that covers them all.
 */
export const TRIAL_MESSAGE_COST_CAP_NANO_USD: bigint =
  BigInt(MAX_TRIAL_MESSAGE_COST_CENTS) * NANO_USD_PER_CENT;

/**
 * Minimum output tokens to reserve for AI response.
 * Used in budget calculations to ensure meaningful responses.
 */
export const MINIMUM_OUTPUT_TOKENS = 1000;

/**
 * Threshold for low balance warning.
 * When the answer share (the output-token pool less the turn's pinned reasoning budget)
 * < this value, show warning to paid users.
 */
export const LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD = 10_000;

/**
 * Capacity threshold for red zone (warning).
 * When usage >= 67% of model context, show red bar.
 */
export const CAPACITY_RED_THRESHOLD = 0.67;

/**
 * Capacity threshold for yellow zone (caution).
 * When usage >= 33% of model context, show yellow bar.
 * Below this, show green bar.
 */
export const CAPACITY_YELLOW_THRESHOLD = 0.33;

/**
 * Catalog admission's price floor, as nano-USD per 1,000 combined (prompt +
 * completion) tokens: $0.0002/1K, equivalently 200 nano-USD per token.
 *
 * It is a MARGIN floor, so it is tested against the RAW PRE-FEE provider rate —
 * the fee is the margin, so the raw rate decides whether a percentage of it is
 * worth having. At the floor the markup earns $0.00003 per 1,000 tokens while
 * every fixed cost of serving the turn is unchanged, so below it the
 * transaction does not pay for itself.
 *
 * Nano-USD bigint rather than the USD float the specification states, because
 * the comparison it feeds is a money comparison.
 */
export const MIN_PRICE_PER_1K_TOKENS_NANO = 200_000n;

/**
 * Catalog admission's age cutoff: two years. An ageing catalog entry is a
 * maintenance and quality liability, not a commercial one.
 */
export const MAX_MODEL_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * Catalog admission's capability exemption: a model whose context length lands
 * in the top 5% of the pool bypasses the price floor and the age cutoff —
 * exceptional capability buys its way in. It never bypasses the zero-price
 * rule.
 */
export const TOP_CONTEXT_PERCENTILE = 0.95;

/**
 * Smart Model's high-cost-outlier test: a candidate whose `maxCallCost` exceeds
 * this multiple of the pool median is dropped from the classifier-selectable set
 * (`docs/BILLING.md` §Smart Model 3). A RATIO to the median rather than a quota,
 * so it fires only when a tail genuinely exists and never trims a tight
 * distribution.
 *
 * Nano-USD bigint rather than a number, because the comparison it feeds
 * multiplies a nano-USD median.
 */
export const OUTLIER_COST_MULTIPLE = 20n;
