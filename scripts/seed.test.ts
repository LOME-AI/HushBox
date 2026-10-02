import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2E_KEYSPACE_CEILING } from '@hushbox/api/dev-seed';
import {
  CORE_TEST_PERSONAS,
  E2E_WORKER_POOL_SIZE,
  POOLED_PERSONA_BASE_NAMES,
} from './lib/seed/personas.js';
import {
  ADMIN_TARGET_PERSONA,
  BASE_TEST_PERSONAS,
  DEV_PERSONAS,
  E2E_PROJECT_NAMES,
  KEYSPACE_SAMPLE_PAGES,
  MOBILE_TEST_PERSONA,
  NO_KEYS_SAMPLED,
  TEST_2FA_TOTP_SECRET,
  TEST_PERSONAS,
  assertE2eKeyspaceWithinCeiling,
  dominantKeyFamily,
  keyFamily,
  seedUUID,
  testPersonaName,
} from './seed.js';
import type { KeyspaceReader } from './seed.js';

describe('e2e re-exports (imported from scripts/seed.js)', () => {
  it('exposes the base and cross-product persona rosters', () => {
    expect(BASE_TEST_PERSONAS).toHaveLength(
      CORE_TEST_PERSONAS.length + POOLED_PERSONA_BASE_NAMES.length * (E2E_WORKER_POOL_SIZE - 1)
    );
    expect(TEST_PERSONAS).toHaveLength(BASE_TEST_PERSONAS.length * E2E_PROJECT_NAMES.length);
  });

  it('exposes the mobile and dev personas', () => {
    expect(MOBILE_TEST_PERSONA.name).toBe('test-mobile');
    expect(DEV_PERSONAS.map((persona) => persona.name)).toStrictEqual(['alice', 'bob', 'charlie']);
  });

  it('exposes the project names and the 2FA secret constant', () => {
    expect([...E2E_PROJECT_NAMES]).toContain('chromium');
    expect(TEST_2FA_TOTP_SECRET).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  });

  it('exposes the deterministic derivations', () => {
    expect(testPersonaName('test-alice', 'chromium')).toBe('test-alice-chromium');
    expect(seedUUID('anything')).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
  });
});

describe('admin op-target persona', () => {
  it('carries a negative purchased balance and stays out of the demo roster', () => {
    expect(ADMIN_TARGET_PERSONA.balanceNanoUsd < 0n).toBe(true);
    expect(DEV_PERSONAS.map((persona) => persona.name)).not.toContain(ADMIN_TARGET_PERSONA.name);
  });
});

describe('keyFamily', () => {
  it('reports the leading two segments of a deep key', () => {
    expect(keyFamily('billing:admission:snapshot:wallet-1')).toBe('billing:admission');
  });

  it('stops at two segments, so a growth key never reports its time bucket', () => {
    expect(keyFamily('growth:h:bucket:views:/pricing')).toBe('growth:h');
  });

  it('drops the trailing segment of a two-segment key, so no identifier is reported', () => {
    expect(keyFamily('session:identifier')).toBe('session');
  });

  it('reports a key carrying no separator whole', () => {
    expect(keyFamily('standalone')).toBe('standalone');
  });
});

describe('dominantKeyFamily', () => {
  it('names the family most of the sampled keys belong to', () => {
    expect(
      dominantKeyFamily([
        'ratelimit:admin:read:dashboard:one',
        'growth:h:bucket:views:/',
        'growth:h:bucket:landings:/',
      ])
    ).toBe('growth:h');
  });

  it('keeps the first family seen when two tie', () => {
    expect(dominantKeyFamily(['growth:h:bucket:views:/', 'billing:admission:snapshot:w'])).toBe(
      'growth:h'
    );
  });

  it('reports the empty sentinel when nothing was sampled', () => {
    expect(dominantKeyFamily([])).toBe(NO_KEYS_SAMPLED);
  });
});

/** A keyspace of a declared size whose every key carries the given family. */
function stubKeyspace(keys: number, family: string): KeyspaceReader {
  return {
    dbsize: () => Promise.resolve(keys),
    scan: (_cursor: string, options: { count: number }) =>
      Promise.resolve<[string, string[]]>([
        '0',
        Array.from({ length: Math.min(keys, options.count) }, (_value, index) =>
          [family, `identifier-${index.toString()}`].join(':')
        ),
      ]),
  };
}

describe('assertE2eKeyspaceWithinCeiling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a keyspace sitting exactly at the ceiling', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(
      assertE2eKeyspaceWithinCeiling(stubKeyspace(E2E_KEYSPACE_CEILING, 'billing:admission'))
    ).resolves.toBeUndefined();
  });

  it('reports the observed count and the dominant family on the run that passes', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await assertE2eKeyspaceWithinCeiling(stubKeyspace(331, 'billing:admission'));
    expect(logged.mock.calls.flat().join(' ')).toContain('331');
    expect(logged.mock.calls.flat().join(' ')).toContain('billing:admission');
  });

  it('refuses a keyspace re-inflated to the size a history seed produces', async () => {
    await expect(assertE2eKeyspaceWithinCeiling(stubKeyspace(13_831, 'growth:h'))).rejects.toThrow(
      /13831/
    );
  });

  it('names the ceiling and the dominant family in the refusal', async () => {
    await expect(assertE2eKeyspaceWithinCeiling(stubKeyspace(13_831, 'growth:h'))).rejects.toThrow(
      /growth:h/
    );
  });

  it('takes the count from the database rather than from the sample it scans', async () => {
    await expect(
      assertE2eKeyspaceWithinCeiling({
        dbsize: () => Promise.resolve(E2E_KEYSPACE_CEILING + 1),
        scan: () => Promise.resolve<[string, string[]]>(['0', []]),
      })
    ).rejects.toThrow(NO_KEYS_SAMPLED);
  });

  it('accepts a caller-supplied ceiling in place of the declared one', async () => {
    await expect(assertE2eKeyspaceWithinCeiling(stubKeyspace(2, 'growth:h'), 1)).rejects.toThrow(
      /2 keys/
    );
  });

  it('bounds the pages it scans when the cursor never returns to its start', async () => {
    let pages = 0;
    await expect(
      assertE2eKeyspaceWithinCeiling({
        dbsize: () => Promise.resolve(E2E_KEYSPACE_CEILING + 1),
        scan: () => {
          pages += 1;
          return Promise.resolve<[string, string[]]>(['42', ['growth:h:bucket:views:/']]);
        },
      })
    ).rejects.toThrow(/growth:h/);
    expect(pages).toBe(KEYSPACE_SAMPLE_PAGES);
  });
});
