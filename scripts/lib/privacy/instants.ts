/**
 * The one implementation of "does this instant sit on a UTC day boundary?",
 * shared by the text gate and the binary gate. Two copies of a carve-out are two
 * different privacy rules: a hole in a gate is ratified deliberately, never by
 * drift between detectors.
 */

import { DAY_MS, DAY_SECONDS } from '@hushbox/shared/durations';

/**
 * The gate's own vocabulary for the two day-length units, bound to the single
 * declaration of each rather than restating it. Aliased rather than renamed at
 * the call sites so that "per day" keeps reading as the gate's own term.
 */
export const MS_PER_DAY = DAY_MS;
const SECONDS_PER_DAY = DAY_SECONDS;

/**
 * The clock fields' ceilings, stated once for every consumer that needs either
 * the number or a pattern built from it: the end-of-day boundary below is the
 * same two facts as the text gate's hour and sexagesimal bands, and a fact
 * stated twice is two rules free to drift — here, a drift between what a pattern
 * matches and what the carve-out admits.
 *
 * The binary gate writes its own clock bands and deliberately does not read
 * these: it detects over a different input domain with a different era window,
 * so a drift between the two would not make either wrong.
 */
export const HOUR_MAX = 23;
export const SEXAGESIMAL_TENS_MAX = 5;
export const SEXAGESIMAL_MAX = SEXAGESIMAL_TENS_MAX * 10 + 9;

const ALL_ZEROS = /^0*$/;
const ALL_NINES = /^9+$/;

/**
 * The two boundaries of a UTC day: exact midnight, or the last representable
 * instant of the day. Subseconds must be all zeros at midnight, and all zeros or
 * all nines at end of day.
 */
export function isDayBoundaryClock(
  hour: number,
  minute: number,
  second: number,
  fraction: string
): boolean {
  const digits = fraction.replace('.', '');
  if (hour === 0 && minute === 0 && second === 0) {
    return ALL_ZEROS.test(digits);
  }
  if (hour === HOUR_MAX && minute === SEXAGESIMAL_MAX && second === SEXAGESIMAL_MAX) {
    return ALL_ZEROS.test(digits) || ALL_NINES.test(digits);
  }
  return false;
}

/**
 * Millisecond epochs are admitted in the first second of the day only. The
 * end-of-day admission the clock rules grant was never extended to epochs, and
 * widening it would be a new hole rather than a shared one.
 */
export function isDayBoundaryMillis(millis: number): boolean {
  return millis % MS_PER_DAY < 1000;
}

/** Second epochs carry no sub-second slack, so only exact midnight qualifies. */
export function isDayBoundarySeconds(seconds: number): boolean {
  return seconds % SECONDS_PER_DAY === 0;
}

/** A zone that is absent, the zulu designator, or a zero offset leaves the clock in UTC. */
export function isUtcZone(zone: string): boolean {
  return zone === '' || /^[Zz]$/.test(zone) || /^[+-]00:?00$/.test(zone);
}

/** The first two fields of a version-7 uuid are its 48-bit millisecond clock. */
export function uuidV7Millis(uuid: string): number {
  return Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}
