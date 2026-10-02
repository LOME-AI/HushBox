/**
 * The clock-mocking half of the test-time module, plus the whole of its pure
 * half re-exported — so `@hushbox/shared/test-time` remains the one import a
 * test file needs for both instants and a frozen clock.
 *
 * These helpers cannot be written without the test runner, which is the whole
 * reason the instants live apart in `packages/shared/src/testing/test-instants.ts`: a
 * test-support module that is not itself a test file reaches that subpath and
 * pulls in no runner. Import direction is one-way, and a test there pins it.
 *
 * Test-only, reached through the `@hushbox/shared/test-time` subpath.
 */

import { vi } from 'vitest';

export {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  OLD_RELEASE_SECONDS,
  SECOND_MS,
  TEST_DAY_END,
  TEST_DAY_START,
  TEST_LOCAL_DAY_START,
  TEST_LOCAL_MONTH_START,
  TEST_MONTH_END_DAY_START,
  TEST_MONTH_START,
  TEST_YEAR_START,
  isoAt,
  secondsAt,
  testUuidV7,
} from './test-instants.ts';

type FakeTimerOptions = Parameters<typeof vi.useFakeTimers>[0];

/** Install fake timers and pin the clock to `instantMs`. */
export function freezeClock(instantMs: number, options?: FakeTimerOptions): void {
  vi.useFakeTimers(options);
  vi.setSystemTime(instantMs);
}

/** Move an already-frozen clock, leaving the installed timers in place. */
export function setClock(instantMs: number): void {
  vi.setSystemTime(instantMs);
}
