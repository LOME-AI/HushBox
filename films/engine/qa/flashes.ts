import { FPS } from '../time/grid.js';

import { at } from './at.js';
import { filmFrame } from './delivered.js';
import { gateResult } from './gate.js';
import { linearLight, linearLuminance, requireRaster } from './raster.js';

import type { GateFailure, GateResult } from './gate.js';
import type { Raster } from './raster.js';

/** WCAG 2.3.1's flash area as a share of the frame: 341×256 of a 1024×768 screen. */
export const FLASH_AREA = (341 * 256) / (1024 * 768);

/** A change in relative luminance that counts toward a general flash, on WCAG's 0–1 scale. */
const LUMINANCE_STEP = 0.1;
/** The darker state of a general flash lies at or below this relative luminance. */
const DARKER_CEILING = 0.8;
/** A saturated red's share of R + G + B, in linear light. */
const RED_SATURATION = 0.8;
/** WCAG's red scale: (R − G − B) × 320, clipped at zero. */
const RED_SCALE = 320;
/** The change in that value a red transition exceeds. */
const RED_STEP = 20;
/** More flashes than this in any one second fail. */
const MAX_FLASHES = 3;

/** Per pixel: relative luminance, WCAG's red value, and whether the colour is a saturated red. */
export interface FrameLight {
  luminance: Float32Array;
  red: Float32Array;
  saturated: Uint8Array;
}

/** A frame-to-frame change over the flash area: at the later of the two delivered frames. */
export interface Transition {
  frame: number;
  kind: 'general' | 'red';
  direction: 'up' | 'down';
}

/** What the flash rules read of each pixel of a decoded frame. */
export function frameLight(raster: Raster): FrameLight {
  requireRaster(raster);
  const { width, height, channels, data } = raster;
  const pixels = width * height;
  const light: FrameLight = {
    luminance: new Float32Array(pixels),
    red: new Float32Array(pixels),
    saturated: new Uint8Array(pixels),
  };
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * channels;
    const r = linearLight(at(data, offset));
    const g = linearLight(at(data, offset + 1));
    const b = linearLight(at(data, offset + 2));
    const sum = r + g + b;
    light.luminance[pixel] = linearLuminance(r, g, b);
    light.red[pixel] = Math.max(0, (r - g - b) * RED_SCALE);
    light.saturated[pixel] = sum > 0 && r / sum >= RED_SATURATION ? 1 : 0;
  }
  return light;
}

interface Counts {
  up: number;
  down: number;
}

function generalCounts(previous: FrameLight, next: FrameLight): Counts {
  const counts: Counts = { up: 0, down: 0 };
  for (let pixel = 0; pixel < next.luminance.length; pixel++) {
    const before = at(previous.luminance, pixel);
    const after = at(next.luminance, pixel);
    if (Math.min(before, after) <= DARKER_CEILING) {
      if (after - before >= LUMINANCE_STEP) {
        counts.up += 1;
      } else if (before - after >= LUMINANCE_STEP) {
        counts.down += 1;
      }
    }
  }
  return counts;
}

function redCounts(previous: FrameLight, next: FrameLight): Counts {
  const counts: Counts = { up: 0, down: 0 };
  for (let pixel = 0; pixel < next.red.length; pixel++) {
    if (at(previous.saturated, pixel) + at(next.saturated, pixel) > 0) {
      const change = at(next.red, pixel) - at(previous.red, pixel);
      if (change > RED_STEP) {
        counts.up += 1;
      } else if (-change > RED_STEP) {
        counts.down += 1;
      }
    }
  }
  return counts;
}

/**
 * The transitions from one decoded frame to the next: general where pixels over
 * the flash area change relative luminance by at least 0.1 with the darker state
 * at or below 0.80, red where they change WCAG's saturated-red value by more
 * than 20. `frame` is the later frame's delivered index.
 */
export function transitionsBetween(
  frame: number,
  previous: FrameLight,
  next: FrameLight
): Transition[] {
  const area = FLASH_AREA * next.luminance.length;
  const transitions: Transition[] = [];
  for (const [kind, counts] of [
    ['general', generalCounts(previous, next)],
    ['red', redCounts(previous, next)],
  ] as const) {
    if (counts.up >= area) {
      transitions.push({ frame, kind, direction: 'up' });
    }
    if (counts.down >= area) {
      transitions.push({ frame, kind, direction: 'down' });
    }
  }
  return transitions;
}

/** One kind's transitions in frame order, each run of one direction kept as its first. */
function alternating(transitions: readonly Transition[], kind: Transition['kind']): Transition[] {
  const kept: Transition[] = [];
  for (const transition of transitions.filter((candidate) => candidate.kind === kind)) {
    if (kept.at(-1)?.direction !== transition.direction) {
      kept.push(transition);
    }
  }
  return kept;
}

function kindFailures(
  filmId: string,
  transitions: readonly Transition[],
  kind: Transition['kind']
): { failures: GateFailure[]; most: number } {
  const changes = alternating(transitions, kind);
  const failures: GateFailure[] = [];
  let most = 0;
  let resume = 0;
  for (const [index, { frame: start }] of changes.entries()) {
    const inside = changes.slice(index).filter(({ frame }) => frame < start + FPS);
    const count = Math.floor(inside.length / 2);
    most = Math.max(most, count);
    if (count > MAX_FLASHES && start >= resume) {
      const end = Math.max(...inside.map(({ frame }) => frame));
      resume = start + FPS;
      failures.push({
        filmId,
        rule: 'flashes',
        at: `frames ${String(filmFrame(start))}–${String(filmFrame(end))}`,
        detail: `${String(count)} ${kind} flashes within one second, more than ${String(MAX_FLASHES)} (WCAG 2.3.1)`,
      });
    }
  }
  return { failures, most };
}

/**
 * WCAG 2.3.1 over every decoded frame: a flash is a pair of opposing
 * transitions, and no one-second window holds more than three, general and red
 * counted apart. A failure names the film frames of the flashing stretch.
 */
export function flashGate(filmId: string, transitions: readonly Transition[]): GateResult {
  const general = kindFailures(filmId, transitions, 'general');
  const red = kindFailures(filmId, transitions, 'red');
  return gateResult(
    'flashes',
    [...general.failures, ...red.failures],
    [
      `at most ${String(general.most)} general and ${String(red.most)} red flashes in any one second`,
    ]
  );
}
