import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  deriveOpaqueKek,
  finishRegistration,
  opaqueKekFingerprint,
  rewrapAccountKeyForPasswordChange,
  startRegistration,
} from '@hushbox/crypto';
import { textEncoder, toBase64 } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { rotatePasswordCredentials } from './credentials.js';
import { deserializeRegistrationRequest, runNewPasswordRegisterInit } from './opaque.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../../lib/result/index.js';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  IdentityUserRecord,
  IdentityUsersStore,
  PasswordChangedEmailPort,
  RotatePasswordOutcome,
} from '../../ports/index.js';
import type { NewPasswordInit } from './opaque.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const KEK = deriveOpaqueKek(textEncoder.encode('credentials-kek-at-least-32-characters!!'));
const OTHER_KEK = deriveOpaqueKek(textEncoder.encode('other-kek-at-least-32-characters-long!!!'));
/** The record the init round observed; the rotate compare-and-swaps on it. */
const OBSERVED_REGISTRATION = new Uint8Array([1, 2, 3]);
/** A shape-valid rotation blob: the rotate path refuses anything else. */
const WRAPPED_KEY = toBase64(
  rewrapAccountKeyForPasswordChange(new Uint8Array(32).fill(4), new Uint8Array(32).fill(5))
);

/** A real OPAQUE registration record, produced by the full client/server dance, with its pinned init. */
async function validRecord(userId: string): Promise<{ record: number[]; init: NewPasswordInit }> {
  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, 'rotated password');
  const request = deserializeRegistrationRequest(serialized)._unsafeUnwrap();
  const init = await unwrap(runNewPasswordRegisterInit(KEK, userId, request));
  const { record } = await finishRegistration(
    client,
    init.registrationResponse,
    OPAQUE_SERVER_IDENTIFIER
  );
  return { record, init };
}

interface SentNotification {
  readonly to: string;
  readonly userName?: string;
}

function recordingPort(result: () => ResultAsync<void, DomainError>): {
  port: PasswordChangedEmailPort;
  sends: SentNotification[];
} {
  const sends: SentNotification[] = [];
  const port: PasswordChangedEmailPort = {
    sendPasswordChangedEmail: (args) => {
      sends.push({
        to: args.to,
        ...(args.userName !== undefined && { userName: args.userName }),
      });
      return result();
    },
  };
  return { port, sends };
}

interface StoreHarness {
  store: IdentityUsersStore;
  events: string[];
}

function fakeStore(args: {
  user: Pick<IdentityUserRecord, 'id' | 'email' | 'username'> | null;
  rotateResult?: () => ResultAsync<RotatePasswordOutcome, DomainError>;
  findByIdResult?: () => ResultAsync<IdentityUserRecord | null, DomainError>;
}): StoreHarness {
  const events: string[] = [];
  const store = {
    findById: (): ResultAsync<IdentityUserRecord | null, DomainError> => {
      events.push('findById');
      return args.findByIdResult === undefined
        ? okAsync(args.user as IdentityUserRecord | null)
        : args.findByIdResult();
    },
    rotatePassword: (): ResultAsync<RotatePasswordOutcome, DomainError> => {
      events.push('rotate');
      return args.rotateResult === undefined ? okAsync('rotated') : args.rotateResult();
    },
  } as unknown as IdentityUsersStore;
  return { store, events };
}

interface RecordingTelemetry extends Telemetry {
  readonly warnings: { msg: string; fields?: SafeLogFields }[];
}

function recordingTelemetry(): RecordingTelemetry {
  const warnings: { msg: string; fields?: SafeLogFields }[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warnings.push(fields === undefined ? { msg } : { msg, fields });
    },
    error: () => {},
    captureError: () => {},
  };
}

