import { describe, expect, it } from 'vitest';

import { contrastRatio, parseCssColor, relativeLuminance } from './contrast.ts';

describe('parseCssColor', () => {
  it('parses a six-digit hex colour into 0-255 channels', () => {
    expect(parseCssColor('#336699')).toEqual([0x33, 0x66, 0x99]);
  });

  it('parses uppercase hex', () => {
    expect(parseCssColor('#AABBCC')).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('parses a space-separated hsl colour', () => {
    expect(parseCssColor('hsl(0 100% 50%)')).toEqual([255, 0, 0]);
  });

  it('parses a fractional hue', () => {
    const [r, g, b] = parseCssColor('hsl(120.5 100% 50%)');
    expect(r).toBe(0);
    expect(g).toBe(255);
    expect(b).toBeCloseTo(2.125, 3);
  });

  it('parses an achromatic hsl colour', () => {
    expect(parseCssColor('hsl(210 0% 40%)')).toEqual([102, 102, 102]);
  });

  it.each([
    ['hsl(240 100% 50%)', [0, 0, 255]],
    ['hsl(60 100% 50%)', [255, 255, 0]],
    ['hsl(180 100% 50%)', [0, 255, 255]],
    ['hsl(300 100% 50%)', [255, 0, 255]],
  ])('parses %s across the hue wheel', (input, expected) => {
    expect(parseCssColor(input)).toEqual(expected);
  });

  it('parses a hue past a full turn the same as its wrapped equivalent', () => {
    const [r, g, b] = parseCssColor('hsl(400 100% 50%)');
    const [wr, wg, wb] = parseCssColor('hsl(40 100% 50%)');
    expect(r).toBeCloseTo(wr, 10);
    expect(g).toBeCloseTo(wg, 10);
    expect(b).toBeCloseTo(wb, 10);
  });

  it.each([-30, -60, -90, -120, -180, -270])('rejects the negative hue %i', (hue) => {
    expect(() => parseCssColor(`hsl(${String(hue)} 100% 50%)`)).toThrow(/unsupported/i);
  });

  it('rejects a colour format it does not support', () => {
    expect(() => parseCssColor('rgb(1, 2, 3)')).toThrow(/unsupported/i);
  });

  it('rejects three-digit hex shorthand', () => {
    expect(() => parseCssColor('#369')).toThrow(/unsupported/i);
  });
});

describe('relativeLuminance', () => {
  it('is 1 for white', () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });

  it('is 0 for black', () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 10);
  });

  it('weights green above red above blue', () => {
    const red = relativeLuminance([255, 0, 0]);
    const green = relativeLuminance([0, 255, 0]);
    const blue = relativeLuminance([0, 0, 255]);
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });

  it('uses the linear segment below the sRGB knee', () => {
    // 10/255 = 0.0392, under the 0.04045 threshold, so the linear branch applies.
    expect(relativeLuminance([10, 10, 10])).toBeCloseTo(10 / 255 / 12.92, 10);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 10);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio([18, 52, 86], [18, 52, 86])).toBeCloseTo(1, 10);
  });

  it('does not depend on which colour is the foreground', () => {
    const forward = contrastRatio([255, 255, 255], [0, 0, 0]);
    const reverse = contrastRatio([0, 0, 0], [255, 255, 255]);
    expect(forward).toBe(reverse);
  });
});
