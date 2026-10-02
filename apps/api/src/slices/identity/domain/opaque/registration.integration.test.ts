import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, ledgerEntries, users, wallets } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createAccount,
  createOpaqueClient,
  deriveOpaqueKek,
  finishRegistration,
  opaqueKekFingerprint,
  openServerMaterial,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { TERMS_OF_SERVICE_REVISION, textEncoder, toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { createBillingStores } from '../../../billing/index.js';
import { createIdentityStores } from '../../adapters/stores.js';
import { IDENTITY_KEYS } from '../keys.js';
import { createRegisterFinishFlow, startRegistration } from './registration.js';
import type { OpaqueKek } from '@hushbox/crypto';
import type { Result } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

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
const billingStores = createBillingStores();

const KEK = deriveOpaqueKek(textEncoder.encode('registration-kek-at-least-32-characters!'));
const ROTATED_KEK = deriveOpaqueKek(textEncoder.encode('rotated-kek-at-least-32-characters-long'));
const PREFIX = `reg${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`;
const createdUserIds: string[] = [];
let counter = 0;

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const welcomeKeys = createdUserIds.flatMap((id) => [
      `welcome:${id}:user`,
      `welcome:${id}:house`,
    ]);
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.idempotencyKey, welcomeKeys));
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/** A telemetry double: these suites assert on flow outcomes, never on reports. */
const silentLogger = { captureError: () => undefined } as unknown as Telemetry;

interface Started {
  readonly email: string;
  readonly registerSessionId: string;
  readonly registrationResponse: number[];
  readonly client: ReturnType<typeof createOpaqueClient>;
}

async function init(): Promise<Started> {
  counter += 1;
  const email = `${PREFIX}${String(counter)}@registration-domain.test`;
  const client = createOpaqueClient();
  const { serialized } = await opaqueClientStartRegistration(client, 'correct horse battery');
  const outcome = await startRegistration({
    store: stores.users,
    redis,
    secrets: { opaqueKek: KEK },
    email,
    username: `${PREFIX}${String(counter)}`,
    registrationRequest: serialized,
    now: Date.now(),
    growth: {
      campaignTag: undefined,
      address: '203.0.113.200',
      secret: 'a-growth-hash-secret-of-at-least-32-chars',
      listActiveTags: () => okAsync<readonly string[]>([]),
    },
    logger: silentLogger,
  });
  const started = outcome._unsafeUnwrap();
  if (started.kind !== 'started') throw new Error('expected a started registration');
  return { email, client, ...started };
}

async function readPending(
  registerSessionId: string
): Promise<{ userId: string; serverMaterial: Uint8Array; kekFingerprint: Uint8Array }> {
  const raw = await redis.get(IDENTITY_KEYS.opaquePendingRegistration.buildKey(registerSessionId));
  const pending = IDENTITY_KEYS.opaquePendingRegistration.schema.parse(raw);
  return {
    userId: pending.userId,
    serverMaterial: new Uint8Array(pending.serverMaterial),
    kekFingerprint: new Uint8Array(pending.kekFingerprint),
  };
}

async function finish(started: Started, kek: OpaqueKek): Promise<{ kind: string }> {
  const { record, exportKey } = await finishRegistration(
    started.client,
    started.registrationResponse,
    OPAQUE_SERVER_IDENTIFIER
  );
  const account = await createAccount(new Uint8Array(exportKey));
  const flow = createRegisterFinishFlow({
    listActiveTags: () => okAsync<readonly string[]>([]),
    logger: silentLogger,
    store: stores.users,
    redis,
    db,
    billingStores,
    verificationStore: stores.verification,
    welcomeEmail: { sendWelcomeEmail: () => okAsync() },
    verificationEmail: { sendVerificationEmail: () => okAsync() },
    secrets: { opaqueKek: kek },
    email: started.email,
    registerSessionId: started.registerSessionId,
    registrationRecord: record,
    accountPublicKey: toBase64(account.publicKey),
    passwordWrappedPrivateKey: toBase64(account.passwordWrappedPrivateKey),
    recoveryWrappedPrivateKey: toBase64(account.recoveryWrappedPrivateKey),
    recoveryPublicKey: toBase64(account.recoveryPublicKey),
    now: Date.now(),
    acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
  });
  const claimed = await flow.claim();
  expect(claimed._unsafeUnwrap()).toBe(true);
  const outcome = await unwrap(flow.execute());
  if (outcome.kind === 'created') createdUserIds.push(outcome.userId);
  return outcome;
}

describe('registration pins per-user server material at init', () => {
  it('stores material that opens under the KEK for the pending user id, with the KEK fingerprint', async () => {
    const started = await init();
    const pending = await readPending(started.registerSessionId);
    expect(pending.kekFingerprint).toEqual(opaqueKekFingerprint(KEK));
    expect(pending.serverMaterial.subarray(0, 8)).toEqual(pending.kekFingerprint);
    expect(() => openServerMaterial(KEK, pending.userId, pending.serverMaterial)).not.toThrow();
  });

  it('writes exactly the pinned blob and fingerprint into the users row at finish', async () => {
    const started = await init();
    const pending = await readPending(started.registerSessionId);
    const outcome = await finish(started, KEK);
    expect(outcome.kind).toBe('created');
    const rows = await db.select().from(users).where(eq(users.id, pending.userId));
    expect(rows[0]?.opaqueServerMaterial).toEqual(pending.serverMaterial);
    expect(rows[0]?.opaqueKekFingerprint).toEqual(pending.kekFingerprint);
  });

  it('refuses the finish with kek-rotated, inserting nothing, when the live KEK is not the pinned one', async () => {
    const started = await init();
    const pending = await readPending(started.registerSessionId);
    const outcome = await finish(started, ROTATED_KEK);
    expect(outcome).toEqual({ kind: 'kek-rotated' });
    const rows = await db.select().from(users).where(eq(users.id, pending.userId));
    expect(rows).toHaveLength(0);
  });
});
