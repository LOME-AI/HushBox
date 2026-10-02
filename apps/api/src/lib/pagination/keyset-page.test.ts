import { describe, expect, it } from 'vitest';
import { buildKeysetPage } from './keyset-page.js';

/** Rows only need an id: that is the whole contract the cursor rides on. */
function row(id: string): { readonly id: string } {
  return { id };
}

describe('buildKeysetPage', () => {
  it('returns every row and no cursor when the page came back short', () => {
    expect(buildKeysetPage([row('a'), row('b')], 5)).toEqual({
      rows: [row('a'), row('b')],
      nextCursor: null,
    });
  });

  it('returns no cursor when exactly the limit came back', () => {
    expect(buildKeysetPage([row('a'), row('b')], 2)).toEqual({
      rows: [row('a'), row('b')],
      nextCursor: null,
    });
  });

  it('drops the peeked row and cursors on the last kept row when one more came back', () => {
    expect(buildKeysetPage([row('a'), row('b'), row('c')], 2)).toEqual({
      rows: [row('a'), row('b')],
      nextCursor: 'b',
    });
  });

  it('returns an empty cursorless page when nothing came back', () => {
    expect(buildKeysetPage([], 5)).toEqual({ rows: [], nextCursor: null });
  });

  it('degrades a zero limit to an empty cursorless page', () => {
    expect(buildKeysetPage([row('a')], 0)).toEqual({ rows: [], nextCursor: null });
  });
});
