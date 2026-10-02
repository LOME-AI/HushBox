import { describe, it, expect } from 'vitest';
import {
  MIN_PREDICTED_WORDS,
  MIN_TYPED_WORDS_TO_PREDICT,
  shapeAlternatives,
  shapeCompletion,
  shapePrediction,
} from './shaping';

const ENOUGH_TYPED = 'the cat sat';

describe('shapeCompletion', () => {
  it('keeps every word when trailing whitespace proves the last one finished', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the mat ')).toBe(' on the mat');
  });

  it('preserves the leading whitespace the completion arrived with', () => {
    expect(shapeCompletion(ENOUGH_TYPED, '  on the mat ')).toBe('  on the mat');
  });

  it('drops the last word when nothing proves it finished', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the mat')).toBe(' on the');
  });

  it('keeps a completion that continues the typed word without a space', () => {
    expect(shapeCompletion('the cat sa', 't on the mat ')).toBe('t on the mat');
  });

  it('truncates at the first newline', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the mat.\nand then slept')).toBe(' on the mat.');
  });

  it('truncates a carriage-return newline without leaving the carriage return', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the mat.\r\nand then slept')).toBe(' on the mat.');
  });

  it('returns null when the completion starts with a newline', () => {
    expect(shapeCompletion(ENOUGH_TYPED, '\n on the mat ')).toBeNull();
  });

  it('drops a trailing partial hyphenated word', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the well-')).toBe(' on the');
  });

  it('drops a trailing partial word ending in an apostrophe', () => {
    expect(shapeCompletion(ENOUGH_TYPED, " on the cat'")).toBe(' on the');
  });

  it('keeps a trailing word closed by punctuation', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the mat.')).toBe(' on the mat.');
  });

  it('trims the trailing whitespace it kept the completion for', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the mat   ')).toBe(' on the mat');
  });

  it('returns null when fewer than the minimum words survive', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' onwards ')).toBeNull();
  });

  it('returns null when only a partial word arrived', () => {
    expect(shapeCompletion(ENOUGH_TYPED, 'onwar')).toBeNull();
  });

  it('returns null when the completion is only whitespace', () => {
    expect(shapeCompletion(ENOUGH_TYPED, '   ')).toBeNull();
  });

  it('returns null when the completion is empty', () => {
    expect(shapeCompletion(ENOUGH_TYPED, '')).toBeNull();
  });

  it('returns null when the typed text has fewer than the minimum words', () => {
    expect(shapeCompletion('the cat', ' sat on the mat ')).toBeNull();
  });

  it('counts a typed word across any whitespace run', () => {
    expect(shapeCompletion('  the \t cat\n sat  ', ' on the mat ')).toBe(' on the mat');
  });

  it('returns null for empty typed text', () => {
    expect(shapeCompletion('', ' on the mat ')).toBeNull();
  });

  it('keeps a completion ending in an emoji rather than reading it as a partial word', () => {
    expect(shapeCompletion(ENOUGH_TYPED, ' on the 😺')).toBe(' on the 😺');
  });
});

describe('minimum-word constants', () => {
  it('requires at least two predicted words', () => {
    expect(MIN_PREDICTED_WORDS).toBe(2);
  });

  it('requires more typed words than a prediction is allowed to be short', () => {
    expect(MIN_TYPED_WORDS_TO_PREDICT).toBeGreaterThan(MIN_PREDICTED_WORDS);
  });
});

describe('shapeAlternatives', () => {
  it('shapes each alternative against the typed text', () => {
    expect(
      shapeAlternatives(ENOUGH_TYPED, ' on the mat', [' by the fire ', ' near the door '])
    ).toEqual([' by the fire', ' near the door']);
  });

  it('drops an alternative that does not survive shaping', () => {
    expect(shapeAlternatives(ENOUGH_TYPED, ' on the mat', [' onwards '])).toEqual([]);
  });

  it('drops an alternative that shapes to the same text as the completion', () => {
    expect(shapeAlternatives(ENOUGH_TYPED, ' on the mat', [' on the mat too'])).toEqual([]);
  });

  it('drops an alternative that shapes to text another alternative already offers', () => {
    expect(
      shapeAlternatives(ENOUGH_TYPED, ' on the mat', [' by the fire ', ' by the fire too'])
    ).toEqual([' by the fire']);
  });

  it('returns an empty list when no alternatives arrived', () => {
    expect(shapeAlternatives(ENOUGH_TYPED, ' on the mat', [])).toEqual([]);
  });
});

describe('shapePrediction', () => {
  it('shapes the completion and the alternatives that survive shaping', () => {
    expect(
      shapePrediction(ENOUGH_TYPED, {
        completion: ' on the mat ',
        alternatives: [' by the fire ', ' near the door '],
      })
    ).toEqual({
      completion: ' on the mat',
      candidates: [' by the fire', ' near the door'],
    });
  });

  it('returns null when the completion itself does not survive shaping', () => {
    expect(
      shapePrediction(ENOUGH_TYPED, { completion: ' onwards ', alternatives: [' by the fire '] })
    ).toBeNull();
  });

  it('drops alternatives that do not survive shaping', () => {
    expect(
      shapePrediction(ENOUGH_TYPED, { completion: ' on the mat ', alternatives: [' onwards '] })
    ).toEqual({ completion: ' on the mat', candidates: [] });
  });

  it('drops an alternative that repeats the completion', () => {
    expect(
      shapePrediction(ENOUGH_TYPED, {
        completion: ' on the mat ',
        alternatives: [' on the mat too', ' by the fire ', ' on the mat '],
      })
    ).toEqual({
      completion: ' on the mat',
      candidates: [' by the fire'],
    });
  });

  it('returns an empty candidate list when no alternatives arrived', () => {
    expect(shapePrediction(ENOUGH_TYPED, { completion: ' on the mat ', alternatives: [] })).toEqual(
      { completion: ' on the mat', candidates: [] }
    );
  });
});
