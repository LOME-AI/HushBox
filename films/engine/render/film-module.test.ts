import { describe, expect, it } from 'vitest';

import { defineFilm } from '../film/spec.js';

import { FilmRenderError } from './film-error.js';
import { UnknownFilmError, filmDefinitionOf, findFilm } from './film-module.js';

import type { DiscoveredFilm } from '../film/discover.js';
import type { FilmDefinition } from '../film/spec.js';

const DEFINITION: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-render',
    title: 'Engine render',
    seed: 'engine-render',
    grid: { framesPerBeat: 24, beatsPerBar: 4 },
    beats: 4,
    shots: [{ id: 'all', fromBeat: 0, toBeat: 4, reads: [] }],
    text: [],
    cues: [],
  }),
  score: { tracks: [], buses: [] },
};

const FILMS: DiscoveredFilm[] = [
  { id: 'engine-empty', dir: 'engine/fixtures/engine-empty' },
  { id: 'engine-render', dir: 'engine/fixtures/engine-render' },
];

/** The spec with one of its fields left out. */
function specWithout(field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(DEFINITION.spec).filter(([key]) => key !== field));
}

function refusal(exports: unknown): unknown {
  try {
    filmDefinitionOf('engine-render', exports);
  } catch (error) {
    return error;
  }
  return null;
}

describe('filmDefinitionOf', () => {
  it('returns the definition a film module exports', () => {
    expect(filmDefinitionOf('engine-render', { definition: DEFINITION })).toBe(DEFINITION);
  });

  it('accepts a definition with no score', () => {
    const scoreless: FilmDefinition = { spec: DEFINITION.spec };

    expect(filmDefinitionOf('engine-render', { definition: scoreless })).toBe(scoreless);
  });

  it('refuses a module that exports no definition, naming the film', () => {
    expect(refusal({})).toHaveProperty(
      'message',
      expect.stringMatching(/^engine-render: film: film\.ts must export a definition/)
    );
  });

  it('refuses a definition whose spec has no shots', () => {
    expect(refusal({ definition: { spec: specWithout('shots') } })).toBeInstanceOf(FilmRenderError);
  });

  it('refuses a definition whose spec has no cues', () => {
    expect(refusal({ definition: { spec: specWithout('cues') } })).toBeInstanceOf(FilmRenderError);
  });

  it('refuses a score that is not an object', () => {
    expect(refusal({ definition: { ...DEFINITION, score: 'loud' } })).toBeInstanceOf(
      FilmRenderError
    );
  });

  it('refuses a spec whose id is not the film asked for', () => {
    expect(refusal({ definition: { spec: { ...DEFINITION.spec, id: 'other' } } })).toHaveProperty(
      'message',
      'engine-render: film: film.ts declares spec id "other"'
    );
  });
});

describe('findFilm', () => {
  it('finds a film by its id', () => {
    expect(findFilm(FILMS, 'engine-render')).toBe(FILMS[1]);
  });

  it('refuses an unknown id, naming every known id', () => {
    expect(() => findFilm(FILMS, 'engine-rendr')).toThrow(
      'engine-rendr: film: no film or engine fixture has this id; known ids: engine-empty, engine-render'
    );
  });

  it('refuses an unknown id as an unknown film', () => {
    expect(() => findFilm(FILMS, 'engine-rendr')).toThrow(UnknownFilmError);
  });
});
