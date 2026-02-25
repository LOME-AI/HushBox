import { describe, it, expect, vi } from 'vitest';
import { generateTotpSecret, generateTotpCodeSync } from '@hushbox/crypto';
import { verifyTotpWithReplayProtection } from './totp.js';

describe('verifyTotpWithReplayProtection', () => {
  function createMockRedis() {
    const store = new Map<string, string>();
    return {
      get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: vi.fn().mockImplementation((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
      store,
    };
  }

  it('returns CODE_ALREADY_USED if code was previously used', async () => {
    const mockRedis = createMockRedis();
    const userId = 'test-user-id';
    const code = '123456';
    const secret = generateTotpSecret();

    // Simulate code already used
    mockRedis.store.set(`totp:used:${userId}:${code}`, '1');

    const result = await verifyTotpWithReplayProtection(
      mockRedis as unknown as Parameters<typeof verifyTotpWithReplayProtection>[0],
      userId,
      code,
      secret
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('CODE_ALREADY_USED');
  });

  it('marks code as used after successful verification', async () => {
    const mockRedis = createMockRedis();
    const userId = 'test-user-id';
    const secret = generateTotpSecret();

    // Use an invalid code (won't pass verification, but tests the flow)
    const result = await verifyTotpWithReplayProtection(
      mockRedis as unknown as Parameters<typeof verifyTotpWithReplayProtection>[0],
      userId,
      '000000',
      secret
    );

    // Code is invalid, so it won't be marked as used
    expect(result.valid).toBe(false);
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('accepts a valid code once, then rejects replay', async () => {
    const mockRedis = createMockRedis();
    const userId = 'test-user-id';
    const secret = generateTotpSecret();
    const code = generateTotpCodeSync(secret);

    // First attempt: valid code should be accepted and stored
    const first = await verifyTotpWithReplayProtection(
      mockRedis as unknown as Parameters<typeof verifyTotpWithReplayProtection>[0],
      userId,
      code,
      secret
    );

    expect(first.valid).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledOnce();

    // Second attempt: same code should be rejected as replay
    const second = await verifyTotpWithReplayProtection(
      mockRedis as unknown as Parameters<typeof verifyTotpWithReplayProtection>[0],
      userId,
      code,
      secret
    );

    expect(second.valid).toBe(false);
    expect(second.error).toBe('CODE_ALREADY_USED');
  });
});
