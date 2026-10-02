/** Picture frames per second. Every timed thing in a film resolves to an integer frame of this rate. */
export const FPS = 60;

/** Audio samples per second. */
export const SAMPLE_RATE = 48_000;

/** Audio samples per picture frame: an integer, so a frame boundary is always an exact sample. */
export const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS;

/** Frame width in pixels (9:16 portrait). */
export const WIDTH = 1080;

/** Frame height in pixels (9:16 portrait). */
export const HEIGHT = 1920;

/** A film's tempo grid. Tempo is an integer frame count per beat; BPM is derived, never stored. */
export interface Grid {
  framesPerBeat: number;
  beatsPerBar: number;
}

export function bpmOf(grid: Grid): number {
  return (FPS * 60) / grid.framesPerBeat;
}

export function beatToFrame(grid: Grid, beat: number): number {
  const frame = beat * grid.framesPerBeat;
  if (!Number.isInteger(frame)) {
    throw new RangeError(
      `beat ${String(beat)} lands on frame ${String(frame)}, between frames, at framesPerBeat ${String(grid.framesPerBeat)}`
    );
  }
  return frame;
}

export function barToFrame(grid: Grid, bar: number): number {
  return beatToFrame(grid, bar * grid.beatsPerBar);
}

export function frameToSample(frame: number): number {
  return frame * SAMPLES_PER_FRAME;
}
