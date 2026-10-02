import { describe, expect, it } from 'vitest';

import { blankImage } from './image.js';

describe('blankImage', () => {
  it('holds one byte per pixel, all zero', () => {
    const image = blankImage({ width: 3, height: 2 }, 1);
    expect(image).toEqual({ width: 3, height: 2, pixels: new Uint8Array(6) });
  });

  it('accepts the minimum width and height', () => {
    expect(blankImage({ width: 1, height: 2 }, 2).pixels).toHaveLength(2);
  });

  it('refuses a width one below the minimum', () => {
    expect(() => blankImage({ width: 0, height: 2 }, 1)).toThrow(/width 0/);
  });

  it('refuses a height one below the minimum', () => {
    expect(() => blankImage({ width: 4, height: 1 }, 2)).toThrow(/height 1/);
  });

  it('refuses a fractional size', () => {
    expect(() => blankImage({ width: 2.5, height: 2 }, 1)).toThrow(/2\.5/);
  });
});
