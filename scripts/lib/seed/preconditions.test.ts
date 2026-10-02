import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SEED_REMOTE_CACHE_REFUSAL_MESSAGE,
  SEED_REMOTE_REFUSAL_MESSAGE,
  assertLocalDatabaseUrl,
  assertNoSeedArgs,
  createSeedRedis,
  isLocalDatabaseUrl,
} from './preconditions.js';

describe('assertLocalDatabaseUrl remote-DB guard', () => {
  it('refuses a remote (non-local) DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://user:pass@db.prod.neon.tech/hushbox');
    }).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('refuses an unparseable DATABASE_URL (fails closed)', () => {
    expect(() => {
      assertLocalDatabaseUrl('not a valid url');
    }).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('accepts a 127.0.0.1 DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@127.0.0.1:4444/hushbox');
    }).not.toThrow();
  });

  it('accepts a bracketed IPv6 loopback DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@[::1]:5432/hushbox');
    }).not.toThrow();
  });

  it('accepts a localhost DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@localhost:5432/hushbox');
    }).not.toThrow();
  });
});

describe('isLocalDatabaseUrl', () => {
  it('is true for a loopback host', () => {
    expect(isLocalDatabaseUrl('postgres://postgres:postgres@localhost:5432/hushbox')).toBe(true);
  });

  it('is false for a remote host', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@db.prod.neon.tech/hushbox')).toBe(false);
  });

  it('is false (fail-closed) for an unparseable URL', () => {
    expect(isLocalDatabaseUrl('::::')).toBe(false);
  });
});

describe('assertNoSeedArgs', () => {
  it('accepts an empty argv', () => {
    expect(() => {
      assertNoSeedArgs([]);
    }).not.toThrow();
  });

  it('rejects the removed --profile flag with a clear error', () => {
    expect(() => {
      assertNoSeedArgs(['--profile', 'e2e']);
    }).toThrow(/profiles were removed.*seeds everything/);
  });

  it('rejects any unexpected argument (fail-fast, never silently ignored)', () => {
    expect(() => {
      assertNoSeedArgs(['--anything']);
    }).toThrow(/unexpected argument "--anything"/);
  });
});

describe('createSeedRedis remote-cache guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubCache(url: string): void {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', url);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'seed-test-token');
  }

  it('refuses a remote (non-local) UPSTASH_REDIS_REST_URL', () => {
    stubCache('https://us1-example-12345.upstash.io');

    expect(() => createSeedRedis()).toThrow(SEED_REMOTE_CACHE_REFUSAL_MESSAGE);
  });

  it('refuses an unparseable UPSTASH_REDIS_REST_URL (fails closed)', () => {
    stubCache('not a valid url');

    expect(() => createSeedRedis()).toThrow(SEED_REMOTE_CACHE_REFUSAL_MESSAGE);
  });

  it('accepts a loopback UPSTASH_REDIS_REST_URL', () => {
    stubCache('http://127.0.0.1:8079');

    expect(() => createSeedRedis()).not.toThrow();
  });
});
