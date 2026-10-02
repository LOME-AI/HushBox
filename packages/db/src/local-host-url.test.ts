import { describe, it, expect } from 'vitest';

import { isLocalHostUrl } from './local-host-url';

describe('isLocalHostUrl', () => {
  it('accepts a loopback host', () => {
    expect(isLocalHostUrl('postgres://postgres:postgres@localhost:4444/hushbox')).toBe(true);
  });

  it('accepts the bracketed IPv6 loopback the URL parser produces', () => {
    expect(isLocalHostUrl('postgres://postgres:postgres@[::1]:5432/hushbox')).toBe(true);
  });

  it('rejects a remote host', () => {
    expect(isLocalHostUrl('postgres://user:pass@db.prod.neon.tech/hushbox')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isLocalHostUrl('not a url')).toBe(false);
  });
});
