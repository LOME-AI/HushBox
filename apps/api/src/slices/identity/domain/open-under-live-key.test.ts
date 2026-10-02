import { describe, expect, it } from 'vitest';
import { UnknownKeyVersionError } from '@hushbox/crypto';
import { openUnderLiveKey } from './open-under-live-key.js';

describe('openUnderLiveKey', () => {
  it('returns what the open yields', () => {
    expect(openUnderLiveKey(() => 'opened')).toBe('opened');
  });

  it('answers null when the blob names a key this deployment does not hold', () => {
    expect(
      openUnderLiveKey(() => {
        throw new UnknownKeyVersionError(new Uint8Array(8));
      })
    ).toBeNull();
  });

  it('rethrows any other failure as the defect it is', () => {
    expect(() =>
      openUnderLiveKey(() => {
        throw new Error('corrupt');
      })
    ).toThrow('corrupt');
  });
});
