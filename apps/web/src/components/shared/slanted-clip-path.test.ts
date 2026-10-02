import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SLANTED_CLIP_PATH } from './slanted-clip-path';

interface Box {
  width: number;
  height: number;
}

type Point = readonly [number, number];

// The shape the slanted buttons have always painted: the top-right corner cut to 95% along the bottom.
const RESTING_SLANT = 'polygon(0 0, 100% 0, 95% 100%, 0 100%)';

// The widest focus paint the app draws: the accessibility widget's halo, a 4px spread plus a 12px blur.
const FOCUS_PAINT_REACH_PX = 16;

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function resolveLength(token: string, basis: number): number {
  const calc = /^calc\((.+) ([+-]) (.+)\)$/.exec(token);
  if (calc) {
    const [, left = '', operator, right = ''] = calc;
    const sum = resolveLength(left, basis);
    const term = resolveLength(right, basis);
    return operator === '+' ? sum + term : sum - term;
  }
  if (token === '0') return 0;
  if (token.endsWith('%')) return (Number.parseFloat(token) / 100) * basis;
  if (token.endsWith('px')) return Number.parseFloat(token);
  throw new Error(`Unsupported polygon length: ${token}`);
}

function resolvePolygon(clipPath: string, box: Box): Point[] {
  const body = /^polygon\((.*)\)$/.exec(clipPath)?.[1];
  if (body === undefined) throw new Error(`Not a polygon: ${clipPath}`);
  return splitTopLevel(body, ',').map((vertex) => {
    const [x = '', y = ''] = splitTopLevel(vertex, ' ');
    return [resolveLength(x, box.width), resolveLength(y, box.height)];
  });
}

function contains(polygon: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [xi, yi] = polygon[index] ?? [0, 0];
    const [xj, yj] = polygon[previous] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Integer boxes from a collapsed icon button up to a full-width form button. Every sampled
// point is a pixel centre, where rasterisation samples, so none lies on a box edge.
const boxArbitrary = fc.record({
  width: fc.integer({ min: 24, max: 1200 }),
  height: fc.integer({ min: 24, max: 120 }),
});

const reachArbitrary = fc.integer({ min: 0, max: FOCUS_PAINT_REACH_PX - 1 });

const centre = (pixel: number): number => pixel + 0.5;

describe('SLANTED_CLIP_PATH', () => {
  it('paints the resting slant at every pixel centre inside the box', () => {
    const pixelInBox = boxArbitrary.chain((box) =>
      fc.tuple(
        fc.constant(box),
        fc.integer({ min: 0, max: box.width - 1 }),
        fc.integer({ min: 0, max: box.height - 1 })
      )
    );
    fc.assert(
      fc.property(pixelInBox, ([box, column, row]) => {
        const point: Point = [centre(column), centre(row)];
        expect(contains(resolvePolygon(SLANTED_CLIP_PATH, box), point)).toBe(
          contains(resolvePolygon(RESTING_SLANT, box), point)
        );
      })
    );
  });

  it('reaches past the top edge by the widest focus paint', () => {
    const pixelAboveBox = boxArbitrary.chain((box) =>
      fc.tuple(fc.constant(box), fc.integer({ min: 0, max: box.width - 1 }), reachArbitrary)
    );
    fc.assert(
      fc.property(pixelAboveBox, ([box, column, ring]) => {
        const point: Point = [centre(column), -centre(ring)];
        expect(contains(resolvePolygon(SLANTED_CLIP_PATH, box), point)).toBe(true);
      })
    );
  });

  it('reaches past the left edge by the widest focus paint', () => {
    const pixelLeftOfBox = boxArbitrary.chain((box) =>
      fc.tuple(
        fc.constant(box),
        reachArbitrary,
        fc.integer({ min: -FOCUS_PAINT_REACH_PX, max: box.height + FOCUS_PAINT_REACH_PX - 1 })
      )
    );
    fc.assert(
      fc.property(pixelLeftOfBox, ([box, ring, row]) => {
        const point: Point = [-centre(ring), centre(row)];
        expect(contains(resolvePolygon(SLANTED_CLIP_PATH, box), point)).toBe(true);
      })
    );
  });

  it('reaches past the bottom edge by the widest focus paint up to the foot of the slant', () => {
    const pixelBelowBox = boxArbitrary.chain((box) =>
      fc.tuple(
        fc.constant(box),
        fc.integer({ min: 0, max: Math.floor(0.95 * box.width) - 1 }),
        reachArbitrary
      )
    );
    fc.assert(
      fc.property(pixelBelowBox, ([box, column, ring]) => {
        const point: Point = [centre(column), box.height + centre(ring)];
        expect(contains(resolvePolygon(SLANTED_CLIP_PATH, box), point)).toBe(true);
      })
    );
  });

  it('keeps the slanted side clipped at the box edge', () => {
    const rowOfBox = boxArbitrary.chain((box) =>
      fc.tuple(fc.constant(box), fc.integer({ min: 0, max: box.height - 1 }))
    );
    fc.assert(
      fc.property(rowOfBox, ([box, row]) => {
        const point: Point = [centre(box.width), centre(row)];
        expect(contains(resolvePolygon(SLANTED_CLIP_PATH, box), point)).toBe(false);
      })
    );
  });
});
