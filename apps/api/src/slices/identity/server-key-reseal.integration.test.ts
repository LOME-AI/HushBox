import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
  createOpaqueClient,
  createOpaqueServer,
  decryptTotpSecret,
  deriveOpaqueKek,
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration,
  mintServerMaterial,
  opaqueKekFingerprint,
  openServerMaterial,
  sealServerMaterial,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { textEncoder } from '@hushbox/shared';
import {
  TEMPLATE_DATABASE,
  createDatabaseSql,
  dropDatabaseSql,
  withDatabaseName,
} from '@hushbox/db/test-db';
import { runSettlement } from '../../lib/idempotency/index.js';
import { okAsync } from '../../lib/result/index.js';
import { createIdentityStores } from './adapters/stores.js';
import { setEmailVerified } from './adapters/dev-fixtures.js';
import { createLoginFinishFlow, startLogin } from './domain/opaque/login.js';
import type { Database } from '@hushbox/db';
import type { AccountLockedEmailPort, RegistrationValues } from './ports/index.js';
import type { Result } from '../../lib/result/index.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the server-key re-seal integration tests`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createIdentityStores(db);

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const accountLockedEmail: AccountLockedEmailPort = { sendAccountLockedEmail: () => okAsync() };

/** Unique per module load: a worker slot's database outlives the file that ran on it. */
const PREFIX = `zr${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BLOB = {
  opaqueRegistration: new Uint8Array([1, 2, 3]),
  opaqueServerMaterial: new Uint8Array([16, 17, 18]),
  opaqueKekFingerprint: new Uint8Array([19, 20, 21]),
  publicKey: new Uint8Array([4, 5, 6]),
  passwordWrappedPrivateKey: new Uint8Array([7, 8, 9]),
  recoveryWrappedPrivateKey: new Uint8Array([10, 11, 12]),
  recoveryPublicKey: new Uint8Array([13, 14, 15]),
};

const TOTP_BLOB = new Uint8Array([61, 62, 63]);
const NEXT_TOTP_BLOB = new Uint8Array([71, 72, 73]);

function registrationValues(suffix: string): RegistrationValues {
  return {
    id: crypto.randomUUID(),
    email: `${PREFIX}${suffix}@server-key-reseal.test`,
    username: `${PREFIX}${suffix}`,
    ...BLOB,
  };
}

async function createUser(): Promise<string> {
  counter += 1;
  const values = registrationValues(`u${String(counter)}`);
  const outcome = await runSettlement(db, (tx) =>
    stores.users.insertRegisteredWithinTx(tx, values)
  );
  if (outcome.kind !== 'created') throw new Error('user fixture insert failed');
  createdUserIds.push(outcome.userId);
  return outcome.userId;
}

/** A user whose second factor is enrolled, so its row carries a TOTP blob. */
async function createUserWithTotp(): Promise<string> {
  const userId = await createUser();
  expect(await unwrap(stores.users.enableTotp(userId, TOTP_BLOB))).toBe('enabled');
  return userId;
}

async function rowFor(userId: string): Promise<{
  readonly totpSecretEncrypted: Uint8Array | null;
  readonly totpEnabled: boolean;
}> {
  const batch = await unwrap(stores.users.readServerMaterialBatch(null, 100_000));
  const row = batch.find((candidate) => candidate.id === userId);
  if (row === undefined) throw new Error('the re-seal batch omitted the fixture row');
  return row;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('the re-seal batch row', () => {
  it('carries the stored TOTP blob for an account with a second factor', async () => {
    const userId = await createUserWithTotp();
    const row = await rowFor(userId);
    expect(row.totpSecretEncrypted).toEqual(TOTP_BLOB);
  });

  it('carries a null TOTP blob for an account with no second factor', async () => {
    const userId = await createUser();
    const row = await rowFor(userId);
    expect(row.totpSecretEncrypted).toBeNull();
  });

  it('reports the second-factor flag as the column holds it', async () => {
    const userId = await createUserWithTotp();
    const enrolled = await rowFor(userId);
    expect(enrolled.totpEnabled).toBe(true);

    await db.update(users).set({ totpEnabled: false }).where(eq(users.id, userId));

    const cleared = await rowFor(userId);
    expect(cleared.totpEnabled).toBe(false);
  });
});

describe('resealTotpSecret', () => {
  it('re-seals when the observed blob matches', async () => {
    const userId = await createUserWithTotp();
    const outcome = await unwrap(stores.users.resealTotpSecret(userId, TOTP_BLOB, NEXT_TOTP_BLOB));
    expect(outcome).toBe('resealed');
    const row = await rowFor(userId);
    expect(row.totpSecretEncrypted).toEqual(NEXT_TOTP_BLOB);
  });

  it('treats a stale observed blob as already done and writes nothing', async () => {
    const userId = await createUserWithTotp();
    const outcome = await unwrap(
      stores.users.resealTotpSecret(userId, new Uint8Array([9, 9]), NEXT_TOTP_BLOB)
    );
    expect(outcome).toBe('already-done');
    const row = await rowFor(userId);
    expect(row.totpSecretEncrypted).toEqual(TOTP_BLOB);
  });

  it('leaves the second factor enabled through the re-seal', async () => {
    const userId = await createUserWithTotp();
    await unwrap(stores.users.resealTotpSecret(userId, TOTP_BLOB, NEXT_TOTP_BLOB));
    const found = await unwrap(stores.users.findById(userId));
    expect(found?.totpEnabled).toBe(true);
  });
});

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..'
);

/**
 * The live keys are the environment's own, because the template's seeded
 * accounts are sealed under them and the job walks every row: a literal here
 * would leave those rows unopenable and abort the run.
 */
const CURRENT_KEK = requiredEnv('OPAQUE_KEK');
const CURRENT_TOTP = requiredEnv('TOTP_ENCRYPTION_SECRET');
const NEXT_KEK = 'reseal-next-kek-thirty-two-chars-minimum';
const NEXT_TOTP = 'reseal-next-totp-thirty-two-chars-minimum';
/** A key neither half of a run holds: a blob under it opens under nothing. */
const RETIRED_TOTP = 'reseal-retired-totp-thirty-two-chars-min';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';

const currentKek = deriveOpaqueKek(textEncoder.encode(CURRENT_KEK));
const nextKek = deriveOpaqueKek(textEncoder.encode(NEXT_KEK));
const nextTotpKey = deriveTotpEncryptionKey(textEncoder.encode(NEXT_TOTP));
const retiredTotpKey = deriveTotpEncryptionKey(textEncoder.encode(RETIRED_TOTP));

const maintenanceUrl = withDatabaseName(DATABASE_URL, 'postgres');

function privateDatabaseName(): string {
  return `hb_reseal_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function databaseUrlFor(name: string): string {
  return withDatabaseName(DATABASE_URL, name);
}

