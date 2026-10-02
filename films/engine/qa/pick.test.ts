import { describe, expect, it } from 'vitest';

import { highestBy, lowestBy } from './pick.js';

const ITEMS = [
  { id: 'a', value: 3 },
  { id: 'b', value: 1 },
  { id: 'c', value: 1 },
  { id: 'd', value: 5 },
];

describe('lowestBy', () => {
  it('picks the first item with the lowest value', () => {
    expect(lowestBy(ITEMS, ({ value }) => value)?.id).toBe('b');
  });

  it('is null for no items', () => {
    expect(lowestBy([], () => 0)).toBeNull();
  });
});

describe('highestBy', () => {
  it('picks the first item with the highest value', () => {
    expect(highestBy(ITEMS, ({ value }) => value)?.id).toBe('d');
  });

  it('is null for no items', () => {
    expect(highestBy([], () => 0)).toBeNull();
  });
});
