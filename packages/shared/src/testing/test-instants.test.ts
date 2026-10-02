import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_MODEL_AGE_MS } from '../affordability/constants.ts';
import { PREMIUM_RECENCY_MS } from '../affordability/money/premium.ts';
import { testRunnersReachableFrom } from './import-graph.ts';
import {
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PURE_ENTRY = path.join(HERE, 'test-instants.ts');
const CLOCK_ENTRY = path.join(HERE, 'test-time.ts');

describe('instant module import graph', () => {
  it('reaches no test runner', () => {
    expect(testRunnersReachableFrom(PURE_ENTRY)).toEqual([]);
  });

  it('sees the test runner the clock helpers keep', () => {
    expect(testRunnersReachableFrom(CLOCK_ENTRY)).toContain('vitest');
  });
});

describe('duration constants', () => {
  it('builds each unit from the smaller one', () => {
    expect(MINUTE_MS).toBe(60 * SECOND_MS);
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });
});

describe('named instants', () => {
  it.each([
    ['TEST_DAY_START', TEST_DAY_START],
    ['TEST_YEAR_START', TEST_YEAR_START],
    ['TEST_MONTH_START', TEST_MONTH_START],
    ['TEST_MONTH_END_DAY_START', TEST_MONTH_END_DAY_START],
  ])('%s sits exactly on a UTC day boundary', (_name, instant) => {
    expect(instant % DAY_MS).toBe(0);
  });

  it('ends the reference day one millisecond before the next one starts', () => {
    expect(TEST_DAY_END).toBe(TEST_DAY_START + DAY_MS - 1);
  });

  it('places the month-end day directly before the month start', () => {
    expect(TEST_MONTH_END_DAY_START).toBe(TEST_MONTH_START - DAY_MS);
  });

  it('opens the reference year before the reference day', () => {
    expect(TEST_YEAR_START).toBeLessThan(TEST_DAY_START);
  });

  it('opens the local reference month on its first day', () => {
    const local = new Date(TEST_LOCAL_MONTH_START);

    expect(local.getDate()).toBe(1);
    expect(local.getHours()).toBe(0);
    expect(local.getMonth()).toBe(new Date(TEST_LOCAL_DAY_START).getMonth());
  });

  it('names the same calendar date locally as TEST_DAY_START names in UTC', () => {
    const local = new Date(TEST_LOCAL_DAY_START);

    expect(local.getHours()).toBe(0);
    expect(local.getMinutes()).toBe(0);
    expect(local.getSeconds()).toBe(0);
    expect(local.getMilliseconds()).toBe(0);
    expect(local.getDate()).toBe(new Date(TEST_DAY_START).getUTCDate());
  });
});

describe('OLD_RELEASE_SECONDS', () => {
  it('sits before the catalog age cutoff measured back from the reference day', () => {
    expect(OLD_RELEASE_SECONDS * SECOND_MS).toBeLessThan(TEST_DAY_START - MAX_MODEL_AGE_MS);
  });

  it('sits before the premium-recency window measured back from the reference day', () => {
    expect(OLD_RELEASE_SECONDS * SECOND_MS).toBeLessThan(TEST_DAY_START - PREMIUM_RECENCY_MS);
  });

  it('sits exactly on a UTC day boundary', () => {
    expect((OLD_RELEASE_SECONDS * SECOND_MS) % DAY_MS).toBe(0);
  });
});

describe('isoAt', () => {
  it('renders an instant as its UTC ISO string', () => {
    expect(isoAt(TEST_DAY_START)).toBe(new Date(TEST_DAY_START).toISOString());
  });
});

describe('secondsAt', () => {
  it('renders an instant as whole unix seconds', () => {
    expect(secondsAt(TEST_DAY_START)).toBe(TEST_DAY_START / SECOND_MS);
  });

  it('truncates a sub-second remainder instead of rounding to the next second', () => {
    expect(secondsAt(TEST_DAY_START + SECOND_MS - 1)).toBe(TEST_DAY_START / SECOND_MS);
  });
});

describe('testUuidV7', () => {
  it('returns a well-formed version-7 UUID', () => {
    expect(testUuidV7(0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('embeds a day-boundary instant as its timestamp', () => {
    const embedded = Number.parseInt(testUuidV7(3).replaceAll('-', '').slice(0, 12), 16);

    expect(embedded % DAY_MS).toBe(0);
  });

  it('returns the same id for the same index', () => {
    expect(testUuidV7(7)).toBe(testUuidV7(7));
  });

  it('returns different ids for different indexes', () => {
    expect(testUuidV7(1)).not.toBe(testUuidV7(2));
  });

  it('rejects an index that is not a non-negative integer', () => {
    expect(() => testUuidV7(-1)).toThrow('testUuidV7');
  });

  it('rejects an index beyond the encodable range', () => {
    expect(() => testUuidV7(2 ** 24)).toThrow('testUuidV7');
  });
});