/** A clone of the harness template, so the job's whole-table walk stays private to one block. */
async function createPrivateDatabase(name: string): Promise<void> {
  const maintenance = createDb(maintenanceUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  try {
    await maintenance.execute(sql.raw(createDatabaseSql(name, TEMPLATE_DATABASE)));
  } finally {
    await maintenance.$client.end();
  }
}

async function dropPrivateDatabase(name: string): Promise<void> {
  const maintenance = createDb(maintenanceUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  try {
    await maintenance.execute(sql.raw(dropDatabaseSql(name)));
  } finally {
    await maintenance.$client.end();
  }
}

/** The job as the runner runs it: the real file, its secrets through the env block. */
async function runResealScript(databaseUrl: string): Promise<{ stdout: string }> {
  return promisify(execFile)('pnpm', ['exec', 'tsx', 'ops/identity/reseal-server-keys.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
      OPAQUE_KEK: CURRENT_KEK,
      OPAQUE_KEK_NEXT: NEXT_KEK,
      TOTP_ENCRYPTION_SECRET: CURRENT_TOTP,
      TOTP_ENCRYPTION_SECRET_NEXT: NEXT_TOTP,
    },
  });
}

/** The blob a second factor is left holding once its key is gone for good. */
function retiredTotpBlob(userId: string): Uint8Array {
  return encryptTotpSecret(retiredTotpKey, userId, TOTP_SECRET);
}

/**
 * The end-to-end claim the re-seal job makes: an account registered under one
 * key logs in after the job has moved every row to the next one. The job walks
 * the whole `users` table, so it runs against a database of this test's own —
 * cloned from the harness template (whose seeded rows come with it, and are
 * re-sealed alongside the fixtures) and dropped afterwards.
 */
describe('the re-seal job, run as the ops script does', () => {
  const privateName = privateDatabaseName();
  const privateUrl = databaseUrlFor(privateName);

  let privateDb: Database;
  let loginUser: { readonly id: string; readonly email: string };
  let totpUser: { readonly id: string; readonly email: string };
  let strandedUser: { readonly id: string; readonly email: string };
  let strandedBlob: Uint8Array;
  let firstRun: { readonly stdout: string };

  /** An account whose record is bound to material sealed under the live key. */
  async function registerUnderCurrentKek(options: {
    readonly withTotp: boolean;
  }): Promise<{ readonly id: string; readonly email: string }> {
    const id = crypto.randomUUID();
    const material = await mintServerMaterial();
    const server = createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, PASSWORD);
    const response = await server.registerInit(
      OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized),
      id
    );
    if (response instanceof Error) throw response;
    const { record } = await finishRegistration(
      client,
      response.serialize(),
      OPAQUE_SERVER_IDENTIFIER
    );
    const values: RegistrationValues = {
      id,
      email: `${id}@server-key-reseal.test`,
      username: `u${id.replaceAll('-', '').slice(0, 12)}`,
      opaqueRegistration: new Uint8Array(record),
      opaqueServerMaterial: sealServerMaterial(currentKek, id, material),
      opaqueKekFingerprint: opaqueKekFingerprint(currentKek),
      publicKey: new Uint8Array(32),
      passwordWrappedPrivateKey: new Uint8Array(48),
      recoveryWrappedPrivateKey: new Uint8Array(48),
      recoveryPublicKey: new Uint8Array(32),
    };
    const privateStores = createIdentityStores(privateDb);
    const outcome = await runSettlement(privateDb, (tx) =>
      privateStores.users.insertRegisteredWithinTx(tx, values)
    );
    if (outcome.kind !== 'created') throw new Error('the fixture account was not created');
    await setEmailVerified(privateDb, { email: values.email, verified: true });
    if (options.withTotp) {
      await unwrap(
        privateStores.users.enableTotp(
          id,
          encryptTotpSecret(
            deriveTotpEncryptionKey(textEncoder.encode(CURRENT_TOTP)),
            id,
            TOTP_SECRET
          )
        )
      );
    }
    return { id, email: values.email };
  }

  /**
   * The state the admin clear-stranded operation leaves: the flag off, the
   * ciphertext retained under a key the platform no longer holds, so its
   * inverse has something to restore.
   */
  async function clearSecondFactorStranded(userId: string): Promise<Uint8Array> {
    const blob = retiredTotpBlob(userId);
    await privateDb
      .update(users)
      .set({ totpSecretEncrypted: blob, totpEnabled: false })
      .where(eq(users.id, userId));
    return blob;
  }

  beforeAll(async () => {
    await createPrivateDatabase(privateName);
    privateDb = createDb(privateUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
    loginUser = await registerUnderCurrentKek({ withTotp: false });
    totpUser = await registerUnderCurrentKek({ withTotp: true });
    strandedUser = await registerUnderCurrentKek({ withTotp: true });
    strandedBlob = await clearSecondFactorStranded(strandedUser.id);
    // Every test below reads the table the one run left behind, so the run is
    // the block's setup rather than the first test's body.
    firstRun = await runResealScript(privateUrl);
  }, 120_000);

  afterAll(async () => {
    await privateDb.$client.end();
    await dropPrivateDatabase(privateName);
  }, 60_000);

  it('moves the account to the next key and logs it in against the next key', async () => {
    expect(firstRun.stdout).toContain('Remaining: 0');

    const stores = createIdentityStores(privateDb);
    const found = await unwrap(stores.users.findById(loginUser.id));
    if (found === null) throw new Error('the account vanished');
    expect(found.opaqueKekFingerprint).toEqual(opaqueKekFingerprint(nextKek));
    expect(() =>
      openServerMaterial(nextKek, loginUser.id, found.opaqueServerMaterial)
    ).not.toThrow();

    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, PASSWORD);
    const started = await unwrap(
      startLogin({
        store: stores.users,
        redis,
        secrets: {
          opaqueKek: nextKek,
          enumerationDecoySecret: textEncoder.encode('reseal-decoy-thirty-two-chars-minimum!!'),
        },
        identifier: loginUser.email,
        ke1,
        callerNetworkId: 'b'.repeat(64),
        accountLockedEmail,
      })
    );
    if (started.kind !== 'started') throw new Error(`expected started, got ${started.kind}`);
    const { ke3 } = await opaqueClientFinishLogin(client, started.ke2, OPAQUE_SERVER_IDENTIFIER);
    const flow = createLoginFinishFlow({
      store: stores.users,
      redis,
      identifier: loginUser.email,
      ke3,
      loginSessionId: started.loginSessionId,
      callerNetworkId: 'b'.repeat(64),
      request: new Request('http://localhost/auth/login/finish'),
      response: new Response(),
      secret: 'secret-at-least-32-characters-long!!',
      isProduction: false,
      now: Date.now(),
    });
    expect(await unwrap(flow.claim())).toBe(true);
    const outcome = await unwrap(flow.execute());
    expect(outcome.kind).toBe('logged-in');
  }, 120_000);

  it('leaves a cleared, unreadable second factor alone and still exits clean', async () => {
    // The run resolved at all, so the script exited zero with the stranded row
    // in the table: one use of the admin fallback does not block the rotation.
    expect(firstRun.stdout).toContain('1 cleared and unreadable');
    expect(firstRun.stdout).toContain('Remaining: 0');

    const stores = createIdentityStores(privateDb);
    const found = await unwrap(stores.users.findById(strandedUser.id));
    expect(found?.totpSecretEncrypted).toEqual(strandedBlob);
    expect(found?.totpEnabled).toBe(false);
  }, 120_000);

  it('re-keys the stored TOTP secret alongside, and a rerun finds nothing to do', async () => {
    const stores = createIdentityStores(privateDb);
    const found = await unwrap(stores.users.findById(totpUser.id));
    if (found?.totpSecretEncrypted == null) throw new Error('the TOTP blob vanished');
    expect(decryptTotpSecret(nextTotpKey, totpUser.id, found.totpSecretEncrypted)).toBe(
      TOTP_SECRET
    );

    const { stdout } = await runResealScript(privateUrl);

    expect(stdout).toContain('Remaining: 0');
    expect(stdout).toContain('Server material: 0 re-sealed');
    expect(stdout).toContain('TOTP secrets: 0 re-sealed');
  }, 120_000);
});

