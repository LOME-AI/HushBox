import { describe, expect, it } from 'vitest';

import { readBrandColors } from './brand-tokens.js';

/** A computed style holding exactly the given custom properties, as a browser reports them. */
function computedStyle(properties: Record<string, string>): {
  getPropertyValue: (property: string) => string;
} {
  return { getPropertyValue: (property) => properties[property] ?? '' };
}

// Stand-ins, not brand values: the brand's own values live only in its stylesheet.
const TOKENS: Record<string, string> = {
  '--brand-red': 'red-value',
  '--background': 'background-value',
  '--background-paper': 'paper-value',
  '--foreground': 'foreground-value',
  '--foreground-muted': 'muted-value',
};

describe('readBrandColors', () => {
  it('reads each brand colour from its custom property', () => {
    expect(readBrandColors(computedStyle(TOKENS))).toEqual({
      brandRed: 'red-value',
      background: 'background-value',
      paper: 'paper-value',
      foreground: 'foreground-value',
      muted: 'muted-value',
    });
  });

  it('trims the whitespace a computed custom property may carry', () => {
    const style = computedStyle({ ...TOKENS, '--brand-red': ' red-value ' });
    expect(readBrandColors(style).brandRed).toBe('red-value');
  });

  it('refuses a style missing a brand colour, naming the property', () => {
    const style = computedStyle({ ...TOKENS, '--background-paper': '' });
    expect(() => readBrandColors(style)).toThrow(/--background-paper/);
  });
});
