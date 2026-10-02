import { describe, it, expect } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_START,
  isoAt,
} from '@hushbox/shared/test-time';
import { relativeTime } from './relative-time.js';

const NOW = TEST_DAY_START + 12 * HOUR_MS;

describe('relativeTime', () => {
  it('reads a future instant as a wait, not as overdue', () => {
    expect(relativeTime(isoAt(NOW + 28 * MINUTE_MS), NOW)).toStrictEqual({
      label: 'in 28m',
      overdue: false,
    });
  });

  it('reads a past instant as overdue by the elapsed amount', () => {
    expect(relativeTime(isoAt(NOW - 42 * MINUTE_MS), NOW)).toStrictEqual({
      label: '42m overdue',
      overdue: true,
    });
  });

  it('reads the boundary instant as due now, which is not yet late', () => {
    expect(relativeTime(isoAt(NOW), NOW)).toStrictEqual({ label: 'due now', overdue: false });
  });

  it('collapses a sub-minute wait rather than rounding it to zero', () => {
    expect(relativeTime(isoAt(NOW + 30 * SECOND_MS), NOW).label).toBe('in <1m');
  });

  it('collapses a sub-minute overrun rather than rounding it to zero', () => {
    expect(relativeTime(isoAt(NOW - 30 * SECOND_MS), NOW).label).toBe('<1m overdue');
  });

  it('steps up to hours past the hour boundary', () => {
    expect(relativeTime(isoAt(NOW + 3 * HOUR_MS + 20 * MINUTE_MS), NOW).label).toBe('in 3h');
  });

  it('steps up to days past the day boundary', () => {
    expect(relativeTime(isoAt(NOW - 2 * DAY_MS - HOUR_MS), NOW).label).toBe('2d overdue');
  });
});
