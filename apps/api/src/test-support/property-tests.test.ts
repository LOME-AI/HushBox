import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROPERTY_TEST_RUNS, observePropertyRun } from '@hushbox/shared/property-tests';

describe('property runs in this package', () => {
  it('draws the same inputs on every run', () => {
    expect(observePropertyRun(fc)).toEqual(observePropertyRun(fc));
  });

  it('draws the configured number of cases', () => {
    expect(observePropertyRun(fc)).toHaveLength(PROPERTY_TEST_RUNS);
  });
});
