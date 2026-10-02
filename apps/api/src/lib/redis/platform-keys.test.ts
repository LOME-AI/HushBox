import { describe, expect, it } from 'vitest';
import { roadmapIpRateLimit } from './platform-keys.js';

describe('platform redis keys', () => {
  it('roadmapIpRateLimit throttles 30 requests per 60s window', () => {
    expect(roadmapIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 30,
      windowSeconds: 60,
    });
    expect(roadmapIpRateLimit.buildKey('abc123')).toBe('ratelimit:platform:roadmap:ip:abc123');
  });
});
