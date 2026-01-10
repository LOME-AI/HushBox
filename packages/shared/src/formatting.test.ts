import { describe, expect, it } from 'vitest';
import { formatNumber, formatContextLength, formatPricePer1k, formatCost } from './formatting';

describe('formatting utilities', () => {
  describe('formatNumber', () => {
    it('formats small numbers without separators', () => {
      expect(formatNumber(123)).toBe('123');
    });

    it('formats large numbers with thousand separators', () => {
      // Note: exact format depends on locale, but should include separator
      const result = formatNumber(1234567);
      expect(result).toMatch(/1.*234.*567/);
    });

    it('handles zero', () => {
      expect(formatNumber(0)).toBe('0');
    });

    it('handles negative numbers', () => {
      const result = formatNumber(-1234);
      expect(result).toContain('1');
      expect(result).toContain('234');
    });
  });

  describe('formatContextLength', () => {
    it('formats values under 1M with k suffix', () => {
      expect(formatContextLength(128000)).toBe('128k');
      expect(formatContextLength(4000)).toBe('4k');
      expect(formatContextLength(32000)).toBe('32k');
    });

    it('formats values at or above 1M with M suffix', () => {
      expect(formatContextLength(1000000)).toBe('1M');
      expect(formatContextLength(2000000)).toBe('2M');
    });

    it('rounds to nearest unit', () => {
      expect(formatContextLength(128500)).toBe('129k');
      expect(formatContextLength(1500000)).toBe('2M');
    });
  });

  describe('formatPricePer1k', () => {
    it('formats typical token prices', () => {
      expect(formatPricePer1k(0.00001)).toBe('$0.01');
      expect(formatPricePer1k(0.000015)).toBe('$0.015');
    });

    it('strips trailing zeros', () => {
      expect(formatPricePer1k(0.001)).toBe('$1');
      expect(formatPricePer1k(0.0001)).toBe('$0.1');
    });

    it('handles very small prices', () => {
      expect(formatPricePer1k(0.000001)).toBe('$0.001');
    });
  });

  describe('formatCost', () => {
    it('formats zero as $0.00', () => {
      expect(formatCost(0)).toBe('$0.00');
      expect(formatCost('0')).toBe('$0.00');
      expect(formatCost('0.00000000')).toBe('$0.00');
    });

    it('formats normal costs with 4 decimal places', () => {
      expect(formatCost(0.0234)).toBe('$0.0234');
      expect(formatCost('0.12345678')).toBe('$0.1235');
    });

    it('formats very small costs with 6 decimal places', () => {
      expect(formatCost(0.00001)).toBe('$0.000010');
      expect(formatCost('0.000005')).toBe('$0.000005');
    });

    it('handles NaN as $0.00', () => {
      expect(formatCost('invalid')).toBe('$0.00');
      expect(formatCost(NaN)).toBe('$0.00');
    });

    it('accepts both string and number inputs', () => {
      expect(formatCost(1.5)).toBe('$1.5000');
      expect(formatCost('1.5')).toBe('$1.5000');
    });
  });
});
