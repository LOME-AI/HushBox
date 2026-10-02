import { describe, it, expect } from 'vitest';

import { isWorkerOutbound } from './tts-worker-protocol';

describe('isWorkerOutbound', () => {
  it('returns false for non-objects', () => {
    expect(isWorkerOutbound(null)).toBe(false);
    expect(isWorkerOutbound('hello')).toBe(false);
    expect(isWorkerOutbound(42)).toBe(false);
  });

  it('returns false for objects without a string `type` field', () => {
    expect(isWorkerOutbound({})).toBe(false);
    expect(isWorkerOutbound({ type: 42 })).toBe(false);
  });

  it('returns true for `workerReady` (the requestId-less message variant)', () => {
    expect(isWorkerOutbound({ type: 'workerReady' })).toBe(true);
  });

  it('returns false for an unknown `type` value', () => {
    expect(isWorkerOutbound({ type: 'unrecognized', requestId: 'x' })).toBe(false);
  });

  it('returns true for a known requestId-bearing type with a string requestId', () => {
    expect(isWorkerOutbound({ type: 'loadDone', requestId: 'L1' })).toBe(true);
    expect(
      isWorkerOutbound({
        type: 'speakReady',
        requestId: 'S1',
        audio: new Float32Array(0),
        samplingRate: 24_000,
      })
    ).toBe(true);
  });

  it('returns false for a known requestId-bearing type when requestId is missing or not a string', () => {
    expect(isWorkerOutbound({ type: 'loadDone' })).toBe(false);
    expect(isWorkerOutbound({ type: 'loadDone', requestId: 42 })).toBe(false);
  });
});
