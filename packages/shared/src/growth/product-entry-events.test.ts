import { describe, expect, it } from 'vitest';

import { PRODUCT_ENTRY_ROUTES } from './acquisition.ts';
import { productEntryEventNames } from './product-entry-events.ts';

describe('productEntryEventNames', () => {
  it('derives the link name auto-capture gives every product-entry route', () => {
    expect(productEntryEventNames(PRODUCT_ENTRY_ROUTES)).toEqual(['link:/signup', 'link:/chat']);
  });

  it('refuses a path that yields no legal event name', () => {
    expect(() => productEntryEventNames(['#'])).toThrow(/no growth event name derives/u);
  });
});
