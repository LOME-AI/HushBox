import { afterEach, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import * as cryptoModule from '@hushbox/crypto';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  deriveOpaqueKek,
  deriveServerMaterial,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration,
  mintServerMaterial,
  opaqueKekFingerprint,
  sealServerMaterial,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { IDENTITY_KEYS, loginNetworkLockoutKey } from '../keys.js';
import { createLoginFinishFlow, startLogin } from './login.js';
import { rateLimitKey } from '../../../../lib/rate-limit/index.js';
import type { OpaqueKek } from '@hushbox/crypto';
import type {
  AccountLockedEmailPort,
  IdentityUserRecord,
  IdentityUsersStore,
} from '../../ports/index.js';
import type { IdentitySecrets } from './opaque.js';
import type { Result } from '../../../../lib/result/index.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

vi.mock('@hushbox/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/crypto')>();
  return { ...actual, openServerMaterial: vi.fn(actual.openServerMaterial) };
});

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const KEK_A = deriveOpaqueKek(textEncoder.encode('login-kek-a-at-least-32-characters-long!'));
const KEK_B = deriveOpaqueKek(textEncoder.encode('login-kek-b-at-least-32-characters-long!'));
const PASSWORD = 'correct horse battery';
/** A stand-in for a resolved caller network identity (a SHA-256 hex digest). */
const NETWORK = 'a'.repeat(64);
const DECOY_SECRET = 'login-decoy-at-least-32-characters-long!';
const OTHER_DECOY_SECRET = 'login-decoy-other-at-least-32-characters!';

function secrets(
  kek: OpaqueKek,
  decoySecret = DECOY_SECRET
): Pick<IdentitySecrets, 'opaqueKek' | 'enumerationDecoySecret'> {
  return { opaqueKek: kek, enumerationDecoySecret: textEncoder.encode(decoySecret) };
}

/** Starts a login for an identifier no row holds, under `s`. */
async function startUnknownLogin(
  s: Pick<IdentitySecrets, 'opaqueKek' | 'enumerationDecoySecret'>
): Promise<string> {
  const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), PASSWORD);
  const outcome = await startLogin({
    store: storeHolding(null),
    redis,
    secrets: s,
    identifier: `${crypto.randomUUID()}@login-domain.test`,
    ke1,
    callerNetworkId: NETWORK,
    accountLockedEmail,
  });
  return outcome._unsafeUnwrap().kind;
}

const accountLockedEmail: AccountLockedEmailPort = { sendAccountLockedEmail: () => okAsync() };

/** A registered account: its record produced on minted material sealed under `kek`. */
async function registeredUser(kek: OpaqueKek): Promise<IdentityUserRecord> {
  const id = crypto.randomUUID();
  const material = await mintServerMaterial();
  const server = cryptoModule.createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);
  const client = createOpaqueClient();
  const { serialized } = await opaqueClientStartRegistration(client, PASSWORD);
  const request = cryptoModule.OpaqueServerRegistrationRequest.deserialize(
    cryptoModule.OpaqueServerConfig,
    serialized
  );
  const response = await server.registerInit(request, id);
  if (response instanceof Error) throw response;
  const { record } = await finishRegistration(
    client,
    response.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );
  return {
    id,
    email: `${id}@login-domain.test`,
    username: `u${id.replaceAll('-', '').slice(0, 12)}`,
    opaqueRegistration: new Uint8Array(record),
    opaqueServerMaterial: sealServerMaterial(kek, id, material),
    opaqueKekFingerprint: opaqueKekFingerprint(kek),
    publicKey: new Uint8Array(32),
    passwordWrappedPrivateKey: new Uint8Array(48),
    recoveryWrappedPrivateKey: new Uint8Array(48),
    recoveryPublicKey: new Uint8Array(32),
    totpSecretEncrypted: null,
    totpEnabled: false,
    lockedAt: null,
    emailVerified: true,
    hasAcknowledgedPhrase: false,
  };
}

function storeHolding(user: IdentityUserRecord | null): IdentityUsersStore {
  return {
    findByEmail: (email: string) => okAsync(user?.email === email ? user : null),
    findByUsername: (username: string) => okAsync(user?.username === username ? user : null),
    findById: (id: string) => okAsync(user?.id === id ? user : null),
  } as unknown as IdentityUsersStore;
}

