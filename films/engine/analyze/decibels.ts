import { log10, pow } from '../dmath/dmath.js';

function requireFinite(what: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${what} must be a finite number, got ${String(value)}`);
  }
  return value;
}

/** An amplitude relative to full scale, in dB; silence reads −Infinity. */
export function amplitudeToDb(amplitude: number): number {
  return 20 * log10(requireFinite('an amplitude', amplitude));
}

/** A power relative to full scale, in dB; silence reads −Infinity. */
export function powerToDb(power: number): number {
  return 10 * log10(power);
}

/**
 * The amplitude a level in dB relative to full scale stands for. With
 * `amplitudeToDb` it is the one conversion between the two: a level set in one
 * conversion and measured in another would disagree.
 */
export function dbToAmplitude(db: number): number {
  return pow(10, requireFinite('a level in dB', db) / 20);
}
