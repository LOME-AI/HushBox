import { describe, expect, it } from 'vitest';
import { userSearchRateLimit } from './rate-limit.js';

/**
 * Enforcement lands at the pipeline rate-limit stage, from the layer this
 * slice's posture fragment declares.
 * The contract pinned here is that the registry entry EXISTS, is a throttle,
 * and carries its cap under its own key.
 */
describe('userSearchRateLimit', () => {
  it('caps authenticated username search at 60 per 60s', () => {
    expect(userSearchRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 60,
      windowSeconds: 60,
    });
  });

  it('keys per authenticated user', () => {
    expect(userSearchRateLimit.buildKey('user-123')).toBe(
      'ratelimit:account:user-search:user:user-123'
    );
  });
});