/**
 * The exit code the runbook's "re-run until it reports zero remaining" turns on,
 * proven through the real script rather than through the count that feeds it. A
 * row whose compare-and-swap matches nothing is still on the old key when the
 * read-back runs, and the run must leave with a non-zero status. Here that row
 * is made by a trigger that swallows its updates, which is the state a lost race
 * leaves behind without needing a race to be timed.
 */
describe('the re-seal job, against a row its write cannot land on', () => {
  const privateName = privateDatabaseName();
  const privateUrl = databaseUrlFor(privateName);

  let privateDb: Database;

  beforeAll(async () => {
    await createPrivateDatabase(privateName);
    privateDb = createDb(privateUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const [seeded] = await privateDb.select({ id: users.id }).from(users).limit(1);
    if (seeded === undefined) throw new Error('the template carries no user to freeze');
    // A BEFORE UPDATE trigger returning NULL skips the row, so the update
    // affects nothing and its RETURNING comes back empty — exactly what the
    // store reads as `already-done`. A conditional rewrite rule cannot stand in:
    // Postgres refuses one under a statement carrying RETURNING.
    await privateDb.execute(
      sql.raw(
        'CREATE FUNCTION reseal_freeze_row() RETURNS trigger LANGUAGE plpgsql AS ' +
          '$$ BEGIN RETURN NULL; END; $$'
      )
    );
    await privateDb.execute(
      sql.raw(
        'CREATE TRIGGER reseal_freeze_row BEFORE UPDATE ON users FOR EACH ROW ' +
          `WHEN (OLD.id = '${seeded.id}') EXECUTE FUNCTION reseal_freeze_row()`
      )
    );
  }, 120_000);

  afterAll(async () => {
    await privateDb.$client.end();
    await dropPrivateDatabase(privateName);
  }, 60_000);

  it('exits non-zero, naming the one row still on another key', async () => {
    const failure = await runResealScript(privateUrl).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const outcome = failure as { readonly stdout?: string; readonly stderr?: string };
    expect(outcome.stdout ?? '').toContain('Remaining: 1');
    expect(outcome.stderr ?? '').toContain('run this script again');
  }, 120_000);
});

/**
 * The other half of the unreadable-blob split, proven through the real store
 * rather than an in-memory one: the abort turns on `totp_enabled`, and only the
 * column read makes that flag real. Its own database, because the run it asserts
 * on is a failing one.
 */
describe('the re-seal job, against a second factor nobody can open', () => {
  const privateName = privateDatabaseName();
  const privateUrl = databaseUrlFor(privateName);

  let privateDb: Database;
  let strandedId: string;

  beforeAll(async () => {
    await createPrivateDatabase(privateName);
    privateDb = createDb(privateUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const [seeded] = await privateDb.select({ id: users.id }).from(users).limit(1);
    if (seeded === undefined) throw new Error('the template carries no user to strand');
    strandedId = seeded.id;
    await privateDb
      .update(users)
      .set({ totpSecretEncrypted: retiredTotpBlob(strandedId), totpEnabled: true })
      .where(eq(users.id, strandedId));
  }, 120_000);

  afterAll(async () => {
    await privateDb.$client.end();
    await dropPrivateDatabase(privateName);
  }, 60_000);

  it('aborts on an enabled blob it cannot open, naming the secret and no user', async () => {
    const failure = await runResealScript(privateUrl).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const stderr = (failure as { readonly stderr?: string }).stderr ?? '';
    expect(stderr).toContain('TOTP_ENCRYPTION_SECRET');
    expect(stderr).not.toContain(strandedId);
  }, 120_000);
});
