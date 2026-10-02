/**
 * The characters-per-token ratios, one value each for every payer, and the only
 * conversions that read them. Input is an estimate: a dense script can occupy
 * more tokens than its characters ÷ 3, so the input leg is not a bound. Stored
 * output is reserved at 5 characters per output token and is never cut; a reply
 * that stores more is charged in full.
 */

import { charStorageNanoUsd } from '../estimate/storage-rate.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import type { NanoUSD } from '../money/nano-usd.ts';

export const INPUT_CHARS_PER_TOKEN = 3;

export const STORED_CHARS_PER_OUTPUT_TOKEN = 5;

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

/**
 * The input tokens a character count is estimated to occupy, rounded up. It
 * takes a count, never the characters: the money layer accepts no content.
 */
export function inputTokensOf(chars: number): number {
  assertCount(chars, 'inputTokensOf: chars');
  return Math.ceil(chars / INPUT_CHARS_PER_TOKEN);
}

/** The stored characters a hold reserves for `steps` steps, each emitting up to `wireCapTokens`. */
export function storedTextAllowanceChars(steps: number, wireCapTokens: number): number {
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new RangeError('storedTextAllowanceChars: steps must be a positive integer');
  }
  assertCount(wireCapTokens, 'storedTextAllowanceChars: wireCapTokens');
  return steps * wireCapTokens * STORED_CHARS_PER_OUTPUT_TOKEN;
}

/** The storage one output token reserves: one step's allowance for a one-token cap. */
export function outputStorageNanoUsdPerToken(): NanoUSD {
  return nanoUSD(charStorageNanoUsd(storedTextAllowanceChars(1, 1)));
}
