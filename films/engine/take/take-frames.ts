import path from 'node:path';

import { FPS } from '../time/grid.js';

/** How far apart, in seconds, the frames of a take's contact sheet are. */
const SHEET_SECONDS = 0.25;

/** How many frames either side of a cue its strip shows. */
const STRIP_REACH = 3;

/** What the take's review frames are chosen from: its length, its tempo and its cues, in frames. */
export interface TakeSpec {
  durationInFrames: number;
  grid: { framesPerBeat: number };
  cues: readonly { id: string; from: number }[];
}

/** The frames around one cue, named by the cue and its frame. */
export interface CueStrip {
  cueId: string;
  frame: number;
  frames: number[];
}

/** Every frame a take's review files show, and the union captured from its one render. */
export interface TakeFrames {
  /** A still on every beat of the take's tempo. */
  beats: number[];
  /** The contact sheet's frames, one every `SHEET_SECONDS`. */
  sheet: number[];
  /** One strip per cue, in the order the spec lists its cues. */
  strips: CueStrip[];
  /** Every frame above, once each, ascending. */
  captured: number[];
}

/** Every `step`-th frame of the take from frame 0. */
function everyFrame(step: number, durationInFrames: number): number[] {
  return Array.from({ length: Math.ceil(durationInFrames / step) }, (_, index) => index * step);
}

/** The frames a take's review files are made of: beats, contact sheet and cue strips. */
export function takeFrames({ durationInFrames, grid, cues }: TakeSpec): TakeFrames {
  const beats = everyFrame(grid.framesPerBeat, durationInFrames);
  const sheet = everyFrame(Math.round(SHEET_SECONDS * FPS), durationInFrames);
  const strips = cues.map(({ id, from }) => ({
    cueId: id,
    frame: from,
    frames: Array.from(
      { length: 2 * STRIP_REACH + 1 },
      (_, index) => from - STRIP_REACH + index
    ).filter((frame) => frame >= 0 && frame < durationInFrames),
  }));
  const captured = [...new Set([...beats, ...sheet, ...strips.flatMap(({ frames }) => frames)])];
  return { beats, sheet, strips, captured: captured.toSorted((a, b) => a - b) };
}

/** Where a cue's strip is written: `strips/<frame>-<cue-id>.png`, the frame four digits wide. */
export function stripFile(
  outDir: string,
  { cueId, frame }: Pick<CueStrip, 'cueId' | 'frame'>
): string {
  return path.join(outDir, 'strips', `${String(frame).padStart(4, '0')}-${cueId}.png`);
}
