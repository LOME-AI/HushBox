import { describe, expect, it } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';
import * as barrel from './index.js';

const PUBLISHED_SURFACE: [string, ...string[]] = [
  'createSentryTelemetry',
  'installProductionConsolePatch',
  'scrubSentryEvent',
  'sentryClientOptions',
];

describe('telemetry adapters barrel', () => {
  it('exports every adapter in the declared surface as a function', () => {
    expectExposes(barrel, ...PUBLISHED_SURFACE);
  });

  it('publishes exactly the declared adapter surface', () => {
    expect(new Set(Object.keys(barrel))).toEqual(new Set(PUBLISHED_SURFACE));
  });
});
