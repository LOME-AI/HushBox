import { z } from 'zod';

/** The most notes a chord holds. */
const MAX_CHORD = 8;
/** The shortest note, a 64th, and the longest, sixteen bars of four. */
const MIN_BEATS = 1 / 16;
const MAX_BEATS = 64;

/** A MIDI note number in whole semitones, from `lowest` to `highest`. */
export function noteSchema(lowest: number, highest: number): z.ZodInt {
  return z.int().min(lowest).max(highest);
}

/** One to eight notes sounded together. */
export function chordSchema(
  lowest: number,
  highest: number,
  fallback: number[]
): z.ZodDefault<z.ZodArray<z.ZodInt>> {
  return z.array(noteSchema(lowest, highest)).min(1).max(MAX_CHORD).default(fallback);
}

/**
 * A note's length in beats. It must also come to a whole number of samples at
 * the film's tempo, which only `beatsToSamples` can check, at render.
 */
export function beatsSchema(fallback: number): z.ZodDefault<z.ZodNumber> {
  return z.number().min(MIN_BEATS).max(MAX_BEATS).default(fallback);
}
