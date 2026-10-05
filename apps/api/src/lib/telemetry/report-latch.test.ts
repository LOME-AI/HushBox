import { describe, expect, it } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { REPORT_WINDOW_MS, admitReport } from './report-latch.js';

describe('admitReport', () => {
  it('admits the first report of a key', () => {
    expect(admitReport('first-of-its-key', TEST_DAY_START)).toBe(true);
  });

  it('refuses a second report of the key inside the window', () => {
    admitReport('repeated-inside', TEST_DAY_START);

    expect(admitReport('repeated-inside', TEST_DAY_START + REPORT_WINDOW_MS - 1)).toBe(false);
  });

  it('admits another key inside the window of the first', () => {
    admitReport('one-key', TEST_DAY_START);

    expect(admitReport('another-key', TEST_DAY_START)).toBe(true);
  });

  it('admits the key again once its window has elapsed', () => {
    admitReport('repeated-after', TEST_DAY_START);

    expect(admitReport('repeated-after', TEST_DAY_START + REPORT_WINDOW_MS)).toBe(true);
  });

  it('measures the window from the last admitted report, not from a refused one', () => {
    admitReport('refused-between', TEST_DAY_START);
    admitReport('refused-between', TEST_DAY_START + REPORT_WINDOW_MS - 1);

    expect(admitReport('refused-between', TEST_DAY_START + REPORT_WINDOW_MS)).toBe(true);
  });

  it('holds a key quiet for one minute', () => {
    expect(REPORT_WINDOW_MS).toBe(60_000);
  });
});
