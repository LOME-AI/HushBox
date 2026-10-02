import { describe, it, expect } from 'vitest';
import { shouldMinify } from '../../../vite.config';

// The mode, derived in the configuration, selects the frontend env file this
// app builds against, and on this app it also decides `build.minify`. One
// value, two jobs: what points a build at the end-to-end env file is what would
// otherwise start minifying it, so the second job is pinned here apart from the
// first.
describe('the web build and its minifier', () => {
  it('leaves the development build readable', () => {
    expect(shouldMinify('development', false)).toBe(false);
  });

  it('leaves an end-to-end build readable, whatever mode name carried its env', () => {
    expect(shouldMinify('e2e', true)).toBe(false);
  });

  it('minifies every other build', () => {
    expect(shouldMinify('production', false)).toBe(true);
  });
});
