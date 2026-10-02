import { describe, expect, it } from 'vitest';

import { purityGate } from './purity.js';

import type { EncodedFrame } from './purity.js';
import type { Raster } from './raster.js';

function raster(width: number, height: number, fill: number): Raster {
  return { width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(fill) };
}

function encoded(image: Raster, bytes: Uint8Array = Uint8Array.from(image.data)): EncodedFrame {
  return { bytes, raster: image };
}

const PURE = encoded(raster(4, 4, 20));

const SIDE = 120;
const GROUND = 20;
const FIELD = encoded(raster(SIDE, SIDE, GROUND));

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The field with every colour channel in the area set to one value. */
function patched({ x, y, width, height }: Area, value: number): EncodedFrame {
  const image = raster(SIDE, SIDE, GROUND);
  for (let row = y; row < y + height; row++) {
    image.data.fill(value, (row * SIDE + x) * 3, (row * SIDE + x + width) * 3);
  }
  return encoded(image);
}

/** The field with the first `count` pixels, row by row, raised by `levels` in every channel. */
function raisedPixels(count: number, levels: number): EncodedFrame {
  const image = raster(SIDE, SIDE, GROUND);
  image.data.fill(GROUND + levels, 0, count * 3);
  return encoded(image);
}

function judged(master: EncodedFrame): ReturnType<typeof purityGate> {
  return purityGate('film', [{ frame: 9, master, still: FIELD }]);
}

describe('purityGate', () => {
  it('passes frames whose master and still bytes are identical', () => {
    expect(purityGate('film', [{ frame: 3, master: PURE, still: PURE }]).passed).toBe(true);
  });

  it('counts the frames it compared', () => {
    expect(purityGate('film', [{ frame: 3, master: PURE, still: PURE }]).measured).toEqual([
      '1 probe frame compared: the one-tab master against a fresh-page still, allowing at most 64 differing pixels within 8 levels',
    ]);
  });

  it('fails a frame whose pixels differ, naming the film, the rule and the frame', () => {
    const drawn = raster(4, 4, 20);
    drawn.data.fill(200, 12, 24);

    expect(
      purityGate('film', [{ frame: 48, master: encoded(drawn), still: PURE }]).failures[0]
    ).toMatch(/^film: purity: frame 48: /);
  });

  it('gives the count, the largest difference and the rows of a pixel difference', () => {
    const drawn = raster(4, 4, 20);
    drawn.data.fill(200, 12, 24);

    expect(
      purityGate('film', [{ frame: 48, master: encoded(drawn), still: PURE }]).failures[0]
    ).toContain('differ in 4 pixels (largest 180, rows 1–1)');
  });

  it('gives the PSNR of a pixel difference', () => {
    const drawn = raster(4, 4, 20);
    drawn.data.fill(200, 12, 24);

    expect(
      purityGate('film', [{ frame: 48, master: encoded(drawn), still: PURE }]).failures[0]
    ).toMatch(/PSNR 9\.0 dB$/);
  });

  it('fails a frame whose sizes differ, naming both sizes', () => {
    expect(
      purityGate('film', [{ frame: 5, master: PURE, still: encoded(raster(4, 2, 20)) }]).failures[0]
    ).toBe('film: purity: frame 5: the one-tab master is 4×4 and the fresh-page still 4×2');
  });

  it('fails bytes that differ over identical pixels, which no pixel difference explains', () => {
    const image = raster(4, 4, 20);
    const reencoded = encoded(image, Uint8Array.of(1, 2, 3));

    expect(purityGate('film', [{ frame: 7, master: PURE, still: reencoded }]).failures[0]).toBe(
      'film: purity: frame 7: the PNG bytes differ while every pixel matches'
    );
  });

  it('fails every differing frame, not only the first', () => {
    const drawn = encoded(raster(4, 4, 29));

    expect(
      purityGate('film', [
        { frame: 1, master: drawn, still: PURE },
        { frame: 2, master: PURE, still: PURE },
        { frame: 3, master: drawn, still: PURE },
      ]).failures
    ).toHaveLength(2);
  });

  it('passes an 8×4 block in which every pixel is 8 levels off', () => {
    expect(judged(patched({ x: 16, y: 8, width: 8, height: 4 }, GROUND + 8)).passed).toBe(true);
  });

  it('passes a 6×6 blob 3 levels off', () => {
    expect(judged(patched({ x: 40, y: 60, width: 6, height: 6 }, GROUND - 3)).passed).toBe(true);
  });

  it('passes a single channel value 1 level off', () => {
    const image = raster(SIDE, SIDE, GROUND);
    image.data[SIDE * 3 * 50 + 31] = GROUND + 1;

    expect(judged(encoded(image)).passed).toBe(true);
  });

  it('passes 64 differing pixels 8 levels off', () => {
    expect(judged(raisedPixels(64, 8)).passed).toBe(true);
  });

  it('fails 65 differing pixels, naming the count and the largest difference', () => {
    expect(judged(raisedPixels(65, 1)).failures[0]).toMatch(
      /^film: purity: frame 9: the one-tab master and a fresh-page still differ in 65 pixels \(largest 1, /
    );
  });

  it('fails one pixel 9 levels off', () => {
    expect(judged(raisedPixels(1, 9)).failures[0]).toContain('differ in 1 pixel (largest 9, ');
  });

  it('fails a 104×104 black square', () => {
    expect(judged(patched({ x: 8, y: 8, width: 104, height: 104 }, 0)).failures[0]).toContain(
      'differ in 10816 pixels (largest 20, rows 8–111)'
    );
  });

  it('names each frame it passed with a small difference', () => {
    const small = patched({ x: 16, y: 8, width: 8, height: 4 }, GROUND + 8);

    expect(
      purityGate('film', [
        { frame: 9, master: small, still: FIELD },
        { frame: 10, master: FIELD, still: FIELD },
      ]).measured[1]
    ).toBe('passed with a small difference: frame 9 (32 pixels, largest 8)');
  });

  it('names no frame passed with a small difference when every frame matches', () => {
    expect(judged(FIELD).measured).toHaveLength(1);
  });

  it('passes identical bytes that were never decoded', () => {
    const undecoded: EncodedFrame = { bytes: PURE.bytes, raster: null };

    expect(purityGate('film', [{ frame: 3, master: undecoded, still: undecoded }]).passed).toBe(
      true
    );
  });

  it('refuses differing bytes that were not decoded, which it cannot describe', () => {
    const undecoded: EncodedFrame = { bytes: Uint8Array.of(9), raster: null };

    expect(() => purityGate('film', [{ frame: 3, master: undecoded, still: PURE }])).toThrow(
      /frame 3/
    );
  });

  it('refuses an empty comparison, which would prove nothing', () => {
    expect(() => purityGate('film', [])).toThrow(/no probe frame/);
  });
});
