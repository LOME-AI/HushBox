import { describe, expect, it } from 'vitest';

import { defineFilm } from '../film/spec.js';
import { FilmRenderError } from '../render/film-error.js';
import { takeDefinitionOf } from './take-definition.js';

import type { FilmDefinition } from '../film/spec.js';

const TAKE = 'my-film--rounds--01--ink';

function scoreModule(): { definition: FilmDefinition } {
  return {
    definition: {
      spec: defineFilm({
        id: 'ink',
        title: 'Ink',
        seed: 'ink',
        grid: { framesPerBeat: 24, beatsPerBar: 4 },
        beats: 4,
        text: [],
        cues: [],
      }),
    },
  };
}

describe('takeDefinitionOf', () => {
  it('reads the definition a take score exports, whatever its spec id', () => {
    const exports = scoreModule();

    expect(takeDefinitionOf(TAKE, exports)).toBe(exports.definition);
  });

  it('refuses a module with no definition, naming the take', () => {
    expect(() => takeDefinitionOf(TAKE, {})).toThrow(FilmRenderError);
    expect(() => takeDefinitionOf(TAKE, {})).toThrow(`${TAKE}: take:`);
  });

  it('refuses a definition whose spec has no frames, naming the take', () => {
    const exports = { definition: { spec: { id: 'ink' } } };

    expect(() => takeDefinitionOf(TAKE, exports)).toThrow(`${TAKE}: take:`);
  });
});
