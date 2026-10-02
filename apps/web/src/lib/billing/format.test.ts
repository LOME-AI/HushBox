import { describe, it, expect } from 'vitest';
import { applyDollarSign, formatBalance } from './format';

describe('formatBalance', () => {
  it('renders a positive balance with two decimals', () => {
    expect(formatBalance('500000000')).toBe('$0.50');
  });

  it('puts the sign ahead of the currency symbol for a negative balance', () => {
    expect(formatBalance('-500000000')).toBe('-$0.50');
  });

  it('renders a zero balance', () => {
    expect(formatBalance('0')).toBe('$0.00');
  });

  it('truncates sub-cent precision rather than inventing digits', () => {
    expect(formatBalance('12345678900')).toBe('$12.34');
  });

  it('renders a whole-dollar balance with padded cents', () => {
    expect(formatBalance('25000000000')).toBe('$25.00');
  });

  it('rejects a value that is not a canonical nano-USD wire string', () => {
    expect(() => formatBalance('12.34')).toThrow();
  });
});

describe('applyDollarSign', () => {
  it('prefixes the currency symbol to a non-negative dollar string', () => {
    expect(applyDollarSign('1.50')).toBe('$1.50');
  });

  it('places the sign ahead of the currency symbol for a negative dollar string', () => {
    expect(applyDollarSign('-1.50')).toBe('-$1.50');
  });
});
