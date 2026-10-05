import { describe, expect, it } from 'vitest';

import { EXCLUDE_REASONS } from './exclude-reasons.ts';

describe('EXCLUDE_REASONS', () => {
  it('names a standard-tier endpoint price the schedule cannot represent as its own reason', () => {
    expect(EXCLUDE_REASONS).toContain('unrepresentable-endpoint-price');
  });

  it('lists the unrepresentable endpoint price among the loud defects, after every quiet reason', () => {
    expect(EXCLUDE_REASONS.indexOf('unrepresentable-endpoint-price')).toBeGreaterThan(
      EXCLUDE_REASONS.indexOf('unclassifiable-modality')
    );
  });

  it('holds each reason once', () => {
    expect(new Set(EXCLUDE_REASONS).size).toBe(EXCLUDE_REASONS.length);
  });
});
