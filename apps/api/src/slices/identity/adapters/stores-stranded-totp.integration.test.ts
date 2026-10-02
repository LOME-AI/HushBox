import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  generateTotpSecret,
  totpKeyFingerprint,
} from '@hushbox/crypto';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createIdentityStores } from './stores.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for identity store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createIdentityStores(db);

/**
 * Unique per module load: a worker slot's database outlives the file that runs
 * on it, and the bulk doors act on every row in the database, so both the rows
 * and the fixture keys below carry it.
 */
const PREFIX = `zt${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const encoder = new TextEncoder();

type TotpEncryptionKey = ReturnType<typeof deriveTotpEncryptionKey>;

/**
 * A distinct TOTP encryption key per label. The doors compare only the 8-byte
 * fingerprint a sealed blob carries, so the key material need only be
 * distinct — a low-entropy fixture, deliberately.
 */
function fixtureKey(label: string): TotpEncryptionKey {
  return deriveTotpEncryptionKey(encoder.encode(`${PREFIX}-stranded-totp-fixture-${label}`));
}

interface TotpSeed {
  readonly enabled: boolean;
  /** The key the row's secret is sealed under; null leaves the ciphertext null. */
  readonly sealedUnder: TotpEncryptionKey | null;
}

async function seedUser(seed: TotpSeed): Promise<string> {
  counter += 1;
  const id = crypto.randomUUID();
  const username = `${PREFIX}u${String(counter)}`;
  await db.insert(users).values(
    userFactory.build({
      id,
      email: `${username}@stranded-totp.test`,
      username,
      totpEnabled: seed.enabled,
      totpSecretEncrypted:
        seed.sealedUnder === null
          ? null
          : encryptTotpSecret(seed.sealedUnder, id, generateTotpSecret()),
    })
  );
  createdUserIds.push(id);
  return id;
}

async function readTotp(
  userId: string
): Promise<{ enabled: boolean; secret: Uint8Array | null } | undefined> {
  const rows = await db
    .select({ enabled: users.totpEnabled, secret: users.totpSecretEncrypted })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0];
}

async function readTotpAll(
  userIds: readonly string[]
): Promise<({ enabled: boolean; secret: Uint8Array | null } | undefined)[]> {
  return Promise.all(userIds.map((userId) => readTotp(userId)));
}

async function isTotpEnabled(userId: string): Promise<boolean | undefined> {
  const row = await readTotp(userId);
  return row?.enabled;
}

async function withinTx<T>(body: (tx: SettlementTx) => Promise<T>): Promise<T> {
  return runSettlement(db, body);
}

/** The group for one fixture key out of a bulk-disable result, or undefined when untouched. */
function groupFor(
  groups: readonly { fingerprint: Uint8Array; count: number }[],
  key: TotpEncryptionKey
): { fingerprint: Uint8Array; count: number } | undefined {
  const wanted = Buffer.from(totpKeyFingerprint(key)).toString('hex');
  return groups.find((group) => Buffer.from(group.fingerprint).toString('hex') === wanted);
}

/**
 * Ids of enabled-TOTP rows this file did not create. The bulk doors are
 * unscoped by design, so they disable every stale-fingerprint row in the
 * database — including one an earlier file (or the seed) left in the worker
 * slot, which the next file in that slot then reads in the wrong state.
 * Snapshotted before the first door runs, restored after the last.
 */
const foreignEnabledTotpIds: string[] = [];

beforeAll(async () => {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.totpEnabled, true));
  foreignEnabledTotpIds.push(...rows.map((row) => row.id));
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (foreignEnabledTotpIds.length > 0) {
    await db
      .update(users)
      .set({ totpEnabled: true })
      .where(inArray(users.id, foreignEnabledTotpIds));
  }
  await db.$client.end();
});

describe('identity stores: disableStrandedTotpWithinTx', () => {
  it('disables exactly the enabled rows sealed under a stale fingerprint, retaining their ciphertext', async () => {
    const current = fixtureKey('disable-current');
    const stale = fixtureKey('disable-stale');
    const stranded = [
      await seedUser({ enabled: true, sealedUnder: stale }),
      await seedUser({ enabled: true, sealedUnder: stale }),
    ];
    const before = await readTotpAll(stranded);

    await withinTx((tx) =>
      stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current))
    );

    const after = await readTotpAll(stranded);
    expect(after.map((row) => row?.enabled)).toEqual([false, false]);
    expect(after.map((row) => row?.secret)).toEqual(before.map((row) => row?.secret));
  });

  it('groups the disabled rows by fingerprint', async () => {
    const current = fixtureKey('group-current');
    const staleA = fixtureKey('group-stale-a');
    const staleB = fixtureKey('group-stale-b');
    await seedUser({ enabled: true, sealedUnder: staleA });
    await seedUser({ enabled: true, sealedUnder: staleA });
    await seedUser({ enabled: true, sealedUnder: staleB });

    const groups = await withinTx((tx) =>
      stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current))
    );

    expect(groupFor(groups, staleA)).toEqual({ fingerprint: totpKeyFingerprint(staleA), count: 2 });
    expect(groupFor(groups, staleB)).toEqual({ fingerprint: totpKeyFingerprint(staleB), count: 1 });
  });

  it('leaves a row sealed under the current fingerprint enabled and out of the groups', async () => {
    const current = fixtureKey('current-untouched');
    const userId = await seedUser({ enabled: true, sealedUnder: current });

    const groups = await withinTx((tx) =>
      stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current))
    );

    expect(await isTotpEnabled(userId)).toBe(true);
    expect(groupFor(groups, current)).toBeUndefined();
  });

  it('leaves a user-disabled row (null ciphertext) alone', async () => {
    const current = fixtureKey('null-secret-current');
    const userId = await seedUser({ enabled: false, sealedUnder: null });

    await withinTx((tx) =>
      stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current))
    );

    expect(await readTotp(userId)).toEqual({ enabled: false, secret: null });
  });

  it('reaches only the named key ids when the sweep is scoped', async () => {
    const current = fixtureKey('scoped-current');
    const named = fixtureKey('scoped-named');
    const unnamed = fixtureKey('scoped-unnamed');
    const namedIds = [
      await seedUser({ enabled: true, sealedUnder: named }),
      await seedUser({ enabled: true, sealedUnder: named }),
    ];
    const unnamedId = await seedUser({ enabled: true, sealedUnder: unnamed });

    const groups = await withinTx((tx) =>
      stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current), [
        totpKeyFingerprint(named),
      ])
    );

    const afterNamed = await readTotpAll(namedIds);
    expect(afterNamed.map((row) => row?.enabled)).toEqual([false, false]);
    expect(await isTotpEnabled(unnamedId)).toBe(true);
    expect(groupFor(groups, named)).toEqual({ fingerprint: totpKeyFingerprint(named), count: 2 });
    expect(groupFor(groups, unnamed)).toBeUndefined();
  });

  it('leaves the current key alone even when a scope names it', async () => {
    // Naming the live key cannot widen the sweep onto it: staleness is the
    // door's own predicate and the scope only narrows.
    const current = fixtureKey('scoped-names-current');
    const userId = await seedUser({ enabled: true, sealedUnder: current });

    const groups = await withinTx((tx) =>
      stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current), [
        totpKeyFingerprint(current),
      ])
    );

    expect(await isTotpEnabled(userId)).toBe(true);
    expect(groups).toEqual([]);
  });

  it("writes nothing when the caller's transaction rolls back", async () => {
    const current = fixtureKey('rollback-current');
    const stale = fixtureKey('rollback-stale');
    const userId = await seedUser({ enabled: true, sealedUnder: stale });

    await expect(
      withinTx(async (tx) => {
        await stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current));
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');

    expect(await isTotpEnabled(userId)).toBe(true);
  });
});

describe('identity stores: restoreStrandedTotpWithinTx', () => {
  it('re-enables exactly the cleared rows under the fingerprint when the count matches', async () => {
    const key = fixtureKey('restore-match');
    const cleared = [
      await seedUser({ enabled: false, sealedUnder: key }),
      await seedUser({ enabled: false, sealedUnder: key }),
    ];
    const nulled = await seedUser({ enabled: false, sealedUnder: null });

    const outcome = await withinTx((tx) =>
      stores.users.restoreStrandedTotpWithinTx(tx, totpKeyFingerprint(key), 2)
    );

    expect(outcome).toBe('restored');
    const after = await readTotpAll(cleared);
    expect(after.map((row) => row?.enabled)).toEqual([true, true]);
    expect(await isTotpEnabled(nulled)).toBe(false);
  });

  it('answers count-mismatch and changes nothing when the count is wrong', async () => {
    const key = fixtureKey('restore-mismatch');
    const cleared = [
      await seedUser({ enabled: false, sealedUnder: key }),
      await seedUser({ enabled: false, sealedUnder: key }),
    ];

    const outcome = await withinTx((tx) =>
      stores.users.restoreStrandedTotpWithinTx(tx, totpKeyFingerprint(key), 1)
    );

    expect(outcome).toBe('count-mismatch');
    const after = await readTotpAll(cleared);
    expect(after.map((row) => row?.enabled)).toEqual([false, false]);
  });

  it('round-trips a bulk disable through its own groups', async () => {
    const current = fixtureKey('roundtrip-current');
    const stale = fixtureKey('roundtrip-stale');
    const stranded = [
      await seedUser({ enabled: true, sealedUnder: stale }),
      await seedUser({ enabled: true, sealedUnder: stale }),
      await seedUser({ enabled: true, sealedUnder: stale }),
    ];
    const groups = await withinTx((tx) =>
      stores.users.disableStrandedTotpWithinTx(tx, totpKeyFingerprint(current))
    );
    const group = groupFor(groups, stale);
    if (group === undefined) throw new Error('bulk disable reported no group for the stale key');

    const outcome = await withinTx((tx) =>
      stores.users.restoreStrandedTotpWithinTx(tx, group.fingerprint, group.count)
    );

    expect(outcome).toBe('restored');
    const after = await readTotpAll(stranded);
    expect(after.map((row) => row?.enabled)).toEqual([true, true, true]);
  });
});

describe('identity stores: clearTotpWithinTx', () => {
  it('clears an enabled row, retaining its ciphertext and returning its key id', async () => {
    const key = fixtureKey('clear-enabled');
    const userId = await seedUser({ enabled: true, sealedUnder: key });
    const before = await readTotp(userId);

    const outcome = await withinTx((tx) => stores.users.clearTotpWithinTx(tx, userId));

    expect(outcome).toEqual({ kind: 'cleared', fingerprint: totpKeyFingerprint(key) });
    expect(await readTotp(userId)).toEqual({ enabled: false, secret: before?.secret });
  });

  it('answers not-enabled for a row without TOTP and changes nothing', async () => {
    const userId = await seedUser({ enabled: false, sealedUnder: null });

    const outcome = await withinTx((tx) => stores.users.clearTotpWithinTx(tx, userId));

    expect(outcome).toEqual({ kind: 'not-enabled' });
    expect(await readTotp(userId)).toEqual({ enabled: false, secret: null });
  });

  it('answers not-found for an unknown user id', async () => {
    const outcome = await withinTx((tx) => stores.users.clearTotpWithinTx(tx, crypto.randomUUID()));

    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it("writes nothing when the caller's transaction rolls back", async () => {
    const key = fixtureKey('clear-rollback');
    const userId = await seedUser({ enabled: true, sealedUnder: key });

    await expect(
      withinTx(async (tx) => {
        await stores.users.clearTotpWithinTx(tx, userId);
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');

    expect(await isTotpEnabled(userId)).toBe(true);
  });
});

describe('identity stores: restoreTotpWithinTx', () => {
  it('re-enables a cleared row', async () => {
    const key = fixtureKey('restore-cleared');
    const userId = await seedUser({ enabled: false, sealedUnder: key });

    const outcome = await withinTx((tx) => stores.users.restoreTotpWithinTx(tx, userId));

    expect(outcome).toBe('restored');
    expect(await isTotpEnabled(userId)).toBe(true);
  });

  it('answers not-cleared for a row whose TOTP is enabled', async () => {
    const key = fixtureKey('restore-enabled');
    const userId = await seedUser({ enabled: true, sealedUnder: key });

    const outcome = await withinTx((tx) => stores.users.restoreTotpWithinTx(tx, userId));

    expect(outcome).toBe('not-cleared');
  });

  it('answers not-cleared for a user-disabled row (null ciphertext) and changes nothing', async () => {
    const userId = await seedUser({ enabled: false, sealedUnder: null });

    const outcome = await withinTx((tx) => stores.users.restoreTotpWithinTx(tx, userId));

    expect(outcome).toBe('not-cleared');
    expect(await readTotp(userId)).toEqual({ enabled: false, secret: null });
  });

  it('answers not-found for an unknown user id', async () => {
    const outcome = await withinTx((tx) =>
      stores.users.restoreTotpWithinTx(tx, crypto.randomUUID())
    );

    expect(outcome).toBe('not-found');
  });
});

/**
 * The cleared state (`totp_enabled = false` with a retained ciphertext) is the
 * referee the bulk inverse counts on, so the user-facing transitions must
 * never produce it: enable writes flag and ciphertext together, disable nulls
 * the ciphertext with the flag.
 */
describe('identity stores: the cleared state is reachable only through the doors', () => {
  it('enableTotp sets the flag and the ciphertext together', async () => {
    const key = fixtureKey('enable-together');
    const userId = await seedUser({ enabled: false, sealedUnder: null });
    const sealed = encryptTotpSecret(key, userId, generateTotpSecret());

    const outcome = await stores.users.enableTotp(userId, sealed);

    expect(outcome._unsafeUnwrap()).toBe('enabled');
    expect(await readTotp(userId)).toEqual({ enabled: true, secret: sealed });
  });

  it('disableTotp nulls the ciphertext with the flag', async () => {
    const key = fixtureKey('disable-nulls');
    const userId = await seedUser({ enabled: true, sealedUnder: key });

    const outcome = await stores.users.disableTotp(userId);

    expect(outcome._unsafeUnwrap()).toBe('disabled');
    expect(await readTotp(userId)).toEqual({ enabled: false, secret: null });
  });
});
