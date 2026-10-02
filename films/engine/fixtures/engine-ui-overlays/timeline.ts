import type { UiPlacement } from '../../look/index.js';
import type { Grid } from '../../time/grid.js';

/** The fixture's beat grid. */
export const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };

/** One stretch of the fixture: where the UI layer sits, and which overlays are open. */
export interface Phase {
  id: string;
  placement: UiPlacement;
  popover: boolean;
  menu: boolean;
}

/** The fixture's stretches, a beat each and a shot of the spec each, in order. */
export const PHASES: readonly Phase[] = [
  { id: 'closed', placement: 'front', popover: false, menu: false },
  { id: 'popover', placement: 'front', popover: true, menu: false },
  { id: 'menu', placement: 'front', popover: false, menu: true },
  { id: 'both', placement: 'front', popover: true, menu: true },
  { id: 'hidden', placement: 'hidden', popover: true, menu: true },
  { id: 'texture', placement: 'texture', popover: true, menu: true },
];

/** The rows the look moves the UI's pixels down by on a texture frame. */
export const TEXTURE_SHIFT = 800;

/** The stretch a frame falls in. */
export function phaseAt(frame: number): Phase {
  const phase = PHASES[Math.floor(frame / GRID.framesPerBeat)];
  if (phase === undefined) {
    throw new RangeError(`engine-ui-overlays: frame ${String(frame)} is past the last stretch`);
  }
  return phase;
}

/** The middle frame of the stretch named `id`. */
export function middleOf(id: string): number {
  const index = PHASES.findIndex((phase) => phase.id === id);
  if (index === -1) {
    throw new RangeError(`engine-ui-overlays: no stretch is named ${id}`);
  }
  return index * GRID.framesPerBeat + GRID.framesPerBeat / 2;
}
