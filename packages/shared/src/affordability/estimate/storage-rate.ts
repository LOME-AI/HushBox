/**
 * The canonical storage rates in exact integer nano-USD. Storage is a
 * pass-through cost (R2 + backup, 50-year retention), charged additively and
 * NEVER marked up. The money path is bigint nano-USD end to end, so THESE are
 * the single source of truth for the storage rates; any float/dollar
 * representation needed for display derives from them, never a mirrored literal.
 *
 *  - $0.0000003/char  = 300 nano-USD/char
 *  - $0.000000018/byte = 18 nano-USD/byte
 */

export const STORAGE_COST_PER_CHARACTER_NANO = 300n;

export const MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n;

/**
 * Text storage for a character count. A count times a rate is trivial enough to
 * retype, and what it produces is money, so it has one home and callers name
 * this rather than the rate.
 *
 * `chars` is a count, never text the caller hands over to be measured here: the
 * money layer is content-free.
 */
export function charStorageNanoUsd(chars: number): bigint {
  return BigInt(chars) * STORAGE_COST_PER_CHARACTER_NANO;
}

/** Media storage for a byte count — {@link charStorageNanoUsd}'s object-storage twin. */
export function mediaStorageNanoUsd(bytes: number): bigint {
  return BigInt(bytes) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
}
