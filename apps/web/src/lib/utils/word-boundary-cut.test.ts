import { describe, it, expect } from 'vitest';
import { cutAtWordBoundary } from './word-boundary-cut';

describe('cutAtWordBoundary', () => {
  it('returns text under the budget unchanged', () => {
    const text = 'the quick brown fox';
    expect(cutAtWordBoundary(text, 100)).toBe(text);
  });

  it('returns text exactly at the budget unchanged', () => {
    const text = 'a'.repeat(20);
    expect(cutAtWordBoundary(text, 20)).toBe(text);
  });

  it('cuts text over the budget down to at most the budget length', () => {
    const text = `${'word '.repeat(20)}tail`;
    const result = cutAtWordBoundary(text, 20);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('cuts at a word boundary rather than mid-word', () => {
    const text = `${'lorem ipsum '.repeat(10)}dolor sit amet`;
    const result = cutAtWordBoundary(text, 20);
    // The character immediately preceding the cut, in the original string, was
    // whitespace: the result opens on a fresh word, never a fragment of one.
    const cutIndex = text.length - result.length;
    expect(text[cutIndex - 1]).toMatch(/\s/u);
  });

  it('keeps the tail nearest the end of the string', () => {
    const text = `${'lorem ipsum '.repeat(10)}dolor sit amet`;
    const result = cutAtWordBoundary(text, 20);
    expect(text.endsWith(result)).toBe(true);
  });

  it('cuts a single unbroken run with no word boundary short, at the budget length', () => {
    const text = 'x'.repeat(30);
    const result = cutAtWordBoundary(text, 20);
    expect(result).toBe('x'.repeat(20));
  });
});
