import { describe, it, expect } from 'vitest';
import { joinWithAnd } from '@/lib/utils/join-with-and';

describe('joinWithAnd', () => {
  it('is empty for no items', () => {
    expect(joinWithAnd([])).toBe('');
  });

  it('gives a single item alone', () => {
    expect(joinWithAnd(['Bob'])).toBe('Bob');
  });

  it('joins two items with "and"', () => {
    expect(joinWithAnd(['Bob', 'Charlie'])).toBe('Bob and Charlie');
  });

  it('joins three or more items with commas before a final "and", with no serial comma', () => {
    expect(joinWithAnd(['Bob', 'Charlie', 'Dana', 'Eun-ji'])).toBe('Bob, Charlie, Dana and Eun-ji');
  });
});
