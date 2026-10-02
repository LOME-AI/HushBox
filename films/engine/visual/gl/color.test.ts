import { describe, expect, it } from 'vitest';

import { isHexColor, linearColor, srgbToLinear } from './color.js';

describe('srgbToLinear', () => {
  it('keeps black black', () => {
    expect(srgbToLinear(0)).toBe(0);
  });

  it('keeps white white', () => {
    expect(srgbToLinear(1)).toBe(1);
  });

  it('follows the straight segment below the sRGB knee', () => {
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
  });

  it('follows the power segment above the sRGB knee', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214_041_140_5, 9);
  });
});

describe('isHexColor', () => {
  it.each(['#abc', '#abcd', '#aabbcc', '#aabbccdd', ' #AABBCC '])('reads %s as hex', (css) => {
    expect(isHexColor(css)).toBe(true);
  });

  it.each(['red', '#12345', 'rgb(0, 0, 0)', '#ggg'])('does not read %s as hex', (css) => {
    expect(isHexColor(css)).toBe(false);
  });
});

describe('linearColor', () => {
  it('reads a six-digit hex colour as opaque linear light', () => {
    const [r, g, b, a] = linearColor('#3a6ea5');
    expect(r).toBeCloseTo(srgbToLinear(0x3a / 255), 12);
    expect(g).toBeCloseTo(srgbToLinear(0x6e / 255), 12);
    expect(b).toBeCloseTo(srgbToLinear(0xa5 / 255), 12);
    expect(a).toBe(1);
  });

  it('reads an eight-digit hex colour with its alpha left unconverted', () => {
    expect(linearColor('#ffffff80')).toEqual([1, 1, 1, 0x80 / 255]);
  });

  it('reads a three-digit hex colour by doubling each digit', () => {
    expect(linearColor('#f00')).toEqual(linearColor('#ff0000'));
  });

  it('reads a four-digit hex colour by doubling each digit', () => {
    expect(linearColor('#f008')).toEqual(linearColor('#ff000088'));
  });

  it('ignores surrounding whitespace and letter case', () => {
    expect(linearColor('  #3A6EA5 ')).toEqual(linearColor('#3a6ea5'));
  });

  it('refuses a colour that is not hex, naming it', () => {
    expect(() => linearColor('rebeccapurple')).toThrow(/rebeccapurple/);
  });

  it('refuses a hex colour of the wrong length', () => {
    expect(() => linearColor('#12345')).toThrow(/#12345/);
  });
});
