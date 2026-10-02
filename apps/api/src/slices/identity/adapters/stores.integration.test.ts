import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, accountDeletionEvents, createDb, users } from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createIdentityStores } from './stores.js';
import type {
  InsertRegisteredOutcome,
  RegistrationValues,
  RotatePasswordArgs,
} from '../ports/index.js';
import type { Result } from '../../../lib/result/index.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for identity store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createIdentityStores(db);

/**
 * Unique per module load: a worker slot's database outlives the file that runs
 * on it, so the next file to land on that slot sees whatever rows this one
 * leaves behind.
 */
const PREFIX = `zi${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

/**
 * Distinct per field on purpose: `insertRegisteredWithinTx` writes every blob
 * column below from one object, so blobs sharing bytes would let a transposed
 * assignment round-trip cleanly through the store and past every assertion.
 */
const BYTES = {
  opaqueRegistration: new Uint8Array([1, 2, 3]),
  opaqueServerMaterial: new Uint8Array([16, 17, 18]),
  opaqueKekFingerprint: new Uint8Array([19, 20, 21]),
  publicKey: new Uint8Array([4, 5, 6]),
  passwordWrappedPrivateKey: new Uint8Array([7, 8, 9]),
  recoveryWrappedPrivateKey: new Uint8Array([10, 11, 12]),
  recoveryPublicKey: new Uint8Array([13, 14, 15]),
};

function registrationValues(suffix: string): RegistrationValues {
  return {
    id: crypto.randomUUID(),
    email: `${PREFIX}${suffix}@identity-stores.test`,
    username: `${PREFIX}${suffix}`,
    ...BYTES,
  };
}

/** The rotated credential set: every blob distinct from the registered one. */
const ROTATED = {
  opaqueRegistration: new Uint8Array([31, 32, 33]),
  passwordWrappedPrivateKey: new Uint8Array([34, 35, 36]),
  opaqueServerMaterial: new Uint8Array([37, 38, 39]),
  opaqueKekFingerprint: new Uint8Array([40, 41, 42]),
};

function rotation(userId: string, observedRegistration: Uint8Array): RotatePasswordArgs {
  return { userId, observedRegistration, ...ROTATED };
}

async function insertWithinTx(
  values: ReturnType<typeof registrationValues>
): Promise<InsertRegisteredOutcome> {
  return runSettlement(db, (tx) => stores.users.insertRegisteredWithinTx(tx, values));
}

async function createUser(): Promise<{ id: string; email: string; username: string }> {
  counter += 1;
  const values = registrationValues(`u${String(counter)}`);
  const outcome = await insertWithinTx(values);
  if (outcome.kind !== 'created') throw new Error('user seed failed');
  createdUserIds.push(outcome.userId);
  return { id: outcome.userId, email: values.email, username: values.username };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  // Deletion-event rows are anonymous by design; the run-unique userAgent
  // marker is the only handle this suite has on its own rows.
  await db.delete(accountDeletionEvents).where(like(accountDeletionEvents.userAgent, `${PREFIX}%`));
  await db.$client.end();
});

describe('identity stores: insertRegisteredWithinTx', () => {
  it('creates the user row with the caller-chosen id and unverified email', async () => {
    const values = registrationValues('ins');
    expect(await insertWithinTx(values)).toEqual({ kind: 'created', userId: values.id });
    createdUserIds.push(values.id);
    const lookedUp = await stores.users.findById(values.id);
    const found = lookedUp._unsafeUnwrap();
    expect(found?.username).toBe(values.username);
    expect(found?.totpEnabled).toBe(false);
    expect(found?.lockedAt).toBeNull();
  });

  it('reports a duplicate email as email-taken', async () => {
    const existing = await createUser();
    const values = { ...registrationValues('dupe'), email: existing.email };
    expect(await insertWithinTx(values)).toEqual({ kind: 'email-taken' });
  });

  it('reports a duplicate username as username-taken', async () => {
    const existing = await createUser();
    const values = { ...registrationValues('dupu'), username: existing.username };
    expect(await insertWithinTx(values)).toEqual({ kind: 'username-taken' });
  });
});

describe('identity stores: rotatePassword', () => {
  it('rotates all four credential columns when the observed record matches', async () => {
    const user = await createUser();
    const outcome = await stores.users.rotatePassword(rotation(user.id, BYTES.opaqueRegistration));
    expect(outcome._unsafeUnwrap()).toBe('rotated');
    const found = await unwrap(stores.users.findById(user.id));
    expect(found?.opaqueRegistration).toEqual(ROTATED.opaqueRegistration);
    expect(found?.passwordWrappedPrivateKey).toEqual(ROTATED.passwordWrappedPrivateKey);
    expect(found?.opaqueServerMaterial).toEqual(ROTATED.opaqueServerMaterial);
    expect(found?.opaqueKekFingerprint).toEqual(ROTATED.opaqueKekFingerprint);
  });

  it('answers conflict and writes nothing when the observed record is stale', async () => {
    const user = await createUser();
    const outcome = await stores.users.rotatePassword(rotation(user.id, new Uint8Array([9, 9])));
    expect(outcome._unsafeUnwrap()).toBe('conflict');
    const found = await unwrap(stores.users.findById(user.id));
    expect(found?.opaqueRegistration).toEqual(BYTES.opaqueRegistration);
    expect(found?.opaqueServerMaterial).toEqual(BYTES.opaqueServerMaterial);
  });

  it('lets exactly one of two concurrent rotations on the same observed record win', async () => {
    const user = await createUser();
    const other = {
      ...rotation(user.id, BYTES.opaqueRegistration),
      opaqueRegistration: new Uint8Array([51, 52, 53]),
    };
    const [first, second] = await Promise.all([
      stores.users.rotatePassword(rotation(user.id, BYTES.opaqueRegistration)),
      stores.users.rotatePassword(other),
    ]);
    const outcomes = [first._unsafeUnwrap(), second._unsafeUnwrap()].toSorted((a, b) =>
      a.localeCompare(b)
    );
    expect(outcomes).toEqual(['conflict', 'rotated']);
  });
});

describe('identity stores: server material re-seal', () => {
  it('pages the material rows by id after a cursor', async () => {
    const created = [await createUser(), await createUser(), await createUser()];
    const ids = created.map((user) => user.id).toSorted((a, b) => a.localeCompare(b));
    const first = await unwrap(stores.users.readServerMaterialBatch(null, 1));
    expect(first.length).toBe(1);
    const afterFirst = await unwrap(stores.users.readServerMaterialBatch(ids[0] ?? null, 1000));
    const returned = afterFirst.map((row) => row.id);
    expect(returned).not.toContain(ids[0]);
    expect(returned).toEqual(expect.arrayContaining([ids[1], ids[2]]));
    const row = afterFirst.find((candidate) => candidate.id === ids[1]);
    expect(row?.opaqueServerMaterial).toEqual(BYTES.opaqueServerMaterial);
    expect(row?.opaqueKekFingerprint).toEqual(BYTES.opaqueKekFingerprint);
  });

  it('re-seals when the observed blob matches', async () => {
    const user = await createUser();
    const outcome = await stores.users.resealServerMaterial(
      user.id,
      BYTES.opaqueServerMaterial,
      ROTATED.opaqueServerMaterial,
      ROTATED.opaqueKekFingerprint
    );
    expect(outcome._unsafeUnwrap()).toBe('resealed');
    const found = await unwrap(stores.users.findById(user.id));
    expect(found?.opaqueServerMaterial).toEqual(ROTATED.opaqueServerMaterial);
    expect(found?.opaqueKekFingerprint).toEqual(ROTATED.opaqueKekFingerprint);
  });

  it('treats a stale observed blob as already done and writes nothing', async () => {
    const user = await createUser();
    const outcome = await stores.users.resealServerMaterial(
      user.id,
      new Uint8Array([9, 9]),
      ROTATED.opaqueServerMaterial,
      ROTATED.opaqueKekFingerprint
    );
    expect(outcome._unsafeUnwrap()).toBe('already-done');
    const found = await unwrap(stores.users.findById(user.id));
    expect(found?.opaqueServerMaterial).toEqual(BYTES.opaqueServerMaterial);
  });
});

describe('identity stores: lockForChargebackWithinTx', () => {
  it('locks a fresh account, returns locked + its email, and stamps locked_at + chargeback reason', async () => {
    const user = await createUser();
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, user.id)
    );
    expect(locked).toEqual({ locked: true, email: user.email, userName: user.username });
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockedAt).not.toBeNull();
    expect(row[0]?.lockReason).toBe('chargeback');
  });

  it('is a no-op on an already-locked account (no second transition)', async () => {
    const user = await createUser();
    const first = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, user.id)
    );
    expect(first).toEqual({ locked: true, email: user.email, userName: user.username });
    const firstRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, user.id));
    const firstAt = firstRows[0]?.lockedAt;

    const second = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, user.id)
    );
    // The conditional UPDATE matched zero rows the second time: not locked, and
    // no email (the notification rides only the fresh transition).
    expect(second).toEqual({ locked: false, email: null, userName: null });
    const secondRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, user.id));
    const secondAt = secondRows[0]?.lockedAt;
    // The original lock timestamp is untouched — the row was not re-written.
    expect(secondAt?.getTime()).toBe(firstAt?.getTime());
  });

  it('returns not-locked with a null email for an unknown user id', async () => {
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, '00000000-0000-7000-8000-000000000000')
    );
    expect(locked).toEqual({ locked: false, email: null, userName: null });
  });
});

describe('identity stores: lockUserWithinTx', () => {
  it('locks a fresh account with the admin reason, stamping both paired columns', async () => {
    const user = await createUser();
    const outcome = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'admin')
    );
    expect(outcome).toEqual({ kind: 'locked' });
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockedAt).not.toBeNull();
    expect(row[0]?.lockReason).toBe('admin');
  });

  it('locks a fresh account with the chargeback reason', async () => {
    const user = await createUser();
    const outcome = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'chargeback')
    );
    expect(outcome).toEqual({ kind: 'locked' });
    const row = await db
      .select({ lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockReason).toBe('chargeback');
  });

  it('is a no-op on an already-locked account, reporting the original reason and timestamp', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'chargeback'));
    const firstRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, user.id));
    const firstAt = firstRows[0]?.lockedAt;
    if (!firstAt) throw new Error('lock seed failed');

    const second = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'admin')
    );
    // The original reason and timestamp are never clobbered by a second lock.
    expect(second).toEqual({ kind: 'already-locked', lockedAt: firstAt, lockReason: 'chargeback' });
    const secondRows = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(secondRows[0]?.lockedAt?.getTime()).toBe(firstAt.getTime());
    expect(secondRows[0]?.lockReason).toBe('chargeback');
  });

  it('answers not-found for an unknown user id', async () => {
    const outcome = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, '00000000-0000-7000-8000-000000000000', 'admin')
    );
    expect(outcome).toEqual({ kind: 'not-found' });
  });
});

describe('identity stores: unlockUserWithinTx', () => {
  it('unlocks an admin-locked account and returns the prior reason', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'admin'));
    const outcome = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(outcome).toEqual({ kind: 'unlocked', priorLockReason: 'admin' });
    // Both columns clear together — the paired-null check constraint never
    // admits a half-cleared state.
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]).toEqual({ lockedAt: null, lockReason: null });
  });

  it('unlocks a chargeback-locked account and returns the prior reason', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'chargeback'));
    const outcome = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(outcome).toEqual({ kind: 'unlocked', priorLockReason: 'chargeback' });
  });

  it('is a no-op on an account that is not locked', async () => {
    const user = await createUser();
    const outcome = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(outcome).toEqual({ kind: 'not-locked' });
  });

  it('is a no-op on the second of two unlocks', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'admin'));
    const first = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(first).toEqual({ kind: 'unlocked', priorLockReason: 'admin' });
    const second = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(second).toEqual({ kind: 'not-locked' });
  });

  it('answers not-found for an unknown user id', async () => {
    const outcome = await runSettlement(db, (tx) =>
      stores.users.unlockUserWithinTx(tx, '00000000-0000-7000-8000-000000000000')
    );
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('permits a fresh lock after an unlock (full round trip)', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'chargeback'));
    await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    const relocked = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'admin')
    );
    expect(relocked).toEqual({ kind: 'locked' });
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockedAt).not.toBeNull();
    expect(row[0]?.lockReason).toBe('admin');
  });
});

describe('identity stores: lookups', () => {
  it('finds a user by lowercased email', async () => {
    const user = await createUser();
    const lookedUp = await stores.users.findByEmail(user.email);
    expect(lookedUp._unsafeUnwrap()?.id).toBe(user.id);
  });

  it('finds a user by normalized username', async () => {
    const user = await createUser();
    const lookedUp = await stores.users.findByUsername(user.username);
    expect(lookedUp._unsafeUnwrap()?.id).toBe(user.id);
  });

  it('returns null for an unknown email', async () => {
    const lookedUp = await stores.users.findByEmail(`${PREFIX}-nobody@x.test`);
    expect(lookedUp._unsafeUnwrap()).toBeNull();
  });

  it('returns null for an unknown user id', async () => {
    const lookedUp = await stores.users.findById('00000000-0000-7000-8000-000000000000');
    expect(lookedUp._unsafeUnwrap()).toBeNull();
  });

  it('round-trips the OPAQUE registration record bytes', async () => {
    const user = await createUser();
    const lookedUp = await stores.users.findById(user.id);
    const found = lookedUp._unsafeUnwrap();
    expect([...(found?.opaqueRegistration ?? [])]).toEqual([...BYTES.opaqueRegistration]);
  });

  it('lands each key blob in its own column rather than transposing them', async () => {
    const user = await createUser();
    const lookedUp = await stores.users.findById(user.id);
    const found = lookedUp._unsafeUnwrap();
    if (found === null) throw new Error('inserted user not found');
    expect([...found.publicKey]).toEqual([...BYTES.publicKey]);
    expect([...found.passwordWrappedPrivateKey]).toEqual([...BYTES.passwordWrappedPrivateKey]);
    expect([...found.recoveryWrappedPrivateKey]).toEqual([...BYTES.recoveryWrappedPrivateKey]);
  });

  // Asserts the column's contents directly rather than through the store's projection.
  it('writes the recovery public key to its own column', async () => {
    const user = await createUser();
    const [row] = await db
      .select({ recoveryPublicKey: users.recoveryPublicKey })
      .from(users)
      .where(eq(users.id, user.id));
    if (row === undefined) throw new Error('inserted user not found');
    expect([...row.recoveryPublicKey]).toEqual([...BYTES.recoveryPublicKey]);
  });

  it('answers unavailable when the database is unreachable', async () => {
    const deadDb = createDb('postgres://postgres:postgres@127.0.0.1:9/hushbox', {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    const result = await createIdentityStores(deadDb).users.findById(
      '00000000-0000-7000-8000-000000000000'
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('identity stores: account-deletion writes', () => {
  it('locks the users row and captures its email before the cascade', async () => {
    const user = await createUser();
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForDeletionWithinTx(tx, user.id)
    );
    expect(locked).toEqual({ email: user.email });
  });

  it('answers null for a user that no longer exists', async () => {
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForDeletionWithinTx(tx, '00000000-0000-7000-8000-000000000000')
    );
    expect(locked).toBeNull();
  });

  it('deletes the user and records the anonymous event in one transaction', async () => {
    const user = await createUser();
    const deletedAt = new Date();
    const userAgent = `${PREFIX}-agent`;

    await runSettlement(db, async (tx) => {
      await stores.users.insertDeletionEventWithinTx(tx, {
        deletedAt,
        ipAddress: '203.0.113.9',
        userAgent,
      });
      await stores.users.deleteUserWithinTx(tx, user.id);
    });

    const gone = await stores.users.findById(user.id);
    expect(gone._unsafeUnwrap()).toBeNull();
    const events = await db
      .select({
        deletedAt: accountDeletionEvents.deletedAt,
        ipAddress: accountDeletionEvents.ipAddress,
        userAgent: accountDeletionEvents.userAgent,
      })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, userAgent));
    expect(events).toEqual([{ deletedAt, ipAddress: '203.0.113.9', userAgent }]);
  });
});

describe('identity stores: liftStatementTimeoutWithinTx', () => {
  /** A handle whose sessions start bounded, so lifting the bound is observable. */
  const boundedDb = (): ReturnType<typeof createDb> =>
    createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, statementTimeoutMs: 1000 });

  async function statementTimeout(executor: {
    execute: ReturnType<typeof createDb>['execute'];
  }): Promise<unknown> {
    const result = await executor.execute(
      sql`select current_setting('statement_timeout') as value`
    );
    return result.rows[0]?.['value'];
  }

  it('lifts the statement bound inside the transaction it is given', async () => {
    const bounded = boundedDb();
    const inside = await runSettlement(bounded, async (tx) => {
      await createIdentityStores(bounded).users.liftStatementTimeoutWithinTx(tx);
      return statementTimeout(tx);
    });
    await bounded.$client.end();

    expect(inside).toBe('0');
  });

  it('leaves the statement bound in force once that transaction commits', async () => {
    const bounded = boundedDb();
    await runSettlement(bounded, (tx) =>
      createIdentityStores(bounded).users.liftStatementTimeoutWithinTx(tx)
    );
    const after = await statementTimeout(bounded);
    await bounded.$client.end();

    expect(after).toBe('1s');
  });
});

describe('identity stores: consumeEmailVerification', () => {
  it('verifies exactly one of N concurrent consumers of the same token', async () => {
    const user = await createUser();
    const token = crypto.randomUUID();
    const issued = await stores.verification.issueEmailVerification(
      user.id,
      token,
      new Date(Date.now() + 60_000)
    );
    issued._unsafeUnwrap();
    // One client per consumer: a shared pool would serialize the transactions
    // and hide the race the DELETE arbiter exists to win.
    const racers = Array.from({ length: 4 }, () =>
      createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG })
    );
    try {
      const results = await Promise.all(
        racers.map((racer) =>
          createIdentityStores(racer).verification.consumeEmailVerification(token, new Date())
        )
      );
      const kinds = results.map((result) => result._unsafeUnwrap().kind);
      expect(kinds.filter((kind) => kind === 'verified')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'invalid')).toHaveLength(3);
    } finally {
      await Promise.all(racers.map((racer) => racer.$client.end()));
    }
  });
});
