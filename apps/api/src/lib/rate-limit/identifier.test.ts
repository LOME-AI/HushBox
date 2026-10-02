import { describe, expect, it } from 'vitest';
import { MAX_IDENTIFIER_LENGTH } from './consume.js';
import { compositeRateLimitId, rateLimitKey } from './index.js';
import { callerIpIdForAddress } from '../redis/index.js';
import type { ThrottleLimit } from './definition.js';

/** The longest identifier the HTTP boundary admits: a canonical email at its cap. */
const LONGEST_IDENTIFIER = `${'a'.repeat(243)}@hushbox.ai`;

const entry: ThrottleLimit = {
  kind: 'throttle',
  maxAttempts: 5,
  windowSeconds: 900,
  buildKey: (id: string) => `ratelimit:identifier:${id}`,
};

describe('compositeRateLimitId', () => {
  it('answers one width whatever the parts measure', async () => {
    const short = await compositeRateLimitId(['a', 'b']);
    const long = await compositeRateLimitId([LONGEST_IDENTIFIER, 'z'.repeat(4096)]);

    expect(short).toMatch(/^[0-9a-f]{64}$/);
    expect(long).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers the same identifier for the same parts', async () => {
    expect(await compositeRateLimitId(['carol@hushbox.ai', 'f0'])).toBe(
      await compositeRateLimitId(['carol@hushbox.ai', 'f0'])
    );
  });

  it('tells apart two part lists one concatenation could produce', async () => {
    expect(await compositeRateLimitId(['ab', 'c'])).not.toBe(
      await compositeRateLimitId(['a', 'bc'])
    );
  });

  // The separator cases below are what discriminate digest-per-part from a
  // plain `parts.join(':')`: under the latter both pairs flatten to one
  // message, so a caller-supplied identifier carrying a colon would land in
  // another pair's window.
  it('tells apart two part lists that differ only in where a separator falls', async () => {
    expect(await compositeRateLimitId(['a:b', 'c'])).not.toBe(
      await compositeRateLimitId(['a', 'b:c'])
    );
  });

  it('tells apart a part that is only a separator from an empty one', async () => {
    expect(await compositeRateLimitId([':', 'a'])).not.toBe(await compositeRateLimitId(['', ':a']));
  });

  it('answers one width when a part is empty', async () => {
    expect(await compositeRateLimitId(['', 'a'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers one width for a non-ASCII identifier', async () => {
    expect(await compositeRateLimitId(['zoë@hushbox.ai', 'f0'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a counter key inside the identifier bound for the longest identifier', async () => {
    const address = await callerIpIdForAddress('2001:db8::1');
    const naive = `${LONGEST_IDENTIFIER}:${address}`;
    expect(naive.length).toBeGreaterThan(MAX_IDENTIFIER_LENGTH);

    const key = rateLimitKey(entry, await compositeRateLimitId([LONGEST_IDENTIFIER, address]));

    expect(key.isOk()).toBe(true);
  });
});
