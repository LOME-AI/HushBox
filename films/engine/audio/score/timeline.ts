import { SAMPLES_PER_FRAME } from '../../time/grid.js';

import type { Score } from './define-score.js';

/**
 * For each track, the frames its events' anchors land on, ascending: the frame
 * on screen when the anchor sounds, which for a sub-frame event is the frame it
 * falls inside. Pure and free of Node built-ins, so a composition can call it
 * to sync a picture to a score event.
 */
export function scoreTimeline(score: Score): Record<string, number[]> {
  return Object.fromEntries(
    score.tracks.map(({ id, events }) => [
      id,
      events.map(({ sample }) => Math.floor(sample / SAMPLES_PER_FRAME)).toSorted((a, b) => a - b),
    ])
  );
}
