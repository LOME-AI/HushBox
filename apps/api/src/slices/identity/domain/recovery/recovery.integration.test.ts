import { describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { deriveOpaqueKek, rewrapAccountKeyForPasswordChange } from '@hushbox/crypto';
import { fromBase64, textEncoder } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { getRecoveryWrappedKey, startRecoveryReset } from './recovery.js';
import type { IdentityUsersStore } from '../../ports/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/** Every identifier is unknown: the store answers null for all lookups. */
const emptyStore = {
  findByEmail: () => okAsync(null),
  findByUsername: () => okAsync(null),
} as unknown as IdentityUsersStore;

/** Blob index of the final X25519 ephemeral-public-key byte (key spans 1..32). */
const EPHEMERAL_KEY_END_INDEX = 32;
const MSB = 0x80;

/** A resolved caller network, as the routes hand one to these flows. */
const NETWORK = 'f0';

const DECOY_SECRET = textEncoder.encode('decoy-at-least-32-characters-long!!!');

const KEK = deriveOpaqueKek(textEncoder.encode('recovery-kek-at-least-32-characters!!'));

async function dummyFor(identifier: string): Promise<Uint8Array> {
  const outcome = await getRecoveryWrappedKey({
    redis,
    store: emptyStore,
    secrets: { enumerationDecoySecret: DECOY_SECRET },
    identifier,
    callerNetworkId: NETWORK,
  });
  const value = outcome._unsafeUnwrap();
  if (value.kind !== 'ok') throw new Error('expected an ok outcome');
  return fromBase64(value.recoveryWrappedPrivateKey);
}

describe('recovery dummy X25519 canonical key-space', () => {
  it('keeps the ephemeral-key top bit clear on every derived dummy', async () => {
    const run = crypto.randomUUID();
    const dummies = await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        dummyFor(`dummy-msb-${run}-${String(index)}@identity-domain.test`)
      )
    );
    const withTopBit = dummies.filter((blob) => ((blob[EPHEMERAL_KEY_END_INDEX] ?? 0) & MSB) !== 0);
    expect(withTopBit).toHaveLength(0);
  });

  it('matches the real wraps, whose canonical keys never set that bit', () => {
    const withTopBit = Array.from({ length: 64 }, () => {
      const privateKey = crypto.getRandomValues(new Uint8Array(32));
      const exportKey = crypto.getRandomValues(new Uint8Array(32));
      return rewrapAccountKeyForPasswordChange(privateKey, exportKey);
    }).filter((blob) => ((blob[EPHEMERAL_KEY_END_INDEX] ?? 0) & MSB) !== 0);
    expect(withTopBit).toHaveLength(0);
  });
});

describe('recovery rounds whose caller resolved to no network', () => {
  // Half of each round's bound cannot be keyed, and the sentinel it would key
  // on instead is one window every caller behind the same fault would share.
  it('refuses the wrapped-key read', async () => {
    const outcome = await getRecoveryWrappedKey({
      redis,
      store: emptyStore,
      secrets: { enumerationDecoySecret: DECOY_SECRET },
      identifier: `${crypto.randomUUID()}@identity-domain.test`,
      callerNetworkId: null,
    });

    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('refuses the reset init', async () => {
    const outcome = await startRecoveryReset({
      redis,
      store: emptyStore,
      secrets: { opaqueKek: KEK, enumerationDecoySecret: DECOY_SECRET },
      identifier: `${crypto.randomUUID()}@identity-domain.test`,
      newRegistrationRequest: [1],
      callerNetworkId: null,
    });

    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('module-scope purity', () => {
  it('draws no CSPRNG bytes at module evaluation', async () => {
    vi.resetModules();
    const randomSpy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      await import('./recovery.js');
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
      vi.resetModules();
    }
  });
});
