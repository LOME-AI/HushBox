import { describe, expect, it } from 'vitest';

import { PRODUCT_TAGLINE, PRODUCT_TAGLINE_SENTENCES } from './tagline.ts';

describe('product tagline', () => {
  it('lists its three sentences in order', () => {
    expect(PRODUCT_TAGLINE_SENTENCES).toEqual(['One interface.', 'Every feature.', 'Private.']);
  });

  it('reads as the sentences joined by one space', () => {
    expect(PRODUCT_TAGLINE).toBe('One interface. Every feature. Private.');
  });
});
