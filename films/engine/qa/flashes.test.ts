import { describe, expect, it } from 'vitest';

import { LEAD_FRAMES } from '../render/delivery-timing.js';
import { FPS } from '../time/grid.js';
import { FLASH_AREA, flashGate, frameLight, transitionsBetween } from './flashes.js';

import type { Transition } from './flashes.js';
import type { Raster } from './raster.js';

const SIZE = 10;
const PIXELS = SIZE * SIZE;

/** A 10×10 raster whose first `count` pixels are `lit` and the rest `ground`. */
function raster(
  count: number,
  lit: readonly [number, number, number],
  ground: readonly [number, number, number] = [0, 0, 0]
): Raster {
  const data = new Uint8Array(PIXELS * 3);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    data.set(pixel < count ? lit : ground, pixel * 3);
  }
  return { width: SIZE, height: SIZE, channels: 3, data };
}

const DARK = frameLight(raster(0, [0, 0, 0]));
const WHITE: [number, number, number] = [255, 255, 255];
/** The fewest of 100 pixels that reach the WCAG area. */
const AREA_PIXELS = Math.ceil(FLASH_AREA * PIXELS);

describe('FLASH_AREA', () => {
  it('is the WCAG 341×256 of 1024×768 proportion', () => {
    expect(FLASH_AREA).toBeCloseTo(0.111, 3);
  });
});

describe('transitionsBetween: general', () => {
  it('finds an upward transition when enough pixels brighten by 0.1', () => {
    expect(transitionsBetween(7, DARK, frameLight(raster(AREA_PIXELS, WHITE)))).toEqual([
      { frame: 7, kind: 'general', direction: 'up' },
    ]);
  });

  it('finds none when one pixel fewer than the area brightens', () => {
    expect(transitionsBetween(7, DARK, frameLight(raster(AREA_PIXELS - 1, WHITE)))).toEqual([]);
  });

  it('finds a downward transition when enough pixels darken', () => {
    expect(transitionsBetween(7, frameLight(raster(PIXELS, WHITE)), DARK)).toEqual([
      { frame: 7, kind: 'general', direction: 'down' },
    ]);
  });

  it('finds none when the darker state is above 0.80 relative luminance', () => {
    const bright = frameLight(raster(PIXELS, [235, 235, 235]));

    expect(transitionsBetween(1, bright, frameLight(raster(PIXELS, WHITE)))).toEqual([]);
  });

  it('counts a change of exactly 0.1 relative luminance', () => {
    // Grey 89 is 0.0999… and grey 90 is 0.1022… relative luminance, over black.
    expect(transitionsBetween(1, DARK, frameLight(raster(PIXELS, [90, 90, 90])))).toHaveLength(1);
  });

  it('finds none for a change under 0.1 relative luminance', () => {
    expect(transitionsBetween(1, DARK, frameLight(raster(PIXELS, [89, 89, 89])))).toEqual([]);
  });
});

describe('transitionsBetween: the darker state', () => {
  it('counts a change whose darker state is at 0.80 or below', () => {
    // Grey 231 is 0.7991 relative luminance; white is 1.
    const from = frameLight(raster(PIXELS, [231, 231, 231]));

    expect(transitionsBetween(1, from, frameLight(raster(PIXELS, WHITE)))).toHaveLength(1);
  });

  it('finds none when the darker state is just above 0.80', () => {
    // Grey 232 is 0.8070 relative luminance.
    const from = frameLight(raster(PIXELS, [232, 232, 232]));

    expect(transitionsBetween(1, from, frameLight(raster(PIXELS, WHITE)))).toEqual([]);
  });
});

describe('transitionsBetween: red', () => {
  it('finds a red transition into saturated red', () => {
    const red = frameLight(raster(PIXELS, [255, 0, 0]));

    expect(transitionsBetween(3, DARK, red)).toContainEqual({
      frame: 3,
      kind: 'red',
      direction: 'up',
    });
  });

  it('finds a red transition into a red at the saturation ratio', () => {
    // Green and blue 99 put red's linear share at 0.8003.
    const red = frameLight(raster(PIXELS, [255, 99, 99]));

    expect(transitionsBetween(3, DARK, red).filter(({ kind }) => kind === 'red')).toHaveLength(1);
  });

  it('finds no red transition into a red just below the saturation ratio', () => {
    // Green and blue 100 put red's linear share at 0.7969.
    const pink = frameLight(raster(PIXELS, [255, 100, 100]));

    expect(transitionsBetween(3, DARK, pink).filter(({ kind }) => kind === 'red')).toEqual([]);
  });

  it('finds a red transition whose red value changes by just over 20', () => {
    // Red 71 alone is a red value of 20.16.
    const red = frameLight(raster(PIXELS, [71, 0, 0]));

    expect(transitionsBetween(3, DARK, red).filter(({ kind }) => kind === 'red')).toHaveLength(1);
  });

  it('finds no red transition whose red value changes by under 20', () => {
    // Red 70 alone is a red value of 19.60.
    const red = frameLight(raster(PIXELS, [70, 0, 0]));

    expect(transitionsBetween(3, DARK, red).filter(({ kind }) => kind === 'red')).toEqual([]);
  });

  it('finds a red transition out of saturated red', () => {
    const red = frameLight(raster(PIXELS, [255, 0, 0]));

    expect(transitionsBetween(3, red, DARK)).toContainEqual({
      frame: 3,
      kind: 'red',
      direction: 'down',
    });
  });
});

/** Flashes of one kind: an up and a down every `period` frames from `start`, `count` times. */
function flashes(
  start: number,
  period: number,
  count: number,
  kind: Transition['kind'] = 'general'
): Transition[] {
  return Array.from({ length: count }, (_, index): Transition[] => [
    { frame: start + index * period, kind, direction: 'up' },
    { frame: start + index * period + 1, kind, direction: 'down' },
  ]).flat();
}

describe('flashGate', () => {
  it('passes three flashes within one second', () => {
    expect(flashGate('film', flashes(10, 20, 3)).passed).toBe(true);
  });

  it('fails four flashes within one second, naming the film, the rule and the frames', () => {
    const start = 10 + LEAD_FRAMES;

    expect(flashGate('film', flashes(start, 12, 4)).failures).toEqual([
      'film: flashes: frames 10–47: 4 general flashes within one second, more than 3 (WCAG 2.3.1)',
    ]);
  });

  it('passes four flashes spread over more than one second', () => {
    expect(flashGate('film', flashes(10, FPS / 3, 4)).passed).toBe(true);
  });

  it('counts red flashes apart from general ones', () => {
    const mixed = [...flashes(10, 12, 2), ...flashes(16, 12, 2, 'red')];

    expect(flashGate('film', mixed).passed).toBe(true);
  });

  it('fails four red flashes within one second, naming them red', () => {
    expect(flashGate('film', flashes(10, 12, 4, 'red')).failures[0]).toContain('4 red flashes');
  });

  it('merges repeated transitions in one direction, which are one change, not a flash each', () => {
    const creeping: Transition[] = Array.from({ length: 10 }, (_, index) => ({
      frame: 10 + index,
      kind: 'general',
      direction: 'up',
    }));

    expect(flashGate('film', creeping).passed).toBe(true);
  });

  it('reports one failure for one stretch of flashing, not one per window', () => {
    expect(flashGate('film', flashes(10, 6, 12)).failures).toHaveLength(1);
  });

  it('reports the largest count in each second measured', () => {
    expect(flashGate('film', flashes(10, 20, 3)).measured).toEqual([
      'at most 3 general and 0 red flashes in any one second',
    ]);
  });
});
