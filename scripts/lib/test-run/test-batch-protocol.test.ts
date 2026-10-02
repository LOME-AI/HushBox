import { describe, expect, it } from 'vitest';

import {
  parseRegistration,
  parseVerdict,
  serializeLine,
  type BatchRegistration,
} from './test-batch-protocol.js';

describe('serializeLine / parseLine', () => {
  it('round-trips a registration', () => {
    const registration: BatchRegistration = {
      package: '@hushbox/api',
      dir: '/repo/apps/api',
    };
    const parsed = parseRegistration(serializeLine(registration).trimEnd());
    expect(parsed).toEqual(registration);
  });

  it('round-trips each verdict shape', () => {
    expect(parseVerdict(serializeLine({ verdict: 'ok' }).trimEnd())).toEqual({ verdict: 'ok' });
    expect(parseVerdict(serializeLine({ verdict: 'solo' }).trimEnd())).toEqual({ verdict: 'solo' });
    expect(
      parseVerdict(serializeLine({ verdict: 'fail', reasons: ['a reason'] }).trimEnd())
    ).toEqual({ verdict: 'fail', reasons: ['a reason'] });
  });

  it('terminates every serialized message with a newline', () => {
    expect(serializeLine({ verdict: 'ok' }).endsWith('\n')).toBe(true);
  });

  it('returns undefined for a torn line', () => {
    expect(parseVerdict('{"verdict": "o')).toBeUndefined();
  });
});
