import { describe, it, expect } from 'vitest';
import { cappedPredictionInput, MAX_PREDICTION_INPUT_CHARS } from './prediction-input-cap';

describe('cappedPredictionInput', () => {
  it('returns text under the cap unchanged', () => {
    const text = 'the quick brown fox';
    expect(cappedPredictionInput(text)).toBe(text);
  });

  it('returns text exactly at the cap unchanged', () => {
    const text = 'a'.repeat(MAX_PREDICTION_INPUT_CHARS);
    expect(cappedPredictionInput(text)).toBe(text);
  });

  it('cuts text over the cap down to at most the cap length', () => {
    const text = `${'word '.repeat(1000)}tail`;
    const result = cappedPredictionInput(text);
    expect(result.length).toBeLessThanOrEqual(MAX_PREDICTION_INPUT_CHARS);
  });

  it('cuts at a word boundary rather than mid-word', () => {
    const text = `${'lorem ipsum '.repeat(500)}dolor sit amet`;
    const result = cappedPredictionInput(text);
    // The character immediately preceding the cut, in the original string, was
    // whitespace: the result opens on a fresh word, never a fragment of one.
    const cutIndex = text.length - result.length;
    expect(text[cutIndex - 1]).toMatch(/\s/u);
  });

  it('keeps the tail nearest the caret, the part a completion attaches to', () => {
    const text = `${'lorem ipsum '.repeat(500)}dolor sit amet`;
    const result = cappedPredictionInput(text);
    expect(text.endsWith(result)).toBe(true);
    expect(result.endsWith('dolor sit amet')).toBe(true);
  });

  it('cuts a single unbroken run with no word boundary short, at the cap length', () => {
    const text = 'x'.repeat(MAX_PREDICTION_INPUT_CHARS + 500);
    const result = cappedPredictionInput(text);
    expect(result).toBe('x'.repeat(MAX_PREDICTION_INPUT_CHARS));
  });
});
