import { FilmRenderError } from './film-error.js';

/** What the probe set reads of a film spec: its length, its shots and its cues, in frames. */
export interface ProbeSpec {
  durationInFrames: number;
  shots: readonly { from: number; to: number }[];
  cues: readonly { from: number }[];
}

function ascendingUnique(frames: Iterable<number>): number[] {
  return [...new Set(frames)].toSorted((a, b) => a - b);
}

/**
 * The frames a film is checked at: the first and the last, every cut and the
 * frame before it, every cue, and each shot's midpoint. A cue on the end
 * boundary names no frame of the film and adds none.
 */
export function probeFrames({ durationInFrames, shots, cues }: ProbeSpec): number[] {
  const last = durationInFrames - 1;
  const cuts = shots.filter(({ from }) => from > 0).flatMap(({ from }) => [from - 1, from]);
  const midpoints = shots.map(({ from, to }) => from + Math.floor((to - from) / 2));
  const cueFrames = cues.map(({ from }) => from).filter((frame) => frame <= last);
  return ascendingUnique([0, last, ...cuts, ...cueFrames, ...midpoints]);
}

/** The frames with the frame before and after each, inside `[0, durationInFrames)`. */
export function withNeighbours(frames: readonly number[], durationInFrames: number): number[] {
  return ascendingUnique(
    frames
      .flatMap((frame) => [frame - 1, frame, frame + 1])
      .filter((frame) => frame >= 0 && frame < durationInFrames)
  );
}

/** Refuses an empty list and any frame that is not a whole frame of the film, naming the film. */
export function requireFrames(
  filmId: string,
  frames: readonly number[],
  durationInFrames: number
): void {
  if (frames.length === 0) {
    throw new FilmRenderError({ filmId, rule: 'frames', detail: 'no frame was given' });
  }
  const last = durationInFrames - 1;
  const outside = frames.find((frame) => !(Number.isInteger(frame) && frame >= 0 && frame <= last));
  if (outside !== undefined) {
    throw new FilmRenderError({
      filmId,
      rule: 'frames',
      detail: `frame ${String(outside)} is not a frame of the film, which runs from 0 to ${String(last)}`,
    });
  }
}
