import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, MINUTE_MS } from './durations.ts';

describe('duration constants', () => {
  it('measures a minute in milliseconds', () => {
    expect(MINUTE_MS).toBe(60_000);
  });

  it('makes an hour sixty minutes', () => {
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
  });

  it('makes a day twenty-four hours', () => {
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });
});
