import path from 'node:path';

import { writeContactSheet } from '../render/contact-sheet.driver.js';
import { loadFilm } from '../render/films.driver.js';
import { probeFrames } from '../render/probe-frames.js';
import { renderFilmStills, renderFilmVideo, stillFile } from '../render/render-film.driver.js';
import { writeScore } from '../render/score.driver.js';
import { verifyFilm } from '../qa/verify.driver.js';
import { renderTake } from '../take/take.driver.js';

import type { FilmVerbs } from './run.js';

/** The verbs `pnpm films` runs, on the films, engine fixtures and takes under the package. */
export const filmVerbs: FilmVerbs = {
  async score(filmId) {
    return writeScore(loadFilm(filmId));
  },

  async stills(filmId, { frames, gl }) {
    const film = loadFilm(filmId);
    const chosen = frames ?? probeFrames(film.definition.spec);
    const files = await renderFilmStills(filmId, chosen, { gl });
    const sheet = await writeContactSheet(
      chosen.map((frame) => ({ frame, file: stillFile(film, frame) })),
      path.join(film.outDir, 'sheet.png')
    );
    return [...files, sheet];
  },

  async render(filmId, { draft, gl }) {
    const film = loadFilm(filmId);
    const scored = film.definition.score === undefined ? [] : await writeScore(film);
    const video = await renderFilmVideo(filmId, {
      draft,
      gl,
      probeFrames: probeFrames(film.definition.spec),
    });
    return [...scored, video.path];
  },

  async verify(filmId, { gl }) {
    return verifyFilm(filmId, { gl });
  },

  async take(takePath, { gl }) {
    return renderTake(takePath, { gl });
  },
};
