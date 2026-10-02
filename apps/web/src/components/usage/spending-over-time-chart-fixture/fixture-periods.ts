import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-instants';

/** How many daily periods the fixture's chart draws. */
const FIXTURE_DAYS = 30;

/** The fixture's periods, one per day from the shared test day, as the usage read sends them. */
export const FIXTURE_PERIODS: readonly string[] = Array.from({ length: FIXTURE_DAYS }, (_, day) =>
  isoAt(TEST_DAY_START + day * DAY_MS).slice(0, 'YYYY-MM-DD'.length)
);
