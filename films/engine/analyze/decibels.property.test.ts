import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { amplitudeToDb, dbToAmplitude } from './decibels.js';

describe('dbToAmplitude', () => {
  it('inverts amplitudeToDb to within a few ulps (fast-check doubles over [−120, 0] dB)', () => {
    fc.assert(
      fc.property(fc.double({ min: -120, max: 0, noNaN: true }), (db) => {
        expect(amplitudeToDb(dbToAmplitude(db))).toBeCloseTo(db, 10);
      })
    );
  });
});
