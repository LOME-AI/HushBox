import { describe, expect, it } from 'vitest';
import { NO_COUNT, NO_RATE } from './absent-figure.js';

describe('absent figure wording', () => {
  it('states an absent count in words rather than a mark a figures column reads as a number', () => {
    expect(NO_COUNT).toBe('No data');
  });

  it('states an absent rate in the words the ladder states one in', () => {
    expect(NO_RATE).toBe('No rate');
  });

  it('carries no long dash in either wording', () => {
    expect([NO_COUNT, NO_RATE].join(' ')).not.toMatch(/[\u2013\u2014]/u);
  });
});
