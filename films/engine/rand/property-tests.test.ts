import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROPERTY_TEST_RUNS, PROPERTY_TEST_SEED } from '@hushbox/shared/property-tests';

describe('property runs in this package', () => {
  it('draw from the pinned seed', () => {
    expect(fc.readConfigureGlobal().seed).toBe(PROPERTY_TEST_SEED);
  });

  it('run the pinned number of cases', () => {
    expect(fc.readConfigureGlobal().numRuns).toBe(PROPERTY_TEST_RUNS);
  });
});