describe('rotatePasswordCredentials password-changed notification', () => {
  const user = {
    id: crypto.randomUUID(),
    email: 'rotated@identity-domain.test',
    username: 'rotated-user',
  };

  /** The rotation inputs a finish round carries from its pinned init. */
  async function pins(): Promise<{
    opaqueKek: typeof KEK;
    observedRegistration: Uint8Array;
    serverMaterial: Uint8Array;
    kekFingerprint: Uint8Array;
    newRegistrationRecord: number[];
  }> {
    const { record, init } = await validRecord(user.id);
    return {
      opaqueKek: KEK,
      observedRegistration: OBSERVED_REGISTRATION,
      serverMaterial: init.serverMaterial,
      kekFingerprint: init.kekFingerprint,
      newRegistrationRecord: record,
    };
  }

  async function rotate(
    harness: StoreHarness,
    port: PasswordChangedEmailPort,
    logger: Telemetry = recordingTelemetry()
  ): Promise<boolean> {
    const { record, init } = await validRecord(user.id);
    const result = await rotatePasswordCredentials({
      redis,
      store: harness.store,
      notify: (notice) => port.sendPasswordChangedEmail(notice),
      logger,
      userId: user.id,
      opaqueKek: KEK,
      observedRegistration: OBSERVED_REGISTRATION,
      serverMaterial: init.serverMaterial,
      kekFingerprint: init.kekFingerprint,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
    });
    return result.isOk() && result.value === 'rotated';
  }

  it('refuses with kek-rotated, touching no store, when the pinned fingerprint is not the live KEK', async () => {
    const harness = fakeStore({ user });
    const { port, sends } = recordingPort(() => okAsync());
    const { record, init } = await validRecord(user.id);
    const result = await rotatePasswordCredentials({
      redis,
      store: harness.store,
      notify: (notice) => port.sendPasswordChangedEmail(notice),
      logger: recordingTelemetry(),
      userId: user.id,
      opaqueKek: OTHER_KEK,
      observedRegistration: OBSERVED_REGISTRATION,
      serverMaterial: init.serverMaterial,
      kekFingerprint: init.kekFingerprint,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
    });
    expect(result._unsafeUnwrap()).toBe('kek-rotated');
    expect(harness.events).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('answers credential-conflict without staling sessions or notifying when the swap loses', async () => {
    const harness = fakeStore({ user, rotateResult: () => okAsync('conflict') });
    const { port, sends } = recordingPort(() => okAsync());
    const { record, init } = await validRecord(user.id);
    const result = await rotatePasswordCredentials({
      redis,
      store: harness.store,
      notify: (notice) => port.sendPasswordChangedEmail(notice),
      logger: recordingTelemetry(),
      userId: user.id,
      opaqueKek: KEK,
      observedRegistration: OBSERVED_REGISTRATION,
      serverMaterial: init.serverMaterial,
      kekFingerprint: init.kekFingerprint,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
    });
    expect(result._unsafeUnwrap()).toBe('credential-conflict');
    expect(harness.events).toEqual(['rotate']);
    expect(sends).toEqual([]);
  });

  it('hands the store the observed record, the pinned material and its fingerprint', async () => {
    const seen: unknown[] = [];
    const store = {
      findById: () => okAsync(user as IdentityUserRecord),
      rotatePassword: (rotation: unknown) => {
        seen.push(rotation);
        return okAsync('rotated' as const);
      },
    } as unknown as IdentityUsersStore;
    const { record, init } = await validRecord(user.id);
    const outcome = await unwrap(
      rotatePasswordCredentials({
        redis,
        store,
        notify: () => okAsync(),
        logger: recordingTelemetry(),
        userId: user.id,
        opaqueKek: KEK,
        observedRegistration: OBSERVED_REGISTRATION,
        serverMaterial: init.serverMaterial,
        kekFingerprint: init.kekFingerprint,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: WRAPPED_KEY,
        now: Date.now(),
      })
    );
    expect(outcome).toBe('rotated');
    expect(seen[0]).toMatchObject({
      userId: user.id,
      observedRegistration: OBSERVED_REGISTRATION,
      opaqueServerMaterial: init.serverMaterial,
      opaqueKekFingerprint: opaqueKekFingerprint(KEK),
    });
  });

  it('sends the notification to the account email after the rotation commits', async () => {
    const harness = fakeStore({ user });
    const { port, sends } = recordingPort(() => okAsync());
    expect(await rotate(harness, port)).toBe(true);
    expect(sends).toEqual([{ to: user.email, userName: user.username }]);
    expect(harness.events.indexOf('rotate')).toBeLessThan(harness.events.indexOf('findById'));
  });

  it('sends nothing when the credential rotation fails', async () => {
    const harness = fakeStore({
      user,
      rotateResult: () => errAsync(unavailableError('store down')),
    });
    const { port, sends } = recordingPort(() => okAsync());
    expect(await rotate(harness, port)).toBe(false);
    expect(sends).toEqual([]);
  });

  it('still succeeds when the notification send fails', async () => {
    const harness = fakeStore({ user });
    const { port, sends } = recordingPort(() => errAsync(unavailableError('sender down')));
    expect(await rotate(harness, port)).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it('still succeeds, without sending, when the rotated user cannot be resolved', async () => {
    const harness = fakeStore({ user: null });
    const { port, sends } = recordingPort(() => okAsync());
    expect(await rotate(harness, port)).toBe(true);
    expect(sends).toEqual([]);
  });

  it('fans a realtime eviction out for the user after staling the sessions', async () => {
    const harness = fakeStore({ user });
    const { port } = recordingPort(() => okAsync());
    const evicted: string[] = [];
    const result = await rotatePasswordCredentials({
      redis,
      store: harness.store,
      notify: (notice) => port.sendPasswordChangedEmail(notice),
      logger: recordingTelemetry(),
      userId: user.id,
      ...(await pins()),
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
      evictUser: {
        evictUser: (id) => {
          evicted.push(id);
          return Promise.resolve();
        },
      },
    });
    expect(result.isOk()).toBe(true);
    expect(evicted).toEqual([user.id]);
  });

  it('still rotates when the eviction fan-out fails (best-effort)', async () => {
    const harness = fakeStore({ user });
    const { port } = recordingPort(() => okAsync());
    const result = await rotatePasswordCredentials({
      redis,
      store: harness.store,
      notify: (notice) => port.sendPasswordChangedEmail(notice),
      logger: recordingTelemetry(),
      userId: user.id,
      ...(await pins()),
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
      evictUser: { evictUser: () => Promise.reject(new Error('realtime unavailable')) },
    });
    expect(result.isOk()).toBe(true);
  });

  it('warns with the error code, still succeeding without a send, when the recipient lookup fails', async () => {
    const lookupError = unavailableError('store down');
    const harness = fakeStore({ user, findByIdResult: () => errAsync(lookupError) });
    const { port, sends } = recordingPort(() => okAsync());
    const logger = recordingTelemetry();
    expect(await rotate(harness, port, logger)).toBe(true);
    expect(sends).toEqual([]);
    expect(logger.warnings).toEqual([
      {
        msg: 'credential-rotation email recipient lookup failed',
        fields: { errorCode: lookupError.code },
      },
    ]);
  });
});
