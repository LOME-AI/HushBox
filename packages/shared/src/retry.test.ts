import { describe, it, expect } from 'vitest';
import { isRetryableStatus, backoffCeilingMs, BASE_DELAY_MS, MAX_DELAY_MS } from './retry.js';

describe('isRetryableStatus', () => {
  it('treats request-timeout, rate-limit, and any 5xx as transient', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 599]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('treats 2xx/3xx and 4xx (other than 408/429) as terminal', () => {
    for (const status of [200, 201, 204, 304, 400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe('backoffCeilingMs', () => {
  it('starts at BASE_DELAY_MS and doubles per attempt', () => {
    expect(backoffCeilingMs(0)).toBe(BASE_DELAY_MS);
    expect(backoffCeilingMs(1)).toBe(BASE_DELAY_MS * 2);
    expect(backoffCeilingMs(2)).toBe(BASE_DELAY_MS * 4);
  });

  it('caps at MAX_DELAY_MS', () => {
    expect(backoffCeilingMs(20)).toBe(MAX_DELAY_MS);
  });
});
