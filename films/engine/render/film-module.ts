import { z } from 'zod';

import { FilmRenderError } from './film-error.js';

import type { DiscoveredFilm } from '../film/discover.js';
import type { FilmDefinition } from '../film/spec.js';

/** A film id no film or engine fixture under the package declares. */
export class UnknownFilmError extends FilmRenderError {
  constructor(filmId: string, knownIds: readonly string[]) {
    super({
      filmId,
      rule: 'film',
      detail: `no film or engine fixture has this id; known ids: ${knownIds.join(', ')}`,
    });
    this.name = 'UnknownFilmError';
  }
}

/** The parts of a film definition the render pipeline reads before `defineScore` checks the score. */
const readShape = z.object({
  spec: z.object({
    id: z.string(),
    durationInFrames: z.int().positive(),
    shots: z.array(z.object({ from: z.int(), to: z.int() })),
    cues: z.array(z.object({ id: z.string(), from: z.int() })),
  }),
  score: z.object({}).optional(),
});

/**
 * A loaded `film.ts` crosses an untyped boundary, so its export is checked for
 * the shape the pipeline reads. The rest of `FilmSpec` holds by construction:
 * the spec is `defineFilm`'s output, and `definition` is typed `FilmDefinition`
 * where the film declares it.
 */
const filmModuleSchema = z.object({
  definition: z.custom<FilmDefinition>((value) => readShape.safeParse(value).success),
});

/** The `definition` a film's module exports, refused naming the film when it has none. */
export function filmDefinitionOf(filmId: string, exports: unknown): FilmDefinition {
  const parsed = filmModuleSchema.safeParse(exports);
  if (!parsed.success) {
    throw new FilmRenderError({
      filmId,
      rule: 'film',
      detail:
        'film.ts must export a definition whose spec has an id, a durationInFrames, shots and cues in frames, and whose score, if any, is an object',
    });
  }
  const { definition } = parsed.data;
  if (definition.spec.id !== filmId) {
    throw new FilmRenderError({
      filmId,
      rule: 'film',
      detail: `film.ts declares spec id ${JSON.stringify(definition.spec.id)}`,
    });
  }
  return definition;
}

/** The discovered film with this id, refused as an unknown film naming every known id. */
export function findFilm(films: readonly DiscoveredFilm[], filmId: string): DiscoveredFilm {
  const film = films.find(({ id }) => id === filmId);
  if (film === undefined) {
    throw new UnknownFilmError(
      filmId,
      films.map(({ id }) => id)
    );
  }
  return film;
}
