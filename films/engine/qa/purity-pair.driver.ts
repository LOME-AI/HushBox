import { FilmRenderError } from '../render/film-error.js';

import { sameBytes } from './bytes.js';
import { decodePng } from './decode.driver.js';

import type { PurityFrame } from './purity.js';

/** One frame's master PNG and its fresh-page still, as rendered; a side the render did not return is undefined. */
export interface RenderedPair {
  frame: number;
  master: Uint8Array | undefined;
  still: Uint8Array | undefined;
}

function missing(filmId: string, frame: number, side: string): FilmRenderError {
  return new FilmRenderError({
    filmId,
    rule: 'purity',
    detail: `frame ${String(frame)} has no ${side} to compare`,
  });
}

/**
 * The purity gate's input for one frame. Both PNGs are decoded only when their
 * bytes differ, judged by the same byte comparison the gate uses, so the gate
 * has pixels to describe every difference it finds. A missing side is refused,
 * naming the film and the frame.
 */
export async function pairPurityFrame(
  filmId: string,
  { frame, master, still }: RenderedPair
): Promise<PurityFrame> {
  if (master === undefined) throw missing(filmId, frame, 'master PNG');
  if (still === undefined) throw missing(filmId, frame, 'fresh-page still');
  const differ = !sameBytes(master, still);
  return {
    frame,
    master: { bytes: master, raster: differ ? await decodePng(filmId, master) : null },
    still: { bytes: still, raster: differ ? await decodePng(filmId, still) : null },
  };
}
