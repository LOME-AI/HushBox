import { describe, it, expect } from 'vitest';
import { assertRequiredBindings } from './bindings.js';
import type { Bindings } from './app-env.js';

const complete: Bindings = {
  DATABASE_URL: 'postgres://localhost:5432/db',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
};

describe('assertRequiredBindings', () => {
  it('returns the narrowed bindings when all are present', () => {
    expect(assertRequiredBindings(complete)).toEqual(complete);
  });

  it('throws naming the missing binding', () => {
    const incomplete = { ...complete };
    delete incomplete.IRON_SESSION_SECRET;
    expect(() => assertRequiredBindings(incomplete)).toThrow(/IRON_SESSION_SECRET/);
  });

  it('throws naming every missing binding at once', () => {
    expect(() => assertRequiredBindings({})).toThrow(
      /DATABASE_URL.*UPSTASH_REDIS_REST_URL.*UPSTASH_REDIS_REST_TOKEN.*IRON_SESSION_SECRET/
    );
  });

  it('treats an empty-string binding as missing', () => {
    expect(() => assertRequiredBindings({ ...complete, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('passes the identity-slice secrets through without gating them', () => {
    const withIdentitySecrets: Bindings = {
      ...complete,
      OPAQUE_KEK: 'kek-at-least-32-characters-long-for-dev!',
      TOTP_ENCRYPTION_SECRET: 'totp-at-least-32-characters-long-for-dev', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'decoy-at-least-32-characters-long-for-dev', // gitleaks:allow
    };
    expect(assertRequiredBindings(withIdentitySecrets)).toBe(withIdentitySecrets);
  });
});
