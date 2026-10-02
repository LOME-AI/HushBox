import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { testRunnersReachableFrom } from '../testing/import-graph.ts';
import {
  DAY_MINUTES,
  DAY_MS,
  DAY_SECONDS,
  HOUR_MINUTES,
  HOUR_MS,
  HOUR_SECONDS,
  MINUTE_MS,
  MINUTE_SECONDS,
  SECOND_MS,
} from './durations.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, 'durations.ts');

describe('duration constants', () => {
  it('makes a minute sixty seconds', () => {
    expect(MINUTE_MS).toBe(60 * SECOND_MS);
  });

  it('makes an hour sixty minutes', () => {
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
  });

  it('makes a day twenty-four hours', () => {
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });

  it('states the same day in seconds as in milliseconds', () => {
    expect(DAY_SECONDS * SECOND_MS).toBe(DAY_MS);
  });

  it('measures a second in milliseconds', () => {
    expect(SECOND_MS).toBe(1000);
  });

  it('measures a minute in seconds', () => {
    expect(MINUTE_SECONDS).toBe(60);
  });

  it('makes an hour sixty minutes in seconds', () => {
    expect(HOUR_SECONDS).toBe(60 * MINUTE_SECONDS);
  });

  it('states the same minute in seconds as in milliseconds', () => {
    expect(MINUTE_SECONDS * SECOND_MS).toBe(MINUTE_MS);
  });

  it('states the same hour in seconds as in milliseconds', () => {
    expect(HOUR_SECONDS * SECOND_MS).toBe(HOUR_MS);
  });

  it('measures an hour in minutes', () => {
    expect(HOUR_MINUTES).toBe(60);
  });

  it('makes a day twenty-four hours in minutes', () => {
    expect(DAY_MINUTES).toBe(24 * HOUR_MINUTES);
  });

  it('states the same hour in minutes as in seconds', () => {
    expect(HOUR_MINUTES * MINUTE_SECONDS).toBe(HOUR_SECONDS);
  });

  it('states the same day in minutes as in milliseconds', () => {
    expect(DAY_MINUTES * MINUTE_MS).toBe(DAY_MS);
  });
});

describe('duration module import graph', () => {
  it('reaches no test runner', () => {
    expect(testRunnersReachableFrom(ENTRY)).toEqual([]);
  });
});
