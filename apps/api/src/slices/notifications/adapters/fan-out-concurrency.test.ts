import { describe, it, expect } from 'vitest';
import { PUSH_FAN_OUT_CONCURRENCY } from './fan-out-concurrency.js';

describe('PUSH_FAN_OUT_CONCURRENCY', () => {
  it('stays within the platform simultaneous-connection cap', () => {
    expect(PUSH_FAN_OUT_CONCURRENCY).toBeLessThanOrEqual(6);
  });
});
