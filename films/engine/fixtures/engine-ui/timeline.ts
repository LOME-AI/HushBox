import type { UiPlacement } from '../../look/index.js';
import type { Grid } from '../../time/grid.js';

/** The fixture's beat grid. */
export const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };

/** Three bars of the grid. */
export const BEATS = 12;

/** Each stretch of the fixture, a shot of the spec, and where the UI layer sits in it. */
export const PHASES: readonly {
  id: string;
  fromBeat: number;
  toBeat: number;
  placement: UiPlacement;
}[] = [
  { id: 'over', fromBeat: 0, toBeat: 2, placement: 'front' },
  { id: 'under', fromBeat: 2, toBeat: 4, placement: 'behind' },
  { id: 'texture', fromBeat: 4, toBeat: 9, placement: 'texture' },
  { id: 'back', fromBeat: 9, toBeat: 12, placement: 'front' },
];

/** Frames either side of each switch into and out of texture mode over which nothing moves. */
const HOLD_FRAMES = 6;

const TEXTURE = PHASES.find(({ placement }) => placement === 'texture');
if (TEXTURE === undefined) {
  throw new Error('engine-ui: the fixture has no texture stretch');
}

/** The first frame the UI is a texture, and the last. */
export const TEXTURE_FROM = TEXTURE.fromBeat * GRID.framesPerBeat;
export const TEXTURE_LAST = TEXTURE.toBeat * GRID.framesPerBeat - 1;

/** Where the UI layer sits on a frame. */
export function placementAt(frame: number): UiPlacement {
  const beat = frame / GRID.framesPerBeat;
  const phase = PHASES.find(({ fromBeat, toBeat }) => beat >= fromBeat && beat < toBeat);
  return phase?.placement ?? 'hidden';
}

/**
 * The fixture's motion clock, in frames: the frame itself, held still over
 * the frames either side of each switch into and out of texture mode, so the
 * last live frame and the first texture frame draw the same picture.
 */
export function clockAt(frame: number): number {
  const holds = [
    [TEXTURE_FROM - HOLD_FRAMES, TEXTURE_FROM],
    [TEXTURE_LAST - HOLD_FRAMES + 1, TEXTURE_LAST + 1],
  ] as const;
  let held = 0;
  for (const [from, to] of holds) {
    if (frame >= to) {
      held += to - from;
    } else if (frame >= from) {
      return from - held;
    }
  }
  return frame - held;
}

/**
 * How far the shader bends the UI on a texture frame: 0, the identity, on the
 * first and the last texture frame, rising to 1 halfway between.
 */
export function warpAt(frame: number): number {
  if (frame <= TEXTURE_FROM || frame >= TEXTURE_LAST) {
    return 0;
  }
  const along = Math.sin((Math.PI * (frame - TEXTURE_FROM)) / (TEXTURE_LAST - TEXTURE_FROM));
  return along * along;
}
