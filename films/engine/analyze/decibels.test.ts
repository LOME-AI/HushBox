import { describe, expect, it } from 'vitest';

import { amplitudeToDb, dbToAmplitude, powerToDb } from './decibels.js';

describe('amplitudeToDb', () => {
  it('reads full scale as 0 dB', () => {
    expect(amplitudeToDb(1)).toBe(0);
  });

  it('reads half scale as −6.02 dB', () => {
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.0206, 4);
  });

  it('reads silence as −Infinity', () => {
    expect(amplitudeToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses an amplitude of %s',
    (amplitude) => {
      expect(() => amplitudeToDb(amplitude)).toThrow(
        `an amplitude must be a finite number, got ${String(amplitude)}`
      );
    }
  );
});

describe('powerToDb', () => {
  it('reads a tenth of full power as −10 dB', () => {
    expect(powerToDb(0.1)).toBeCloseTo(-10, 12);
  });

  it('reads zero power as −Infinity', () => {
    expect(powerToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('dbToAmplitude', () => {
  it('maps 0 dB to full scale exactly', () => {
    expect(dbToAmplitude(0)).toBe(1);
  });

  it('maps −20 dB to a tenth', () => {
    expect(dbToAmplitude(-20)).toBeCloseTo(0.1, 15);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses a level of %s dB',
    (db) => {
      expect(() => dbToAmplitude(db)).toThrow(
        `a level in dB must be a finite number, got ${String(db)}`
      );
    }
  );
});
