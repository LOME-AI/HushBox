import { describe, it, expect } from 'vitest';
import {
  completionOverflows,
  isCaretAtEnd,
  isRightToLeft,
  scrollsInternally,
  suppressionReason,
  type ComposerReading,
} from './suppression';

const AT_REST: ComposerReading = {
  value: 'the cat sat',
  selectionStart: 11,
  selectionEnd: 11,
  scrollHeight: 40,
  clientHeight: 40,
  writingDirection: 'ltr',
  predictedContentHeight: null,
};

describe('isCaretAtEnd', () => {
  it('is true for a collapsed caret after the last character', () => {
    expect(isCaretAtEnd(AT_REST)).toBe(true);
  });

  it('is false for a caret in the middle of the value', () => {
    expect(isCaretAtEnd({ ...AT_REST, selectionStart: 4, selectionEnd: 4 })).toBe(false);
  });

  it('is false while a range is selected, even one ending at the last character', () => {
    expect(isCaretAtEnd({ ...AT_REST, selectionStart: 4 })).toBe(false);
  });

  it('is true for an empty value with the caret at position zero', () => {
    expect(isCaretAtEnd({ ...AT_REST, value: '', selectionStart: 0, selectionEnd: 0 })).toBe(true);
  });
});

describe('scrollsInternally', () => {
  it('is false when the content fits the visible box', () => {
    expect(scrollsInternally(AT_REST)).toBe(false);
  });

  it('is true once the content is taller than the visible box', () => {
    expect(scrollsInternally({ ...AT_REST, scrollHeight: 41 })).toBe(true);
  });

  it('is false when both measurements are zero, as they are without layout', () => {
    expect(scrollsInternally({ ...AT_REST, scrollHeight: 0, clientHeight: 0 })).toBe(false);
  });
});

describe('isRightToLeft', () => {
  it('is true for a right-to-left writing direction', () => {
    expect(isRightToLeft('rtl')).toBe(true);
  });

  it('is false for a left-to-right writing direction', () => {
    expect(isRightToLeft('ltr')).toBe(false);
  });

  it('ignores the casing and padding a computed style may carry', () => {
    expect(isRightToLeft(' RTL ')).toBe(true);
  });
});

describe('completionOverflows', () => {
  it('is false while no completion is held for the current text', () => {
    expect(completionOverflows({ ...AT_REST, predictedContentHeight: null })).toBe(false);
  });

  it('is false when the held completion fits the composer box', () => {
    expect(completionOverflows({ ...AT_REST, predictedContentHeight: 40 })).toBe(false);
  });

  it('is true when the held completion needs more height than the box offers', () => {
    expect(completionOverflows({ ...AT_REST, predictedContentHeight: 41 })).toBe(true);
  });
});

describe('suppressionReason', () => {
  it('is null when nothing suppresses the prediction', () => {
    expect(suppressionReason(AT_REST)).toBeNull();
  });

  it('names a caret that is not at the end', () => {
    expect(suppressionReason({ ...AT_REST, selectionStart: 4, selectionEnd: 4 })).toBe(
      'caret-not-at-end'
    );
  });

  it('names a composer that has started scrolling', () => {
    expect(suppressionReason({ ...AT_REST, scrollHeight: 80 })).toBe('composer-scrolls');
  });

  it('names a right-to-left composer', () => {
    expect(suppressionReason({ ...AT_REST, writingDirection: 'rtl' })).toBe('right-to-left');
  });

  it('names a completion that would overflow the composer box', () => {
    expect(suppressionReason({ ...AT_REST, predictedContentHeight: 41 })).toBe(
      'completion-too-tall'
    );
  });

  it('reports the writing direction before a too-tall completion when both hold', () => {
    expect(
      suppressionReason({ ...AT_REST, writingDirection: 'rtl', predictedContentHeight: 41 })
    ).toBe('right-to-left');
  });

  it('reports the caret before the other reasons when several hold at once', () => {
    expect(
      suppressionReason({
        ...AT_REST,
        selectionStart: 4,
        selectionEnd: 4,
        scrollHeight: 80,
        writingDirection: 'rtl',
      })
    ).toBe('caret-not-at-end');
  });

  it('reports scrolling before the writing direction when both hold', () => {
    expect(suppressionReason({ ...AT_REST, scrollHeight: 80, writingDirection: 'rtl' })).toBe(
      'composer-scrolls'
    );
  });
});
