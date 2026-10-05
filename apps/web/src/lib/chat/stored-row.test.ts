import { describe, expect, it } from 'vitest';
import { isStoredRow } from './stored-row';

describe('isStoredRow', () => {
  it('reads a message carrying its wrapped content key as stored', () => {
    expect(isStoredRow({ wrappedContentKey: 'wrapped' })).toBe(true);
  });

  it('reads a message without one as not yet stored', () => {
    expect(isStoredRow({})).toBe(false);
  });
});
