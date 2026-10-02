import { describe, it, expect } from 'vitest';
import { HOUR_MS, MINUTE_MS, SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { formatTime } from './format-time.js';

const HOURS = 12;
const MINUTES = 34;
const SECONDS = 56;
const SUBSECOND_MS = 789;
const INSTANT = isoAt(
  TEST_DAY_START + HOURS * HOUR_MS + MINUTES * MINUTE_MS + SECONDS * SECOND_MS + SUBSECOND_MS
);
const DAY = INSTANT.slice(0, 10);

describe('formatTime', () => {
  it('renders minute precision by default', () => {
    expect(formatTime(INSTANT)).toBe(`${DAY} ${String(HOURS)}:${String(MINUTES)}`);
  });

  it('renders second precision when asked', () => {
    expect(formatTime(INSTANT, 'second')).toBe(
      `${DAY} ${String(HOURS)}:${String(MINUTES)}:${String(SECONDS)}`
    );
  });
});
