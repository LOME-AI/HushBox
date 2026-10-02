import { describe, it, expect, vi } from 'vitest';
import { fromBase64 } from '@hushbox/shared';
import { applicationServerKey, matchesApplicationServerKey } from './application-server-key.js';

/** The configured VAPID public key (base64url) and the key of a retired pair. */
const VAPID_PUBLIC_KEY = 'BOeIadxzr8jCEiJstuK2';
const RETIRED_VAPID_PUBLIC_KEY = 'BRetiredKeyBytesXXXX';

function keyBytes(base64url: string): ArrayBuffer {
  return new Uint8Array(fromBase64(base64url)).buffer;
}

describe('applicationServerKey', () => {
  it('decodes the configured public key to its bytes', () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', VAPID_PUBLIC_KEY);

    const key = applicationServerKey();

    expect([...key]).toEqual([...fromBase64(VAPID_PUBLIC_KEY)]);
  });

  it('is backed by a buffer holding exactly the key bytes', () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', VAPID_PUBLIC_KEY);

    const key = applicationServerKey();

    expect(key.byteOffset).toBe(0);
    expect(key.buffer.byteLength).toBe(key.byteLength);
  });

  it('throws when the configured public key is missing', () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');

    expect(() => applicationServerKey()).toThrow();
  });
});

describe('matchesApplicationServerKey', () => {
  const key = new Uint8Array(fromBase64(VAPID_PUBLIC_KEY));

  it('matches a subscription key with the same bytes', () => {
    expect(matchesApplicationServerKey(keyBytes(VAPID_PUBLIC_KEY), key)).toBe(true);
  });

  it('rejects a subscription key with different bytes', () => {
    expect(matchesApplicationServerKey(keyBytes(RETIRED_VAPID_PUBLIC_KEY), key)).toBe(false);
  });

  it('rejects a subscription key that is a prefix of the configured key', () => {
    expect(matchesApplicationServerKey(key.slice(0, -1).buffer, key)).toBe(false);
  });

  it('rejects a subscription whose key the browser does not report', () => {
    expect(matchesApplicationServerKey(null, key)).toBe(false);
  });
});
