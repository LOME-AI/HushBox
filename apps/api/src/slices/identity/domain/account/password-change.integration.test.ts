import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
  createOpaqueClient,
  createOpaqueServer,
  deriveOpaqueKek,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration,
  mintServerMaterial,
  opaqueKekFingerprint,
  rewrapAccountKeyForPasswordChange,
  sealServerMaterial,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { textEncoder, toBase64 } from '@hushbox/shared';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { redisSet } from '../../../../lib/redis/index.js';
import { okAsync } from '../../../../lib/result/index.js';
import { createIdentityStores } from '../../adapters/stores.js';
import { IDENTITY_KEYS } from '../keys.js';
import { createPasswordChangeFinishFlow, startPasswordChange } from './password-change.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { PasswordChangedEmailPort } from '../../ports/index.js';
import type { Result } from '../../../../lib/result/index.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Upstash vars are required');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const stores = createIdentityStores(db);

const KEK = deriveOpaqueKek(textEncoder.encode('password-change-kek-at-least-32-chars!!!'));
const PASSWORD = 'correct horse battery';
const PREFIX = `pwc${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`;
const WRAPPED_KEY = toBase64(
  rewrapAccountKeyForPasswordChange(new Uint8Array(32).fill(4), new Uint8Array(32).fill(5))
);
const createdUserIds: string[] = [];
let counter = 0;

const emailPort: PasswordChangedEmailPort = { sendPasswordChangedEmail: () => okAsync() };
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
} as unknown as Telemetry;

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/** A registered account on minted material sealed under the KEK, inserted through the store. */
async function registeredUser(): Promise<string> {
  counter += 1;
  const id = crypto.randomUUID();
  const material = await mintServerMaterial();
  const server = createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);
  const client = createOpaqueClient();
  const { serialized } = await opaqueClientStartRegistration(client, PASSWORD);
  const request = OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized);
  const response = await server.registerInit(request, id);
  if (response instanceof Error) throw response;
  const { record } = await finishRegistration(
    client,
    response.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );
  const outcome = await runSettlement(db, (tx) =>
    stores.users.insertRegisteredWithinTx(tx, {
      id,
      email: `${PREFIX}${String(counter)}@password-change-domain.test`,
      username: `${PREFIX}${String(counter)}`,
      opaqueRegistration: new Uint8Array(record),
      opaqueServerMaterial: sealServerMaterial(KEK, id, material),
      opaqueKekFingerprint: opaqueKekFingerprint(KEK),
      publicKey: new Uint8Array(32).fill(1),
      passwordWrappedPrivateKey: new Uint8Array(48).fill(2),
      recoveryWrappedPrivateKey: new Uint8Array(48).fill(3),
      recoveryPublicKey: new Uint8Array(32).fill(4),
    })
  );
  if (outcome.kind !== 'created') throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

interface Started {
  readonly ke3: number[];
  readonly record: number[];
  readonly changePasswordSessionId: string;
}

/** Round one: the step-up over the live password and a fresh registration for the new one. */
async function init(userId: string, newPassword: string): Promise<Started> {
  const stepClient = createOpaqueClient();
  const { ke1 } = await opaqueClientStartLogin(stepClient, PASSWORD);
  const newClient = createOpaqueClient();
  const { serialized } = await opaqueClientStartRegistration(newClient, newPassword);
  const outcome = await unwrap(
    startPasswordChange({
      redis,
      store: stores.users,
      secrets: { opaqueKek: KEK },
      userId,
      ke1,
      newRegistrationRequest: serialized,
    })
  );
  if (outcome.kind !== 'started') throw new Error(`expected started, got ${outcome.kind}`);
  const { ke3 } = await opaqueClientFinishLogin(stepClient, outcome.ke2, OPAQUE_SERVER_IDENTIFIER);
  const { record } = await finishRegistration(
    newClient,
    outcome.newRegistrationResponse,
    OPAQUE_SERVER_IDENTIFIER
  );
  return { ke3, record, changePasswordSessionId: outcome.changePasswordSessionId };
}

async function finish(userId: string, started: Started): Promise<{ kind: string }> {
  const flow = createPasswordChangeFinishFlow({
    redis,
    store: stores.users,
    secrets: { opaqueKek: KEK },
    emailPort,
    logger,
    userId,
    ke3: started.ke3,
    changePasswordSessionId: started.changePasswordSessionId,
    newRegistrationRecord: started.record,
    newPasswordWrappedPrivateKey: WRAPPED_KEY,
    now: Date.now(),
  });
  expect(await unwrap(flow.claim())).toBe(true);
  const outcome = await unwrap(flow.execute());
  if (outcome.kind !== 'verified') throw new Error(`expected verified, got ${outcome.kind}`);
  return outcome.value;
}

describe('a change-password finish over a handshake stored without a rotation pin', () => {
  it('throws the defect instead of rotating', async () => {
    const userId = await registeredUser();
    const started = await init(userId, `${PASSWORD} unpinned`);
    const stored = IDENTITY_KEYS.opaquePendingChangePassword.schema.parse(
      await redis.get(
        IDENTITY_KEYS.opaquePendingChangePassword.buildKey(started.changePasswordSessionId)
      )
    );
    // The same verifiable handshake, minus the pin only this flow's init writes.
    await unwrap(
      redisSet(
        redis,
        IDENTITY_KEYS.opaquePendingChangePassword,
        { userId: stored.userId, expectedSerialized: stored.expectedSerialized },
        started.changePasswordSessionId
      )
    );
    const flow = createPasswordChangeFinishFlow({
      redis,
      store: stores.users,
      secrets: { opaqueKek: KEK },
      emailPort,
      logger,
      userId,
      ke3: started.ke3,
      changePasswordSessionId: started.changePasswordSessionId,
      newRegistrationRecord: started.record,
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
    });
    expect(await unwrap(flow.claim())).toBe(true);
    await expect(Promise.resolve(flow.execute())).rejects.toThrow('without a rotation pin');
  });
});

describe('two password changes started on the same record', () => {
  it('lets exactly one win; the other answers credential-conflict and writes nothing', async () => {
    const userId = await registeredUser();
    const first = await init(userId, `${PASSWORD} one`);
    const second = await init(userId, `${PASSWORD} two`);

    expect(await finish(userId, first)).toEqual({ kind: 'rotated' });
    const before = await unwrap(stores.users.findById(userId));

    expect(await finish(userId, second)).toEqual({ kind: 'credential-conflict' });
    const after = await unwrap(stores.users.findById(userId));
    expect(after?.opaqueRegistration).toEqual(before?.opaqueRegistration);
    expect(after?.opaqueServerMaterial).toEqual(before?.opaqueServerMaterial);
  });
});
