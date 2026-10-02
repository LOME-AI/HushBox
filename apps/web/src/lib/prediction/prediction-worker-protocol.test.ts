import { describe, it, expect } from 'vitest';

import {
  isPredictionWorkerOutbound,
  type PredictionWorkerOutbound,
} from './prediction-worker-protocol';

describe('isPredictionWorkerOutbound', () => {
  const accepted: PredictionWorkerOutbound[] = [
    { type: 'ready', requestId: 'r1' },
    { type: 'failed', requestId: 'r2b', reason: 'canary token mismatch' },
    { type: 'completion', requestId: 'r3', completion: ' the door' },
    { type: 'alternatives', requestId: 'r4', alternatives: [' a door'] },
    { type: 'alternatives', requestId: 'r5', alternatives: [] },
  ];

  it.each(accepted)('accepts a well-formed $type message', (message) => {
    expect(isPredictionWorkerOutbound(message)).toBe(true);
  });

  const rejected: [string, unknown][] = [
    ['a non-object', 'ready'],
    ['null', null],
    ['a message with no type', { requestId: 'r' }],
    ['an unknown type', { type: 'loadProgress', requestId: 'r' }],
    ['a message with no requestId', { type: 'ready' }],
    ['a non-string requestId', { type: 'ready', requestId: 7 }],
    ['a completion with no completion field', { type: 'completion', requestId: 'r' }],
    [
      'an alternatives message with non-string alternatives',
      { type: 'alternatives', requestId: 'r', alternatives: [7] },
    ],
    [
      'an alternatives message with no alternatives array',
      { type: 'alternatives', requestId: 'r' },
    ],
    ['a failure whose reason is not text', { type: 'failed', requestId: 'r', reason: 7 }],
    ['a failure with no reason', { type: 'failed', requestId: 'r2' }],
  ];

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(isPredictionWorkerOutbound(value)).toBe(false);
  });
});
