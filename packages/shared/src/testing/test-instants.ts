/**
 * The single source of frozen instants for tests. Import it instead of writing
 * a timestamp literal: every constant here is a UTC day boundary, so nothing a
 * test commits discloses when the work happened. Times of day are expressed as
 * a named instant plus a duration (`TEST_DAY_START + 14 * HOUR_MS`), never as a
 * literal.
 *
 * This module reaches no test runner, so a test-support module that is not
 * itself a test file can take a named instant without pulling vitest into a
 * non-test import graph. The clock-mocking helpers, which cannot be written
 * without the runner, live in `packages/shared/src/testing/test-time.ts` and re-export
 * everything here — so a test file needs only the one import it already has.
 * A colocated test pins both halves of that split.
 *
 * Reached through the `@hushbox/shared/test-instants` subpath.
 */

import { DAY_MS, SECOND_MS } from '../utils/durations.ts';

export { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '../utils/durations.ts';

const REFERENCE_YEAR = 2026;
const REFERENCE_MONTH_INDEX = 0;
const REFERENCE_DAY_OF_MONTH = 15;

/** Midnight UTC on the reference day — the default "now" for a frozen test clock. */
export const TEST_DAY_START = Date.UTC(
  REFERENCE_YEAR,
  REFERENCE_MONTH_INDEX,
  REFERENCE_DAY_OF_MONTH
);

/** The last millisecond of the reference day — the end-of-day boundary. */
export const TEST_DAY_END = TEST_DAY_START + DAY_MS - 1;

/** Midnight UTC on the first day of the reference year. */
export const TEST_YEAR_START = Date.UTC(REFERENCE_YEAR, 0, 1);

/** Midnight UTC on the first day of the month after the reference day's. */
export const TEST_MONTH_START = Date.UTC(REFERENCE_YEAR, REFERENCE_MONTH_INDEX + 1, 1);

/** Midnight UTC on the reference day's last day of month. */
export const TEST_MONTH_END_DAY_START = TEST_MONTH_START - DAY_MS;

/**
 * Local midnight on the same calendar date `TEST_DAY_START` names in UTC. Only
 * for behaviour that reads local components (`Date#getHours`); adding an offset
 * to a UTC instant lands on a different local hour in every zone but UTC.
 */
export const TEST_LOCAL_DAY_START = new Date(
  REFERENCE_YEAR,
  REFERENCE_MONTH_INDEX,
  REFERENCE_DAY_OF_MONTH
).getTime();

/** Local midnight on the first day of the reference day's month. */
export const TEST_LOCAL_MONTH_START = new Date(REFERENCE_YEAR, REFERENCE_MONTH_INDEX, 1).getTime();

/** The UTC ISO rendering of an instant, for assertions that compare strings. */
export function isoAt(instantMs: number): string {
  return new Date(instantMs).toISOString();
}

/**
 * The unix-seconds rendering of an instant, for fields that carry whole
 * seconds. Truncated rather than rounded: such a field is the floor of the
 * millisecond instant, so rounding would put a fixture a second ahead of the
 * instant it was derived from.
 */
export function secondsAt(instantMs: number): number {
  return Math.floor(instantMs / SECOND_MS);
}

/**
 * The release stamp (unix SECONDS) a catalog fixture carries when it is meant to
 * read as an old release: far enough back to sit outside every window a release
 * date is judged against — the catalog age cutoff and the premium-recency leg
 * both — under any clock at or after {@link TEST_DAY_START}, frozen there or
 * read live: a site that freezes nothing takes the real wall clock, which is
 * later still and only widens the margin. Its colocated test pins it against
 * those two windows, so a widened window reds here rather than silently
 * reclassifying every fixture that carries it.
 */
export const OLD_RELEASE_SECONDS = secondsAt(TEST_DAY_START - 800 * DAY_MS);

const MAX_UUID_INDEX = 2 ** 24;

/**
 * A stable version-7 UUID for fixtures. The embedded timestamp is
 * `TEST_DAY_START`, so the id discloses no more than a day-boundary constant
 * does; `index` distinguishes ids and is the whole of their variable part.
 */
export function testUuidV7(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_UUID_INDEX) {
    throw new Error(`testUuidV7: index must be an integer in [0, ${String(MAX_UUID_INDEX)})`);
  }
  const timestamp = TEST_DAY_START.toString(16).padStart(12, '0');
  const version = (0x70_00 | ((index >>> 12) & 0x0f_ff)).toString(16);
  const variant = (0x80_00 | (index & 0x0f_ff)).toString(16);
  return [
    timestamp.slice(0, 8),
    timestamp.slice(8, 12),
    version,
    variant,
    index.toString(16).padStart(12, '0'),
  ].join('-');
}
