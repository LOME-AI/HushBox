/** The motion-blur shutter angle: the exposure spans this share of 360 degrees of one frame. */
export const SHUTTER_DEGREES = 180;

const SHUTTER_FRAMES = SHUTTER_DEGREES / 360;

function assertSamples(samples: number): void {
  if (!Number.isInteger(samples) || samples < 1) {
    throw new RangeError(
      `motion blur takes a whole number of at least one sample per frame, got ${String(samples)}`
    );
  }
}

/**
 * When, in frames relative to the frame itself, each motion-blur sample is taken:
 * the midpoints of `samples` equal slices of a shutter centred on the frame, so
 * one sample is the frame's own instant.
 */
export function subFrameOffsets(samples: number): number[] {
  assertSamples(samples);
  return Array.from(
    { length: samples },
    (_, index) => ((index + 0.5) / samples - 0.5) * SHUTTER_FRAMES
  );
}

/**
 * The sub-frame instants a canvas renders besides the frame itself so that every
 * layer finds each of its samples: the union of every layer's offsets, ascending,
 * without the frame's own instant.
 */
export function passOffsets(sampleCounts: readonly number[]): number[] {
  const offsets = new Set(sampleCounts.flatMap((samples) => subFrameOffsets(samples)));
  offsets.delete(0);
  return [...offsets].toSorted((a, b) => a - b);
}
