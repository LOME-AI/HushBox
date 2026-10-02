import { definition as engineRender } from '../engine-render/film.js';
import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';

const { spec: base, score } = engineRender;

if (score === undefined) {
  throw new Error('engine-logo: engine-render declares no score for the fixture to share');
}

/** One bar of the grid, in frames. */
export const BAR_FRAMES = base.grid.framesPerBeat * base.grid.beatsPerBar;

/** The frame from which every part of the traced mark rests where the logo file has it. */
export const SETTLE_FRAME = base.grid.framesPerBeat * 8;

/**
 * The brand logo in a look's context: the decoded file drawn at 1:1, and the
 * mark traced from it flying together part by part until it rests on the file's
 * own shape. It takes engine-render's grid and click track, each click a tick.
 * The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-logo',
    title: 'Engine logo',
    seed: 'engine-logo',
    grid: base.grid,
    beats: base.beats,
    shots: [{ id: 'mark', fromBeat: 0, toBeat: base.beats, reads: [] }],
    text: [],
    cues: base.cues.map(({ id, beat, anchor }) => ({ id, beat, kind: 'tick' as const, anchor })),
  }),
  score,
};