describe('login on per-user server material', () => {
  afterEach(() => {
    vi.mocked(cryptoModule.openServerMaterial).mockClear();
  });

  it('completes register → login when the row opens under the live KEK', async () => {
    const user = await registeredUser(KEK_A);
    const store = storeHolding(user);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, PASSWORD);
    const started = await unwrap(
      startLogin({
        store,
        redis,
        secrets: secrets(KEK_A),
        identifier: user.email,
        ke1,
        callerNetworkId: NETWORK,
        accountLockedEmail,
      })
    );
    if (started.kind !== 'started') throw new Error(`expected started, got ${started.kind}`);
    const { ke3 } = await opaqueClientFinishLogin(client, started.ke2, OPAQUE_SERVER_IDENTIFIER);
    const flow = createLoginFinishFlow({
      store,
      redis,
      identifier: user.email,
      ke3,
      loginSessionId: started.loginSessionId,
      callerNetworkId: NETWORK,
      request: new Request('http://localhost/auth/login/finish'),
      response: new Response(),
      secret: 'secret-at-least-32-characters-long!!',
      isProduction: false,
      now: Date.now(),
    });
    expect(await unwrap(flow.claim())).toBe(true);
    const outcome = await unwrap(flow.execute());
    expect(outcome.kind).toBe('logged-in');
  });

  it('answers server-material-unreadable, never auth-failed, when the row was sealed under another KEK', async () => {
    const user = await registeredUser(KEK_A);
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), PASSWORD);
    const outcome = await startLogin({
      store: storeHolding(user),
      redis,
      secrets: secrets(KEK_B),
      identifier: user.email,
      ke1,
      callerNetworkId: NETWORK,
      accountLockedEmail,
    });
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'server-material-unreadable' });
  });

  it('opens a decoy blob for an unknown identifier, so its timing matches a real row', async () => {
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), PASSWORD);
    const outcome = await startLogin({
      store: storeHolding(null),
      redis,
      secrets: secrets(KEK_A),
      identifier: `${crypto.randomUUID()}@login-domain.test`,
      ke1,
      callerNetworkId: NETWORK,
      accountLockedEmail,
    });
    expect(outcome._unsafeUnwrap().kind).toBe('started');
    expect(cryptoModule.openServerMaterial).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cryptoModule.openServerMaterial).mock.calls[0]?.[0]).toBe(KEK_A);
  });

  it('still answers started for an unknown identifier after the KEK changes, opening under the new KEK', async () => {
    expect(await startUnknownLogin(secrets(KEK_A))).toBe('started');
    expect(await startUnknownLogin(secrets(KEK_B))).toBe('started');
    expect(cryptoModule.openServerMaterial).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cryptoModule.openServerMaterial).mock.calls[1]?.[0]).toBe(KEK_B);
  });

  it('rebuilds the decoy blob when the decoy secret changes', async () => {
    expect(await startUnknownLogin(secrets(KEK_A, DECOY_SECRET))).toBe('started');
    expect(await startUnknownLogin(secrets(KEK_A, OTHER_DECOY_SECRET))).toBe('started');
    expect(vi.mocked(cryptoModule.openServerMaterial).mock.results[1]?.value).toEqual(
      await deriveServerMaterial(textEncoder.encode(OTHER_DECOY_SECRET))
    );
  });

  it('collapses a malformed KE3 at finish onto auth-failed', async () => {
    const user = await registeredUser(KEK_A);
    const store = storeHolding(user);
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), PASSWORD);
    const started = await unwrap(
      startLogin({
        store,
        redis,
        secrets: secrets(KEK_A),
        identifier: user.email,
        ke1,
        callerNetworkId: NETWORK,
        accountLockedEmail,
      })
    );
    if (started.kind !== 'started') throw new Error(`expected started, got ${started.kind}`);
    const flow = createLoginFinishFlow({
      store,
      redis,
      identifier: user.email,
      ke3: [1, 2, 3],
      loginSessionId: started.loginSessionId,
      callerNetworkId: NETWORK,
      request: new Request('http://localhost/auth/login/finish'),
      response: new Response(),
      secret: 'secret-at-least-32-characters-long!!',
      isProduction: false,
      now: Date.now(),
    });
    expect(await unwrap(flow.claim())).toBe(true);
    expect(await unwrap(flow.execute())).toEqual({ kind: 'auth-failed' });
  });

  it('refuses the attempt when the caller resolved to no network', async () => {
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), PASSWORD);

    const outcome = await startLogin({
      store: storeHolding(null),
      redis,
      secrets: secrets(KEK_A),
      identifier: `${crypto.randomUUID()}@login-domain.test`,
      ke1,
      callerNetworkId: null,
      accountLockedEmail,
    });

    // Half the route's bound cannot be keyed, and the sentinel it would key on
    // instead is one window every caller behind the same fault would share.
    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('clears only the account-wide counter when the finish caller resolved to no network', async () => {
    const user = await registeredUser(KEK_A);
    const store = storeHolding(user);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, PASSWORD);
    const started = await unwrap(
      startLogin({
        store,
        redis,
        secrets: secrets(KEK_A),
        identifier: user.email,
        ke1,
        callerNetworkId: NETWORK,
        accountLockedEmail,
      })
    );
    if (started.kind !== 'started') throw new Error(`expected started, got ${started.kind}`);
    const { ke3 } = await opaqueClientFinishLogin(client, started.ke2, OPAQUE_SERVER_IDENTIFIER);
    const flow = createLoginFinishFlow({
      store,
      redis,
      identifier: user.email,
      ke3,
      loginSessionId: started.loginSessionId,
      callerNetworkId: null,
      request: new Request('http://localhost/auth/login/finish'),
      response: new Response(),
      secret: 'secret-at-least-32-characters-long!!',
      isProduction: false,
      now: Date.now(),
    });
    expect(await unwrap(flow.claim())).toBe(true);

    const outcome = await unwrap(flow.execute());

    expect(outcome.kind).toBe('logged-in');
    expect(
      await redis.get(rateLimitKey(IDENTITY_KEYS.loginLockout, user.id)._unsafeUnwrap())
    ).toBeNull();
    // The window the init spent is keyed on a network this round could not
    // resolve, so it stands until it expires rather than being guessed at.
    expect(await redis.get(await loginNetworkLockoutKey(user.id, NETWORK))).toBe(1);
  });
});
