import { createRequire } from 'node:module';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { logoMask, logoPathData, traceLogo } from './logo.js';

import type { LogoPart, LogoPixels } from './logo.js';

/** RGBA pixels from rows of alpha values, every pixel the same red. */
function pixels(rows: readonly (readonly number[])[]): LogoPixels {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [y, row] of rows.entries()) {
    for (const [x, alpha] of row.entries()) {
      data.set([236, 71, 85, alpha], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const LOGO_FILE = createRequire(import.meta.url).resolve('@hushbox/ui/assets/HushBoxLogo.png');

async function decodeLogo(): Promise<LogoPixels> {
  const { data, info } = await sharp(LOGO_FILE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Whether each pixel is at or above half alpha. */
function opaqueSet({ width, height, data }: LogoPixels): boolean[] {
  return Array.from({ length: width * height }, (_, index) => (data[index * 4 + 3] ?? 0) >= 128);
}

/**
 * The outlines filled at a scale by librsvg, sampling each pixel at its centre
 * (`crispEdges`): a rasterizer independent of the tracer.
 */
async function rasterize(
  outlines: readonly LogoPart['outline'][],
  { width, height }: LogoPixels,
  scale: number
): Promise<LogoPixels> {
  const d = outlines
    .map((outline) => logoPathData(outline.map(({ x, y }) => ({ x: x * scale, y: y * scale }))))
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width * scale)}" height="${String(height * scale)}" shape-rendering="crispEdges"><path d="${d}"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function iou(a: readonly boolean[], b: readonly boolean[]): number {
  let both = 0;
  let either = 0;
  for (const [index, inA] of a.entries()) {
    const inB = b[index] ?? false;
    both += inA && inB ? 1 : 0;
    either += inA || inB ? 1 : 0;
  }
  return both / either;
}

/** The opaque pixels edge-connected to `start`, marking each as seen. */
function shapeFrom(
  start: number,
  opaque: readonly boolean[],
  width: number,
  seen: Set<number>
): Set<number> {
  const shape = new Set([start]);
  const queue = [start];
  seen.add(start);
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    const x = at % width;
    const neighbours = [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, at - width, at + width];
    for (const neighbour of neighbours.filter(
      (index) => opaque[index] === true && !seen.has(index)
    )) {
      seen.add(neighbour);
      shape.add(neighbour);
      queue.push(neighbour);
    }
  }
  return shape;
}

/** Each edge-connected shape of the opaque pixels, as the set of its pixel indices, in raster order. */
function shapes(opaque: readonly boolean[], width: number): Set<number>[] {
  const seen = new Set<number>();
  const found: Set<number>[] = [];
  for (const [start, isOpaque] of opaque.entries()) {
    if (isOpaque && !seen.has(start)) {
      found.push(shapeFrom(start, opaque, width, seen));
    }
  }
  return found;
}

/** Outlines moved one pixel to the right. */
function shiftedRight(outlines: readonly LogoPart['outline'][]): LogoPart['outline'][] {
  return outlines.map((outline) => outline.map(({ x, y }) => ({ x: x + 1, y })));
}

function indicesOf(set: readonly boolean[]): Set<number> {
  return new Set(set.flatMap((inside, index) => (inside ? [index] : [])));
}

describe('traceLogo', () => {
  it('traces one opaque pixel as one part through the midpoints of its sides', () => {
    const parts = traceLogo(pixels([[255]]));

    expect(parts).toHaveLength(1);
    expect(parts[0]?.area).toBe(0.5);
  });

  it('runs the contour where alpha crosses half, between two pixel centres', () => {
    const [part] = traceLogo(pixels([[170, 0]]));

    expect(Math.max(...(part?.outline.map(({ x }) => x) ?? []))).toBe(0.75);
  });

  it('counts a pixel at half alpha as inside the mark', () => {
    expect(traceLogo(pixels([[128]]))).toHaveLength(1);
  });

  it('counts a pixel just under half alpha as outside the mark', () => {
    expect(traceLogo(pixels([[127]]))).toEqual([]);
  });

  it('keeps the shape on the left of its outline as y runs down', () => {
    const [part] = traceLogo(pixels([[255]]));

    expect(part?.outline).toEqual([
      { x: 0.5, y: 0 },
      { x: 0, y: 0.5 },
      { x: 0.5, y: 1 },
      { x: 1, y: 0.5 },
    ]);
  });

  it('splits shapes that do not touch into parts in the order a raster scan meets them', () => {
    const parts = traceLogo(
      pixels([
        [0, 0, 0, 255],
        [0, 0, 0, 0],
        [255, 255, 0, 0],
      ])
    );

    expect(parts.map(({ area }) => area)).toEqual([0.5, 1.5]);
  });

  it('keeps pixels that touch only at a corner in separate parts', () => {
    expect(
      traceLogo(
        pixels([
          [255, 0],
          [0, 255],
        ])
      )
    ).toHaveLength(2);
  });

  it('joins pixels that touch only at a corner when the alpha between them averages above half', () => {
    expect(
      traceLogo(
        pixels([
          [255, 100],
          [100, 255],
        ])
      )
    ).toHaveLength(1);
  });

  it('refuses a shape with a hole, naming where the hole is', () => {
    expect(() =>
      traceLogo(
        pixels([
          [255, 255, 255],
          [255, 0, 255],
          [255, 255, 255],
        ])
      )
    ).toThrow(/has a hole at \([\d.]+, [\d.]+\)/);
  });

  it('refuses pixel data that is not four bytes for each pixel of its size', () => {
    expect(() => traceLogo({ width: 2, height: 2, data: new Uint8ClampedArray(12) })).toThrow(
      /2×2 .*16 bytes, got 12/
    );
  });
});

describe('logoMask', () => {
  it('marks each pixel inside the mark with 1 and each outside with 0, row by row', () => {
    expect([
      ...logoMask(
        pixels([
          [0, 255],
          [255, 0],
        ])
      ),
    ]).toEqual([0, 1, 1, 0]);
  });

  it('counts a pixel at half alpha as inside the mark', () => {
    expect([...logoMask(pixels([[128]]))]).toEqual([1]);
  });

  it('counts a pixel just under half alpha as outside the mark', () => {
    expect([...logoMask(pixels([[127]]))]).toEqual([0]);
  });

  it('refuses pixel data that is not four bytes for each pixel of its size', () => {
    expect(() => logoMask({ width: 2, height: 2, data: new Uint8ClampedArray(12) })).toThrow(
      /2×2 .*16 bytes, got 12/
    );
  });
});

describe('logoPathData', () => {
  it('writes an outline as one closed SVG subpath', () => {
    expect(
      logoPathData([
        { x: 0, y: 0.5 },
        { x: 1.25, y: 2 },
      ])
    ).toBe('M0 0.5L1.25 2Z');
  });
});

describe('the brand logo file', () => {
  it('traces into one part for each connected shape of its opaque pixels', async () => {
    const logo = await decodeLogo();
    const parts = traceLogo(logo);

    expect(parts).toHaveLength(shapes(opaqueSet(logo), logo.width).length);
  });

  it('traces each part onto exactly the pixels of one connected shape', async () => {
    const logo = await decodeLogo();
    const expected = shapes(opaqueSet(logo), logo.width);
    const drawn = await Promise.all(
      traceLogo(logo).map(async ({ outline }) =>
        indicesOf(opaqueSet(await rasterize([outline], logo, 1)))
      )
    );

    expect(drawn).toEqual(expected);
  });

  it('fills the file’s opaque pixels to at least 0.995 IoU at the file’s size', async () => {
    const logo = await decodeLogo();
    const outlines = traceLogo(logo).map(({ outline }) => outline);

    expect(
      iou(opaqueSet(await rasterize(outlines, logo, 1)), opaqueSet(logo))
    ).toBeGreaterThanOrEqual(0.995);
  });

  it('falls below 0.995 IoU when the mark is moved by one pixel', async () => {
    const logo = await decodeLogo();
    const shifted = shiftedRight(traceLogo(logo).map(({ outline }) => outline));

    expect(iou(opaqueSet(await rasterize(shifted, logo, 1)), opaqueSet(logo))).toBeLessThan(0.995);
  });
});
