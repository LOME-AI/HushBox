import { describe, it, expect } from 'vitest';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import {
  registerDeviceToken,
  registerDeviceTokenSchema,
  registerWebSubscription,
  registerWebSubscriptionSchema,
  unregisterDeviceToken,
} from './device-tokens.js';
import type { DeviceTokenRegistration, DeviceTokenStore } from '../ports/index.js';

function storeWith(overrides: Partial<DeviceTokenStore>): DeviceTokenStore {
  return {
    upsert: () => okAsync(),
    deleteByToken: () => okAsync(null),
    listTokensForUsers: () => okAsync([]),
    touchLastSeen: () => okAsync(),
    ...overrides,
  };
}

describe('registerDeviceTokenSchema', () => {
  it('accepts a token with a known platform', () => {
    const parsed = registerDeviceTokenSchema.parse({ token: 'tok-1', platform: 'ios' });

    expect(parsed).toEqual({ token: 'tok-1', platform: 'ios' });
  });

  it('rejects an empty token', () => {
    expect(registerDeviceTokenSchema.safeParse({ token: '', platform: 'ios' }).success).toBe(false);
  });

  it('rejects an unknown platform', () => {
    expect(
      registerDeviceTokenSchema.safeParse({ token: 'tok-1', platform: 'windows' }).success
    ).toBe(false);
  });
});

describe('registerDeviceToken', () => {
  it('upserts the registration for the owning user', async () => {
    const seen: DeviceTokenRegistration[] = [];
    const store = storeWith({
      upsert: (registration) => {
        seen.push(registration);
        return okAsync();
      },
    });

    const result = await registerDeviceToken(store, 'user-1', {
      token: 'tok-1',
      platform: 'android',
    });

    expect(result.isOk()).toBe(true);
    expect(seen).toEqual([{ userId: 'user-1', token: 'tok-1', platform: 'android' }]);
  });

  it('propagates a store failure', async () => {
    const store = storeWith({ upsert: () => errAsync(unavailableError('insert failed')) });

    const result = await registerDeviceToken(store, 'user-1', {
      token: 'tok-1',
      platform: 'ios',
    });

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

// RFC 8291 Appendix A user-agent public key (65-byte uncompressed P-256 point)
// and its 16-byte auth secret, base64url. Inert test fixtures.
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

describe('registerWebSubscriptionSchema', () => {
  const valid = {
    endpoint: 'https://push.example.com/sub/abc',
    keys: { p256dh: P256DH, auth: AUTH },
  };

  it('accepts a well-formed subscription', () => {
    expect(registerWebSubscriptionSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a non-URL endpoint', () => {
    expect(
      registerWebSubscriptionSchema.safeParse({ ...valid, endpoint: 'not-a-url' }).success
    ).toBe(false);
  });

  it('rejects a missing key', () => {
    expect(
      registerWebSubscriptionSchema.safeParse({ endpoint: valid.endpoint, keys: { p256dh: 'x' } })
        .success
    ).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(registerWebSubscriptionSchema.safeParse({ ...valid, platform: 'web' }).success).toBe(
      false
    );
  });

  it('rejects a p256dh outside the base64url alphabet', () => {
    const bad = { ...valid, keys: { ...valid.keys, p256dh: `${P256DH.slice(0, 86)}+` } };

    expect(registerWebSubscriptionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a p256dh that does not decode to 65 bytes', () => {
    const bad = {
      ...valid,
      keys: { ...valid.keys, p256dh: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' },
    };

    expect(registerWebSubscriptionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a p256dh that is not an uncompressed point', () => {
    const compressed = `Ai${P256DH.slice(2)}`;
    const bad = { ...valid, keys: { ...valid.keys, p256dh: compressed } };

    expect(registerWebSubscriptionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an auth outside the base64url alphabet', () => {
    const bad = { ...valid, keys: { ...valid.keys, auth: `${AUTH.slice(0, 21)}/` } };

    expect(registerWebSubscriptionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an auth that does not decode to 16 bytes', () => {
    const bad = { ...valid, keys: { ...valid.keys, auth: 'AAECAwQFBgcICQoLDA0O' } };

    expect(registerWebSubscriptionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('registerWebSubscription', () => {
  it('upserts a web row keyed by endpoint with the subscription keys', async () => {
    const seen: DeviceTokenRegistration[] = [];
    const store = storeWith({
      upsert: (registration) => {
        seen.push(registration);
        return okAsync();
      },
    });

    const result = await registerWebSubscription(store, 'user-1', {
      endpoint: 'https://push.example.com/sub/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });

    expect(result.isOk()).toBe(true);
    expect(seen).toEqual([
      {
        userId: 'user-1',
        token: 'https://push.example.com/sub/abc',
        platform: 'web',
        p256dh: 'p256dh-value',
        auth: 'auth-value',
      },
    ]);
  });

  it('propagates a store failure', async () => {
    const store = storeWith({ upsert: () => errAsync(unavailableError('insert failed')) });

    const result = await registerWebSubscription(store, 'user-1', {
      endpoint: 'https://push.example.com/sub/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('unregisterDeviceToken', () => {
  it('transitions to true when the store deletes a row', async () => {
    const store = storeWith({ deleteByToken: () => okAsync(true) });

    const result = await unregisterDeviceToken(store, 'user-1', 'tok-1').transition();

    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('transitions to null when the token is already absent', async () => {
    const store = storeWith({ deleteByToken: () => okAsync(null) });

    const result = await unregisterDeviceToken(store, 'user-1', 'tok-1').transition();

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('disambiguates zero rows as an already-deleted no-op', async () => {
    const result = await unregisterDeviceToken(storeWith({}), 'user-1', 'tok-1').onZeroRows();

    expect(result._unsafeUnwrap()).toBe(false);
  });
});
