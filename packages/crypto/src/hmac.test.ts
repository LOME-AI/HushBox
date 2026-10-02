import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from './hmac.js';

describe('hmacSha256Hex', () => {
  // RFC 4231 test case 2: a key shorter than the block, over ASCII data.
  it('matches the RFC 4231 HMAC-SHA-256 vector', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
  });

  it('answers a different digest under a different key', () => {
    expect(hmacSha256Hex('key-a', 'carol@hushbox.ai')).not.toBe(
      hmacSha256Hex('key-b', 'carol@hushbox.ai')
    );
  });

  it('encodes the message as UTF-8', () => {
    expect(hmacSha256Hex('key', 'zoë')).not.toBe(hmacSha256Hex('key', 'zoe'));
  });

  it('answers 64 lowercase hex characters whatever the message length', () => {
    expect(hmacSha256Hex('key', '')).toMatch(/^[\da-f]{64}$/);
    expect(hmacSha256Hex('key', 'x'.repeat(4096))).toMatch(/^[\da-f]{64}$/);
  });
});
