import { defineFilm } from '../../../film/spec.js';
import { definition as plain } from '../engine-look-plain/film.js';

import type { FilmDefinition } from '../../../film/spec.js';

const { spec } = plain;

/**
 * The plain look with the post chain on at every effect 0: the probe's
 * control, whose frames the chain's finish moves off the pixels the look drew.
 * The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-look-finished',
    title: 'Engine look, post chain on',
    seed: spec.seed,
    grid: spec.grid,
    beats: spec.beats,
    shots: [{ id: 'field', fromBeat: 0, toBeat: spec.beats, reads: [] }],
    text: [],
    cues: [],
  }),
};
