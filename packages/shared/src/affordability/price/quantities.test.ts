import { describe, expect, it } from 'vitest';

import {
  INPUT_CHARS_PER_TOKEN,
  STORED_CHARS_PER_OUTPUT_TOKEN,
  inputTokensOf,
  outputStorageNanoUsdPerToken,
  storedTextAllowanceChars,
} from './quantities.ts';

describe('the two characters-per-token ratios', () => {
  it('estimates input at 3 characters per token', () => {
    expect(INPUT_CHARS_PER_TOKEN).toBe(3);
  });

  it('reserves stored output at 5 characters per token', () => {
    expect(STORED_CHARS_PER_OUTPUT_TOKEN).toBe(5);
  });
});

describe('inputTokensOf', () => {
  it.each([
    [0, 0],
    [1, 1],
    [3, 1],
    [4, 2],
    [3000, 1000],
    [3001, 1001],
  ])('converts %i characters to %i input tokens, rounding up', (chars, tokens) => {
    expect(inputTokensOf(chars)).toBe(tokens);
  });

  it('refuses a negative character count', () => {
    expect(() => inputTokensOf(-1)).toThrow(RangeError);
  });

  it('refuses a fractional character count', () => {
    expect(() => inputTokensOf(2.5)).toThrow(RangeError);
  });
});

describe('storedTextAllowanceChars', () => {
  it('allows 5 stored characters per output token on every step', () => {
    expect(storedTextAllowanceChars(8, 64_000)).toBe(2_560_000);
  });

  it('allows nothing for a zero output cap', () => {
    expect(storedTextAllowanceChars(3, 0)).toBe(0);
  });

  it('refuses a step count below one', () => {
    expect(() => storedTextAllowanceChars(0, 64_000)).toThrow(RangeError);
  });

  it('refuses a negative output cap', () => {
    expect(() => storedTextAllowanceChars(1, -1)).toThrow(RangeError);
  });
});

describe('outputStorageNanoUsdPerToken', () => {
  it('prices one output token of stored text at 5 characters of storage', () => {
    expect(outputStorageNanoUsdPerToken()).toBe(1500n);
  });
});
