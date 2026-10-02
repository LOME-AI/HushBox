import { z } from 'zod';

/** The shortest bed, a 64th; the longest runs over six minutes at 150 BPM. */
const MIN_BEATS = 1 / 16;
const MAX_BEATS = 1024;

/**
 * A bed's length in beats: a sound that runs from one cue to another for as long
 * as the score needs. Like a note's length, it must also come to a whole number
 * of samples at the film's tempo, which `beatsToSamples` checks at render.
 */
export function bedBeatsSchema(fallback: number): z.ZodDefault<z.ZodNumber> {
  return z.number().min(MIN_BEATS).max(MAX_BEATS).default(fallback);
}
