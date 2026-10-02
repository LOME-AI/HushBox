import { definition as engineRender } from '../engine-render/film.js';
import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';

const { spec: base, score } = engineRender;

if (score === undefined) {
  throw new Error('engine-logo-rest: engine-render declares no score for the fixture to share');
}

/** One bar of the grid, in frames: each of the fixture's first two sections lasts one. */
export const BAR_FRAMES = base.grid.framesPerBeat * base.grid.beatsPerBar;

/** The frame the traced parts start flying in on. */
export const FLIGHT_FRAME = BAR_FRAMES * 2;

/** The frame from which the flown-in parts rest on the file's own shape. */
export const SETTLE_FRAME = FLIGHT_FRAME + base.grid.framesPerBeat * 3;

/**
 * The brand logo at rest, reported where it rests: the file drawn at 1:1 for a
 * bar, at 2× over a gradient for a bar, then the traced parts flying in and
 * resting at 2×. It takes engine-render's grid and click track, each click a
 * tick. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-logo-rest',
    title: 'Engine logo at rest',
    seed: 'engine-logo-rest',
    grid: base.grid,
    beats: base.beats,
    shots: [{ id: 'mark', fromBeat: 0, toBeat: base.beats, reads: [] }],
    text: [],
    cues: base.cues.map(({ id, beat, anchor }) => ({ id, beat, kind: 'tick' as const, anchor })),
  }),
  score,
};
