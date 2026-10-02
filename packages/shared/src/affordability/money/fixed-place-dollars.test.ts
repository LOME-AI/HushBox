import { describe, expect, it } from 'vitest';

import {
  nanoUsdToFourPlaceDollarString,
  nanoUsdToTwoPlaceDollarString,
} from './fixed-place-dollars.ts';
import { nanoUSD } from './nano-usd.ts';

describe('nanoUsdToFourPlaceDollarString', () => {
  it('rounds an exact half of the last place up', () => {
    expect(nanoUsdToFourPlaceDollarString(150_000n)).toBe('0.0002');
  });

  it('rounds an exact half of a ten-digit dollar amount up', () => {
    expect(nanoUsdToFourPlaceDollarString(1_520_633_081_492_250_000n)).toBe('1520633081.4923');
  });

  it('rounds a negative exact half away from zero', () => {
    expect(nanoUsdToFourPlaceDollarString(-150_000n)).toBe('-0.0002');
  });

  it('rounds just below a half down', () => {
    expect(nanoUsdToFourPlaceDollarString(149_999n)).toBe('0.0001');
  });

  it('formats zero', () => {
    expect(nanoUsdToFourPlaceDollarString(0n)).toBe('0.0000');
  });

  it('keeps the sign of a negative amount that rounds to zero', () => {
    expect(nanoUsdToFourPlaceDollarString(-10n)).toBe('-0.0000');
  });

  it('formats 2^63 nano-USD exactly', () => {
    expect(nanoUsdToFourPlaceDollarString(2n ** 63n)).toBe('9223372036.8548');
  });

  it('accepts a NanoUSD wire string', () => {
    expect(nanoUsdToFourPlaceDollarString('-1500000000')).toBe('-1.5000');
  });

  it('accepts a branded NanoUSD amount', () => {
    expect(nanoUsdToFourPlaceDollarString(nanoUSD(1_234_560_000n))).toBe('1.2346');
  });

  it('refuses a wire string that is not canonical', () => {
    expect(() => nanoUsdToFourPlaceDollarString('1.5')).toThrow();
  });
});

describe('nanoUsdToTwoPlaceDollarString', () => {
  it('rounds an exact half of a cent up', () => {
    expect(nanoUsdToTwoPlaceDollarString(15_000_000n)).toBe('0.02');
  });

  it('rounds an exact half of a cent up on a nine-digit dollar amount', () => {
    expect(nanoUsdToTwoPlaceDollarString(122_475_583_195_000_000n)).toBe('122475583.20');
  });

  it('rounds a negative exact half of a cent away from zero', () => {
    expect(nanoUsdToTwoPlaceDollarString(-15_000_000n)).toBe('-0.02');
  });

  it('rounds just below half a cent down', () => {
    expect(nanoUsdToTwoPlaceDollarString(14_999_999n)).toBe('0.01');
  });

  it('formats zero', () => {
    expect(nanoUsdToTwoPlaceDollarString(0n)).toBe('0.00');
  });

  it('keeps the sign of a negative amount that rounds to zero', () => {
    expect(nanoUsdToTwoPlaceDollarString(-10n)).toBe('-0.00');
  });

  it('accepts a NanoUSD wire string', () => {
    expect(nanoUsdToTwoPlaceDollarString('12500000000')).toBe('12.50');
  });

  it('refuses a wire string that is not canonical', () => {
    expect(() => nanoUsdToTwoPlaceDollarString('1.5')).toThrow();
  });
});
