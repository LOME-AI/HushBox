import type { UiPlacement } from '../../look/index.js';
import type { Grid } from '../../time/grid.js';

/** The fixture's beat grid. */
export const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };

/**
 * One beat of the fixture: where the UI layer sits, and which composites are
 * open. Each composite opens once and stays open to the end, so no close ever
 * hands focus back to a trigger and a frame's pixels never depend on the ones
 * before it.
 */
export interface Beat {
  id: 'closed' | 'menu' | 'menu-texture' | 'dialog' | 'sheet' | 'hidden' | 'texture';
  placement: UiPlacement;
  menu: boolean;
  dialog: boolean;
  sheet: boolean;
}

/** The fixture's beats in order, one shot each. */
export const BEATS: readonly Beat[] = [
  { id: 'closed', placement: 'front', menu: false, dialog: false, sheet: false },
  { id: 'menu', placement: 'front', menu: true, dialog: false, sheet: false },
  { id: 'menu-texture', placement: 'texture', menu: true, dialog: false, sheet: false },
  { id: 'dialog', placement: 'front', menu: true, dialog: true, sheet: false },
  { id: 'sheet', placement: 'front', menu: true, dialog: true, sheet: true },
  { id: 'hidden', placement: 'hidden', menu: true, dialog: true, sheet: true },
  { id: 'texture', placement: 'texture', menu: true, dialog: true, sheet: true },
];

/** How far down the look draws the UI's pixels on a texture frame, in frame rows. */
export const TEXTURE_DROP = 800;

/** The beat a frame falls in. */
export function beatAt(frame: number): Beat {
  const beat = BEATS[Math.floor(frame / GRID.framesPerBeat)];
  if (beat === undefined) {
    throw new RangeError(`engine-ui-composites: frame ${String(frame)} is past the last beat`);
  }
  return beat;
}

/** The middle frame of the beat named `id`. */
export function frameInside(id: Beat['id']): number {
  const at = BEATS.findIndex((beat) => beat.id === id);
  return at * GRID.framesPerBeat + GRID.framesPerBeat / 2;
}
