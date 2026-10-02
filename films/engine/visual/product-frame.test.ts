import { describe, expect, it } from 'vitest';

import { ProductFrame } from './product-frame.js';

// The guard runs at the component's entry, before any hook, so a direct call
// reaches it without a renderer; a finite scale is proven by the fixture's renders.
describe('ProductFrame', () => {
  it('refuses a NaN scale, naming the input', () => {
    expect(() => ProductFrame({ scale: Number.NaN, children: null })).toThrow(
      'ProductFrame scale must be a finite number, got NaN'
    );
  });

  it('refuses a positive infinite scale, naming the input', () => {
    expect(() => ProductFrame({ scale: Number.POSITIVE_INFINITY, children: null })).toThrow(
      'ProductFrame scale must be a finite number, got Infinity'
    );
  });

  it('refuses a negative infinite scale, naming the input', () => {
    expect(() => ProductFrame({ scale: Number.NEGATIVE_INFINITY, children: null })).toThrow(
      'ProductFrame scale must be a finite number, got -Infinity'
    );
  });
});
