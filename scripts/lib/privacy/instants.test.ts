import { describe, it, expect } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  isDayBoundaryClock,
  isDayBoundaryMillis,
  isDayBoundarySeconds,
  isUtcZone,
  uuidV7Millis,
} from './instants.js';

describe('isDayBoundaryClock', () => {
  it('accepts exact midnight', () => {
    expect(isDayBoundaryClock(0, 0, 0, '')).toBe(true);
  });

  it('accepts midnight with all-zero subseconds', () => {
    expect(isDayBoundaryClock(0, 0, 0, '.000')).toBe(true);
  });

  it('rejects midnight with non-zero subseconds', () => {
    expect(isDayBoundaryClock(0, 0, 0, '.001')).toBe(false);
  });

  it('accepts the end-of-day boundary, with all-zero or all-nine subseconds', () => {
    expect(isDayBoundaryClock(23, 59, 59, '')).toBe(true);
    expect(isDayBoundaryClock(23, 59, 59, '.000')).toBe(true);
    expect(isDayBoundaryClock(23, 59, 59, '.999')).toBe(true);
  });

  it('rejects the end-of-day boundary with any other subseconds', () => {
    expect(isDayBoundaryClock(23, 59, 59, '.500')).toBe(false);
  });

  it('rejects any other time of day', () => {
    expect(isDayBoundaryClock(12, 0, 0, '')).toBe(false);
  });

  // One field away from each boundary, one field at a time: a fixture that moves
  // several fields at once pins none of them.
  it.each([
    ['a second past midnight', 0, 0, 1],
    ['a minute past midnight', 0, 1, 0],
    ['an hour past midnight', 1, 0, 0],
  ])('rejects %s', (_label, hour, minute, second) => {
    expect(isDayBoundaryClock(hour, minute, second, '')).toBe(false);
  });

  it.each([
    ['a second before end of day', 23, 59, 58],
    ['a minute before end of day', 23, 58, 59],
    ['an hour before end of day', 22, 59, 59],
  ])('rejects %s', (_label, hour, minute, second) => {
    expect(isDayBoundaryClock(hour, minute, second, '')).toBe(false);
  });
});

describe('isDayBoundaryMillis', () => {
  it('accepts the first second of a UTC day', () => {
    expect(isDayBoundaryMillis(TEST_DAY_START)).toBe(true);
    expect(isDayBoundaryMillis(TEST_DAY_START + SECOND_MS - 1)).toBe(true);
  });

  it('rejects the millisecond after the first second, and every one after it', () => {
    expect(isDayBoundaryMillis(TEST_DAY_START + SECOND_MS)).toBe(false);
    expect(isDayBoundaryMillis(TEST_DAY_START + SECOND_MS + 1)).toBe(false);
    expect(isDayBoundaryMillis(TEST_DAY_START + MINUTE_MS)).toBe(false);
  });

  it('rejects the last second of a UTC day, which the clock rules do admit', () => {
    expect(isDayBoundaryMillis(TEST_DAY_START + DAY_MS - SECOND_MS)).toBe(false);
    expect(isDayBoundaryMillis(TEST_DAY_START + DAY_MS - 1)).toBe(false);
  });

  it('rejects a mid-day instant', () => {
    expect(isDayBoundaryMillis(TEST_DAY_START + 12 * HOUR_MS + 123)).toBe(false);
  });
});

describe('isDayBoundarySeconds', () => {
  it('accepts exact midnight', () => {
    expect(isDayBoundarySeconds(TEST_DAY_START / SECOND_MS)).toBe(true);
  });

  it('rejects any second after midnight', () => {
    expect(isDayBoundarySeconds(TEST_DAY_START / SECOND_MS + 1)).toBe(false);
    expect(isDayBoundarySeconds(TEST_DAY_START / SECOND_MS + DAY_MS / SECOND_MS - 1)).toBe(false);
  });

  it('is not the millisecond predicate: a millisecond count is not a second count', () => {
    expect(isDayBoundarySeconds(TEST_DAY_START + SECOND_MS / 2)).toBe(false);
    expect(isDayBoundaryMillis(TEST_DAY_START + SECOND_MS / 2)).toBe(true);
  });
});

describe('isUtcZone', () => {
  it('accepts an absent zone, the zulu designator and a zero offset in both forms', () => {
    expect(isUtcZone('')).toBe(true);
    expect(isUtcZone('Z')).toBe(true);
    expect(isUtcZone('z')).toBe(true);
    expect(isUtcZone(['+', '00', ':', '00'].join(''))).toBe(true);
    expect(isUtcZone(['-', '00', '00'].join(''))).toBe(true);
  });

  it('rejects any non-zero offset', () => {
    expect(isUtcZone(['-', '07', ':', '00'].join(''))).toBe(false);
  });
});

describe('uuidV7Millis', () => {
  it('decodes the embedded millisecond timestamp', () => {
    const uuid = `${TEST_DAY_START.toString(16)
      .padStart(12, '0')
      .replace(/^(.{8})(.{4})$/, '$1-$2')}-7abc-8def-0123456789ab`;

    expect(uuidV7Millis(uuid)).toBe(TEST_DAY_START);
  });
});
