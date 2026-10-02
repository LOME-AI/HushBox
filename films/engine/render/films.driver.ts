import path from 'node:path';

import {
  discoverFilms,
  discoverTakes,
  loadPieceModule,
  takeCompositionId,
} from '../film/discover.js';
import { takeDefinitionOf } from '../take/take-definition.js';

import { FilmRenderError } from './film-error.js';
import { filmDefinitionOf, findFilm } from './film-module.js';
import { masterAudioPath } from './master-audio.js';

import type { DiscoveredFilm } from '../film/discover.js';
import type { FilmDefinition } from '../film/spec.js';

/** The films package: the tree discovery walks, and the root of every bundle. */
export const FILMS_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The directory Studio and every bundle serve `staticFile` from; git ignores it. */
export const PUBLIC_DIR = path.join(FILMS_ROOT, 'public');

/** A film found by its id, with its definition loaded. */
export interface LoadedFilm {
  id: string;
  dir: string;
  /** Where every render product of the film is written, except its master. */
  outDir: string;
  definition: FilmDefinition;
}

/** One module of the piece `filmId` names, a failure to load refused naming the film and the file. */
function pieceModule(filmId: string, piece: DiscoveredFilm, file: string): unknown {
  try {
    return loadPieceModule(FILMS_ROOT, piece, file);
  } catch (error) {
    throw new FilmRenderError(
      { filmId, rule: 'film', detail: error instanceof Error ? error.message : String(error) },
      { cause: error }
    );
  }
}

/**
 * The film or engine fixture with this id, or the take whose composition id
 * this is (its path under the package, each `/` written `--`), its definition
 * read from its `score.ts`. Discovery lists pieces by path, and only this
 * piece's module is imported, so a sibling that fails to load never stops this
 * verb; takes are listed only for an id no film has. Loading a module needs
 * the TypeScript loader, so this runs under `node --import tsx`, never in a test.
 */
export function loadFilm(filmId: string): LoadedFilm {
  const films = discoverFilms(FILMS_ROOT);
  if (films.some(({ id }) => id === filmId)) {
    const film = findFilm(films, filmId);
    const exports = pieceModule(filmId, film, 'film.ts');
    return {
      ...film,
      outDir: path.join(film.dir, 'out'),
      definition: filmDefinitionOf(filmId, exports),
    };
  }
  const takes = discoverTakes(FILMS_ROOT).map(({ id, dir }) => ({
    id: takeCompositionId(id),
    dir,
  }));
  const take = findFilm([...films, ...takes], filmId);
  const exports = pieceModule(filmId, take, 'score.ts');
  return {
    ...take,
    outDir: path.join(take.dir, 'out'),
    definition: takeDefinitionOf(filmId, exports),
  };
}

/** The file a film's master WAV is written to and muxed from. */
export function masterWavFile(filmId: string): string {
  return path.join(PUBLIC_DIR, ...masterAudioPath(filmId).split('/'));
}
