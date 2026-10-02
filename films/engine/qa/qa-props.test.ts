import { describe, expect, it } from 'vitest';

import {
  HIDDEN_TEXT_PROPS,
  UNFINISHED_HIDDEN_TEXT_PROPS,
  UNFINISHED_TEXT_PROPS,
  readQaHideText,
  readQaSkipPost,
} from './qa-props.js';

describe('readQaHideText', () => {
  it('is false when the prop is absent', () => {
    expect(readQaHideText({})).toBe(false);
  });

  it('is true when the prop is true', () => {
    expect(readQaHideText({ qaHideText: true })).toBe(true);
  });

  it('is false when the prop is false', () => {
    expect(readQaHideText({ qaHideText: false })).toBe(false);
  });

  it('refuses a value that is not a boolean, naming it', () => {
    expect(() => readQaHideText({ qaHideText: 'yes' })).toThrow(
      /qaHideText must be true or false, got "yes"/
    );
  });
});

describe('HIDDEN_TEXT_PROPS', () => {
  it('turns the hidden-text pass on', () => {
    expect(readQaHideText(HIDDEN_TEXT_PROPS)).toBe(true);
  });
});

describe('readQaSkipPost', () => {
  it('is false when the prop is absent', () => {
    expect(readQaSkipPost({})).toBe(false);
  });

  it('is true when the prop is true', () => {
    expect(readQaSkipPost({ qaSkipPost: true })).toBe(true);
  });

  it('is false when the prop is false', () => {
    expect(readQaSkipPost({ qaSkipPost: false })).toBe(false);
  });

  it('refuses a value that is not a boolean, naming it', () => {
    expect(() => readQaSkipPost({ qaSkipPost: 1 })).toThrow(
      /qaSkipPost must be true or false, got 1/
    );
  });
});

describe('UNFINISHED_TEXT_PROPS', () => {
  it('skips the post chain', () => {
    expect(readQaSkipPost(UNFINISHED_TEXT_PROPS)).toBe(true);
  });

  it('draws the text', () => {
    expect(readQaHideText(UNFINISHED_TEXT_PROPS)).toBe(false);
  });
});

describe('UNFINISHED_HIDDEN_TEXT_PROPS', () => {
  it('skips the post chain', () => {
    expect(readQaSkipPost(UNFINISHED_HIDDEN_TEXT_PROPS)).toBe(true);
  });

  it('hides the text', () => {
    expect(readQaHideText(UNFINISHED_HIDDEN_TEXT_PROPS)).toBe(true);
  });
});
