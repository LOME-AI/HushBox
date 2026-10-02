import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  generateTotpSecret,
  totpKeyFingerprint,
} from '@hushbox/crypto';
import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, idempotencyKeys, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ADMIN_OP_CONTRACTS, MAX_STRANDED_TOTP_GROUPS } from '@hushbox/shared';
import { createIdentityStores } from '../../../identity/index.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminTwoFactorOperations } from './index.js';
import { createJobWakeCollector, grantJobWakes } from '../../../../lib/jobs/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { IdentityUsersStore } from '../../../identity/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type { AdminOpHarnessInstance, AdminOpInterleavingAction } from '../describe-admin-op.js';
import type { AdminTwoFactorDeps } from './two-factor.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin two-factor op tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const identityStores = createIdentityStores(db);
const adminStores = createAdminStores();

const CLEAR_STRANDED_CONTRACT = ADMIN_OP_CONTRACTS['twoFactor.clearStranded'];
const RESTORE_STRANDED_CONTRACT = ADMIN_OP_CONTRACTS['twoFactor.restoreStranded'];
const CLEAR_CONTRACT = ADMIN_OP_CONTRACTS['twoFactor.clear'];
const RESTORE_CONTRACT = ADMIN_OP_CONTRACTS['twoFactor.restore'];

/**
 * Unique per module load: the bulk op acts on every row in the database, and a
 * worker slot's database outlives the file that runs on it, so both the rows
 * and the fixture keys below carry it.
 */
const PREFIX = `ta${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let fixtureCounter = 0;

const encoder = new TextEncoder();

type TotpEncryptionKey = ReturnType<typeof deriveTotpEncryptionKey>;

/**
 * A distinct TOTP encryption key per label. The doors compare only the 8-byte
 * key id a sealed blob carries, so the key material need only be distinct — a
 * low-entropy fixture, deliberately.
 */
function fixtureKey(label: string): TotpEncryptionKey {
  return deriveTotpEncryptionKey(encoder.encode(`${PREFIX}-two-factor-op-fixture-${label}`));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedUser(seed: {
  enabled: boolean;
  sealedUnder: TotpEncryptionKey | null;
}): Promise<string> {
  fixtureCounter += 1;
  const id = crypto.randomUUID();
  const username = `${PREFIX}u${String(fixtureCounter)}`;
  await db.insert(users).values(
    userFactory.build({
      id,
      email: `${username}@two-factor-ops.test`,
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

/** The three second-factor states a row can stand in, as the projection names them. */
type TotpState = 'enabled' | 'cleared' | 'off' | 'missing';

async function totpStateOf(userId: string): Promise<TotpState> {
  const rows = await db
    .select({ enabled: users.totpEnabled, secret: users.totpSecretEncrypted })
    .from(users)
    .where(eq(users.id, userId));
  const row = rows[0];
  if (row === undefined) return 'missing';
  if (row.enabled) return 'enabled';
  return row.secret === null ? 'off' : 'cleared';
}

async function secretOf(userId: string): Promise<Uint8Array | null> {
  const rows = await db
    .select({ secret: users.totpSecretEncrypted })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0]?.secret ?? null;
}

/**
 * Ids of enabled-TOTP rows this file did not create. The bulk doors are
 * unscoped by design, so a clear disables every stale-key row in the database
 * — including one an earlier file (or the seed) left in this worker slot,
 * which the next file in the slot would then read in the wrong state.
 * Snapshotted before the first op runs, restored after the last.
 */
const foreignEnabledTotpIds: string[] = [];

beforeAll(async () => {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.totpEnabled, true));
  foreignEnabledTotpIds.push(...rows.map((row) => row.id));
});

afterAll(async () => {
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/twoFactor.%'));
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

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, captureError: noop };
}

interface TwoFactorHarness extends AdminOpHarnessInstance {
  /** The rows seeded under a retired key — what a clear must reach. */
  readonly strandedIds: readonly string[];
  /** One row sealed under the live key — what a clear must never reach. */
  readonly liveKeyUserId: string;
  readonly staleKeyIdHex: string;
  /** A fresh enrollment under the live key: never stranded, so never swept. */
  enroll(): Promise<string>;
}

interface HarnessSeed {
  /** How many rows stand under the retired key. */
  readonly stranded?: number;
  /** Whether those rows start enabled (a clear's subject) or cleared (a restore's). */
  readonly state?: 'enabled' | 'cleared';
}

/** What the bulk sweep door hands the body — one group per stale key id. */
type StrandedGroups = Awaited<ReturnType<IdentityUsersStore['disableStrandedTotpWithinTx']>>;

interface HarnessOptions {
  readonly hooks?: AdminOpEngineHooks;
  /**
   * Replaces the real sweep door, so a case can hand the body a group order
   * the database would not reproduce on demand. The door is the only thing
   * stubbed: the engine, its transaction and the audit write stay real.
   */
  readonly strandedGroups?: StrandedGroups;
}

/**
 * The bulk doors are unscoped by design, so every fixture row an earlier
 * harness left behind stands on a key id that is retired from the next
 * harness's point of view — and a clear may name no more retired keys than one
 * restore can carry. Each harness therefore starts from a database holding
 * none of this file's earlier rows; a harness's own assertions are finished by
 * the time the next one is built, and the interleaving battery captures its
 * control projection before building the second harness.
 */
async function dropEarlierFixtures(): Promise<void> {
  const previous = createdUserIds.splice(0);
  if (previous.length > 0) {
    await db.delete(users).where(inArray(users.id, previous));
  }
}

async function createTwoFactorHarness(
  options: HarnessOptions = {},
  seed: HarnessSeed = {}
): Promise<TwoFactorHarness> {
  await dropEarlierFixtures();
  fixtureCounter += 1;
  const instance = String(fixtureCounter);
  // Per-harness keys: two harnesses of one file must never share a key id, or
  // one's recorded group would count the other's rows.
  const liveKey = fixtureKey(`live-${instance}`);
  const staleKey = fixtureKey(`stale-${instance}`);
  const enabled = (seed.state ?? 'enabled') === 'enabled';
  const strandedIds: string[] = [];
  for (let index = 0; index < (seed.stranded ?? 2); index += 1) {
    strandedIds.push(await seedUser({ enabled, sealedUnder: staleKey }));
  }
  const liveKeyUserId = await seedUser({ enabled: true, sealedUnder: liveKey });
  const ownedIds = [...strandedIds, liveKeyUserId];
  const actor = `admin-two-factor-test-${crypto.randomUUID()}@hushbox.ai`;

  const opDeps: AdminTwoFactorDeps = {
    // The same narrowed surface the composition root binds: only the four
    // transaction-scoped doors, so no base-database write is reachable from a
    // body running inside a preview.
    twoFactorStores: {
      users: {
        clearTotpWithinTx: identityStores.users.clearTotpWithinTx.bind(identityStores.users),
        disableStrandedTotpWithinTx:
          options.strandedGroups === undefined
            ? identityStores.users.disableStrandedTotpWithinTx.bind(identityStores.users)
            : (): Promise<StrandedGroups> => Promise.resolve(options.strandedGroups ?? []),
        restoreStrandedTotpWithinTx: identityStores.users.restoreStrandedTotpWithinTx.bind(
          identityStores.users
        ),
        restoreTotpWithinTx: identityStores.users.restoreTotpWithinTx.bind(identityStores.users),
      },
    },
    currentTotpKeyFingerprint: () => totpKeyFingerprint(liveKey),
  };

  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminTwoFactorDeps>([...adminTwoFactorOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps,
    postDeps: {},
    executorId: `admin-two-factor-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });

  return {
    engine,
    actor,
    strandedIds,
    liveKeyUserId,
    staleKeyIdHex: hex(totpKeyFingerprint(staleKey)),
    enroll: async (): Promise<string> => {
      const id = await seedUser({ enabled: true, sealedUnder: liveKey });
      ownedIds.push(id);
      return id;
    },
    // Normalized: state names only, sorted — comparable against a control
    // harness that never ran the op.
    projection: async (): Promise<readonly TotpState[]> => {
      const states = await Promise.all(ownedIds.map((id) => totpStateOf(id)));
      return states.toSorted((left, right) => left.localeCompare(right));
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
  };
}

function harnessOf(harness: AdminOpHarnessInstance): TwoFactorHarness {
  return harness as TwoFactorHarness;
}

/**
 * Seeded churn: a second-factor enrollment by an unrelated account. Feasible
 * on any fresh harness whether or not the op ran, and deliberately sealed
 * under the LIVE key — a fresh enrollment always is, and a stranded one would
 * change the very count a recorded group is refereed on. A user's own disable
 * is excluded: it is a conflicting write to the flag these ops own (the
 * Charter's feasibility rule).
 */
const enrollmentChurnActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'another-account-enrolls',
    run: async (harness) => {
      await harnessOf(harness).enroll();
    },
  },
];

describeAdminOp({
  contract: CLEAR_STRANDED_CONTRACT,
  createHarness: (options) => createTwoFactorHarness(options),
  validInput: () => ({ reason: `retired key recovery ${crypto.randomUUID()}` }),
  invalidInput: { reason: 42 },
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 3,
    opInput: () => ({ reason: `interleaving clear ${crypto.randomUUID()}` }),
    actions: enrollmentChurnActions,
  },
});

const restoreStrandedTarget = { groups: [] as { fingerprint: string; count: number }[] };
describeAdminOp({
  contract: RESTORE_STRANDED_CONTRACT,
  createHarness: async (options) => {
    const harness = await createTwoFactorHarness(options, { state: 'cleared' });
    restoreStrandedTarget.groups = [{ fingerprint: harness.staleKeyIdHex, count: 2 }];
    return harness;
  },
  validInput: () => ({
    groups: restoreStrandedTarget.groups,
    reason: `key restored from the offline copy ${crypto.randomUUID()}`,
  }),
  invalidInput: { groups: [{ fingerprint: 'nothex', count: 1 }], reason: 'x' },
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 3,
    opInput: (harness) => ({
      groups: [{ fingerprint: harnessOf(harness).staleKeyIdHex, count: 2 }],
      reason: `interleaving restore ${crypto.randomUUID()}`,
    }),
    actions: enrollmentChurnActions,
  },
});

const clearTarget = { userId: '' };
describeAdminOp({
  contract: CLEAR_CONTRACT,
  createHarness: async (options) => {
    const harness = await createTwoFactorHarness(options, { stranded: 1 });
    clearTarget.userId = harness.strandedIds[0] ?? '';
    return harness;
  },
  validInput: () => ({
    userId: clearTarget.userId,
    reason: `authenticator lost ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', reason: 'x' },
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 3,
    opInput: (harness) => ({
      userId: harnessOf(harness).strandedIds[0] ?? '',
      reason: `interleaving per-user clear ${crypto.randomUUID()}`,
    }),
    actions: enrollmentChurnActions,
  },
});

const restoreTarget = { userId: '' };
describeAdminOp({
  contract: RESTORE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createTwoFactorHarness(options, { stranded: 1, state: 'cleared' });
    restoreTarget.userId = harness.strandedIds[0] ?? '';
    return harness;
  },
  validInput: () => ({
    userId: restoreTarget.userId,
    reason: `cleared in error ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', reason: 'x' },
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 3,
    opInput: (harness) => ({
      userId: harnessOf(harness).strandedIds[0] ?? '',
      reason: `interleaving per-user restore ${crypto.randomUUID()}`,
    }),
    actions: enrollmentChurnActions,
  },
});

async function executeOk(
  harness: TwoFactorHarness,
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): Promise<{ auditId: string; inverseInput: Record<string, unknown> | null }> {
  const result = await harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: 'execute',
    role: 'operator',
    idempotencyKey: crypto.randomUUID(),
    ...(undoes === undefined ? {} : { undoes }),
  });
  return result._unsafeUnwrap();
}

async function executeRefusal(
  harness: TwoFactorHarness,
  name: string,
  input: Record<string, unknown>
): Promise<DomainError> {
  const result = await harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: 'execute',
    role: 'operator',
    idempotencyKey: crypto.randomUUID(),
  });
  return result._unsafeUnwrapErr();
}

async function executeErr(
  harness: TwoFactorHarness,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const refusal = await executeRefusal(harness, name, input);
  return refusal.code;
}

function recordedGroups(
  inverseInput: Record<string, unknown> | null
): readonly { fingerprint: string; count: number }[] {
  if (inverseInput === null) throw new Error('two-factor ops: expected a recorded inverse input');
  return inverseInput['groups'] as readonly { fingerprint: string; count: number }[];
}

describe('twoFactor.clearStranded / twoFactor.restoreStranded semantics', () => {
  it('disables exactly the rows on a retired key and reports how many, per key', async () => {
    const harness = await createTwoFactorHarness();

    const executed = await executeOk(harness, 'twoFactor.clearStranded', {
      reason: 'the offline copy of the key was bad',
    });

    expect(await totpStateOf(harness.strandedIds[0] ?? '')).toBe('cleared');
    expect(await totpStateOf(harness.strandedIds[1] ?? '')).toBe('cleared');
    expect(
      recordedGroups(executed.inverseInput).find(
        (group) => group.fingerprint === harness.staleKeyIdHex
      )
    ).toEqual({ fingerprint: harness.staleKeyIdHex, count: 2 });
  });

  it('leaves a second factor on the live key enabled', async () => {
    const harness = await createTwoFactorHarness();

    await executeOk(harness, 'twoFactor.clearStranded', { reason: 'sweep the retired key' });

    expect(await totpStateOf(harness.liveKeyUserId)).toBe('enabled');
  });

  it('retains the ciphertext it disabled, so the row is restorable', async () => {
    const harness = await createTwoFactorHarness();
    const strandedId = harness.strandedIds[0] ?? '';
    const before = await secretOf(strandedId);

    await executeOk(harness, 'twoFactor.clearStranded', { reason: 'retain the ciphertext' });

    expect(await secretOf(strandedId)).toEqual(before);
  });

  it('records the inverse by key id and count, never by user id', async () => {
    const harness = await createTwoFactorHarness();

    const executed = await executeOk(harness, 'twoFactor.clearStranded', {
      reason: 'record the groups',
    });

    const recorded = JSON.stringify(executed.inverseInput);
    for (const userId of [...harness.strandedIds, harness.liveKeyUserId]) {
      expect(recorded).not.toContain(userId);
    }
    expect(Object.keys(executed.inverseInput ?? {})).toEqual(['groups']);
  });

  it('re-enables exactly the rows the clear touched when its recorded inverse runs', async () => {
    const harness = await createTwoFactorHarness();
    const baseline = await harness.projection();

    const executed = await executeOk(harness, 'twoFactor.clearStranded', {
      reason: 'clear before restoring',
    });
    expect(await harness.projection()).not.toEqual(baseline);

    await executeOk(
      harness,
      'twoFactor.restoreStranded',
      { ...executed.inverseInput, reason: 'The offline copy was found after all.' },
      executed.auditId
    );

    expect(await harness.projection()).toEqual(baseline);
  });

  it('refuses a restore whose recorded count no longer stands, changing nothing', async () => {
    const harness = await createTwoFactorHarness({}, { state: 'cleared' });
    const before = await harness.projection();

    const code = await executeErr(harness, 'twoFactor.restoreStranded', {
      groups: [{ fingerprint: harness.staleKeyIdHex, count: 1 }],
      reason: 'a count that never stood',
    });

    expect(code).toBe('conflict');
    expect(await harness.projection()).toEqual(before);
    expect(await harness.auditCount()).toBe(0);
  });

  it('restores no group when a later group in the same run refuses', async () => {
    const harness = await createTwoFactorHarness({}, { state: 'cleared' });
    const before = await harness.projection();

    const code = await executeErr(harness, 'twoFactor.restoreStranded', {
      groups: [
        { fingerprint: harness.staleKeyIdHex, count: 2 },
        { fingerprint: 'ffffffffffffffff', count: 4 },
      ],
      reason: 'the second group never stood',
    });

    expect(code).toBe('conflict');
    expect(await harness.projection()).toEqual(before);
  });

  it('clears only the retired keys a scoped clear names', async () => {
    const harness = await createTwoFactorHarness();
    const unnamedKey = fixtureKey(`unnamed-${harness.staleKeyIdHex.slice(0, 4)}`);
    const unnamedId = await seedUser({ enabled: true, sealedUnder: unnamedKey });

    const executed = await executeOk(harness, 'twoFactor.clearStranded', {
      keys: [{ fingerprint: harness.staleKeyIdHex }],
      reason: 'only the key named in the runbook step',
    });

    expect(await totpStateOf(harness.strandedIds[0] ?? '')).toBe('cleared');
    expect(await totpStateOf(unnamedId)).toBe('enabled');
    expect(recordedGroups(executed.inverseInput)).toEqual([
      { fingerprint: harness.staleKeyIdHex, count: 2 },
    ]);
  });

  it('refuses a scoped clear naming a key nothing stands on, changing nothing', async () => {
    const harness = await createTwoFactorHarness();
    const before = await harness.projection();

    const code = await executeErr(harness, 'twoFactor.clearStranded', {
      keys: [{ fingerprint: 'ffffffffffffffff' }],
      reason: 'a key no row carries',
    });

    expect(code).toBe('conflict');
    expect(await harness.projection()).toEqual(before);
    expect(await harness.auditCount()).toBe(0);
  });

  it('records the keys it re-enabled as a restore\u2019s inverse input', async () => {
    const harness = await createTwoFactorHarness({}, { state: 'cleared' });

    const executed = await executeOk(harness, 'twoFactor.restoreStranded', {
      groups: [{ fingerprint: harness.staleKeyIdHex, count: 2 }],
      reason: 'the offline copy of that key was found',
    });

    expect(executed.inverseInput).toEqual({ keys: [{ fingerprint: harness.staleKeyIdHex }] });
  });

  it('undoes a restore without reaching a retired key that restore never touched', async () => {
    // The scenario the scoped inverse exists for: two retired keys, one
    // standing cleared and one standing enabled. Undoing the restore of the
    // first must not sweep the second — an unscoped inverse would, because it
    // re-measures every row against the live key rather than reversing the act.
    const harness = await createTwoFactorHarness({}, { state: 'cleared' });
    const untouchedKey = fixtureKey(`untouched-${harness.staleKeyIdHex.slice(0, 4)}`);
    const untouchedIds = [
      await seedUser({ enabled: true, sealedUnder: untouchedKey }),
      await seedUser({ enabled: true, sealedUnder: untouchedKey }),
    ];

    const restored = await executeOk(harness, 'twoFactor.restoreStranded', {
      groups: [{ fingerprint: harness.staleKeyIdHex, count: 2 }],
      reason: 'the offline copy of that key was found',
    });
    await executeOk(
      harness,
      'twoFactor.clearStranded',
      { ...restored.inverseInput, reason: 'The restore was made against the wrong key.' },
      restored.auditId
    );

    expect(await totpStateOf(untouchedIds[0] ?? '')).toBe('enabled');
    expect(await totpStateOf(untouchedIds[1] ?? '')).toBe('enabled');
    expect(await totpStateOf(harness.strandedIds[0] ?? '')).toBe('cleared');
    expect(await totpStateOf(harness.strandedIds[1] ?? '')).toBe('cleared');
  });

  it('records one group per retired key a clear spanned', async () => {
    const harness = await createTwoFactorHarness();
    const extraKeyIds: string[] = [];
    for (const label of ['span-a', 'span-b']) {
      const key = fixtureKey(`${label}-${harness.staleKeyIdHex.slice(0, 4)}`);
      extraKeyIds.push(hex(totpKeyFingerprint(key)));
      await seedUser({ enabled: true, sealedUnder: key });
    }

    const executed = await executeOk(harness, 'twoFactor.clearStranded', {
      reason: 'three retired keys at once',
    });

    const recorded = recordedGroups(executed.inverseInput).map((group) => group.fingerprint);
    expect(recorded).toContain(extraKeyIds[0]);
    expect(recorded).toContain(extraKeyIds[1]);
  });

  it('records the groups in key-id order when the door returns them descending', async () => {
    // The ordering is load-bearing and the database cannot be made to break it
    // on demand: the battery compares a preview's effects to its execute's
    // order-sensitively, and the door returns rows in `UPDATE … RETURNING`
    // scan order, which the dead tuples a rolled-back preview leaves behind
    // can legitimately change. So the door is stubbed with the reverse order,
    // and the body is what must put it back.
    const descending: StrandedGroups = [
      { fingerprint: Uint8Array.from([0xee, 0, 0, 0, 0, 0, 0, 2]), count: 3 },
      { fingerprint: Uint8Array.from([0x11, 0, 0, 0, 0, 0, 0, 1]), count: 5 },
    ];
    const harness = await createTwoFactorHarness({ strandedGroups: descending }, { stranded: 0 });

    const executed = await executeOk(harness, 'twoFactor.clearStranded', {
      reason: 'the door reports its groups in scan order',
    });

    expect(recordedGroups(executed.inverseInput)).toEqual([
      { fingerprint: '1100000000000001', count: 5 },
      { fingerprint: 'ee00000000000002', count: 3 },
    ]);
  });

  it('refuses a clear spanning more retired keys than one restore may name', async () => {
    const harness = await createTwoFactorHarness({}, { stranded: 0 });
    const overCapIds: string[] = [];
    for (let index = 0; index <= MAX_STRANDED_TOTP_GROUPS; index += 1) {
      overCapIds.push(
        await seedUser({
          enabled: true,
          sealedUnder: fixtureKey(`over-cap-${String(index)}-${harness.staleKeyIdHex.slice(0, 4)}`),
        })
      );
    }

    const refusal = await executeRefusal(harness, 'twoFactor.clearStranded', {
      reason: 'more retired keys than one undo can carry',
    });

    // Refused rather than committed: a clear whose recorded groups exceed what
    // the inverse's input may carry would be an admin mutation with no runnable
    // undo. The seeded row read back is the "rather than committing" half — the
    // sweep's UPDATE ran inside the transaction before the refusal returned.
    expect(refusal.code).toBe('conflict');
    expect(await totpStateOf(overCapIds[0] ?? '')).toBe('enabled');
    expect(await harness.auditCount()).toBe(0);
    expect(await totpStateOf(harness.liveKeyUserId)).toBe('enabled');
    // The count the sweep saw and the cap it exceeded: the operator's only
    // signal of how far behind the re-seal job has fallen. The remedy names
    // paths that exist — an unscoped re-run sweeps the same rows in one
    // statement again, so it makes no progress.
    expect(refusal.message).toContain(String(MAX_STRANDED_TOTP_GROUPS + 1));
    expect(refusal.message).toContain(String(MAX_STRANDED_TOTP_GROUPS));
    expect(refusal.message).toContain('twoFactor.clear per user');
  });

  it('refuses a clear when no second factor stands on a retired key', async () => {
    const harness = await createTwoFactorHarness();
    // The first clear sweeps every row standing on a retired key, so the
    // second one has nothing left to reach.
    await executeOk(harness, 'twoFactor.clearStranded', { reason: 'sweep everything first' });

    const code = await executeErr(harness, 'twoFactor.clearStranded', {
      reason: 'nothing left to clear',
    });

    expect(code).toBe('conflict');
  });

  it('leaves no durable change when a clear is previewed', async () => {
    const harness = await createTwoFactorHarness();
    const before = await harness.projection();

    const previewed = await harness.engine.run({
      name: 'twoFactor.clearStranded',
      input: { reason: 'show me what this would clear' },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });

    expect(previewed._unsafeUnwrap().effects.length).toBeGreaterThan(0);
    expect(await harness.projection()).toEqual(before);
  });

  it('writes no audit row when the op body fails inside the transaction', async () => {
    const harness = await createTwoFactorHarness({
      hooks: {
        afterAudit: () => {
          throw new Error('injected two-factor failure');
        },
      },
    });
    const before = await harness.projection();

    await expect(
      harness.engine.run({
        name: 'twoFactor.clearStranded',
        input: { reason: 'rolled back with its audit row' },
        actor: harness.actor,
        mode: 'execute',
        role: 'operator',
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow('injected two-factor failure');

    expect(await harness.projection()).toEqual(before);
    expect(await harness.auditCount()).toBe(0);
  });
});

describe('twoFactor.clear / twoFactor.restore semantics', () => {
  it('clears one account and restores it through the registered inverse', async () => {
    const harness = await createTwoFactorHarness({}, { stranded: 1 });
    const userId = harness.strandedIds[0] ?? '';
    const secret = await secretOf(userId);

    const executed = await executeOk(harness, 'twoFactor.clear', {
      userId,
      reason: 'the authenticator is gone',
    });
    expect(await totpStateOf(userId)).toBe('cleared');
    expect(await secretOf(userId)).toEqual(secret);
    expect(executed.inverseInput).toEqual({ userId });

    await executeOk(
      harness,
      'twoFactor.restore',
      { userId, reason: 'The customer found their authenticator.' },
      executed.auditId
    );

    expect(await totpStateOf(userId)).toBe('enabled');
  });

  it('clears a second factor sealed under the live key', async () => {
    // The state that distinguishes this op from a staleness-gated clear: the
    // door gates on `totp_enabled` alone, so the support path for a lost
    // authenticator is the same act as the stranded one.
    const harness = await createTwoFactorHarness({}, { stranded: 0 });
    const userId = harness.liveKeyUserId;

    const executed = await executeOk(harness, 'twoFactor.clear', {
      userId,
      reason: 'the authenticator is gone and the key is current',
    });

    expect(await totpStateOf(userId)).toBe('cleared');
    expect(executed.inverseInput).toEqual({ userId });
  });

  it('refuses to clear an account with no enabled second factor', async () => {
    const harness = await createTwoFactorHarness({}, { stranded: 1, state: 'cleared' });

    const code = await executeErr(harness, 'twoFactor.clear', {
      userId: harness.strandedIds[0] ?? '',
      reason: 'already cleared',
    });

    expect(code).toBe('conflict');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses to restore an account that is not in the cleared state', async () => {
    const harness = await createTwoFactorHarness({}, { stranded: 1 });

    const code = await executeErr(harness, 'twoFactor.restore', {
      userId: harness.strandedIds[0] ?? '',
      reason: 'nothing was cleared',
    });

    expect(code).toBe('conflict');
  });

  it('refuses an unknown account with a typed not-found on both per-user ops', async () => {
    const harness = await createTwoFactorHarness({}, { stranded: 0 });
    const missing = crypto.randomUUID();

    for (const name of ['twoFactor.clear', 'twoFactor.restore']) {
      expect(await executeErr(harness, name, { userId: missing, reason: 'missing' }), name).toBe(
        'not_found'
      );
    }
    expect(await harness.auditCount()).toBe(0);
  });

  it('leaves no durable change when a per-user clear is previewed', async () => {
    const harness = await createTwoFactorHarness({}, { stranded: 1 });
    const userId = harness.strandedIds[0] ?? '';

    const previewed = await harness.engine.run({
      name: 'twoFactor.clear',
      input: { userId, reason: 'show me' },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });

    expect(previewed.isOk()).toBe(true);
    expect(await totpStateOf(userId)).toBe('enabled');
  });

  it('does not reach any account but its target', async () => {
    const harness = await createTwoFactorHarness();

    await executeOk(harness, 'twoFactor.clear', {
      userId: harness.strandedIds[0] ?? '',
      reason: 'one account only',
    });

    expect(await totpStateOf(harness.strandedIds[1] ?? '')).toBe('enabled');
    expect(await totpStateOf(harness.liveKeyUserId)).toBe('enabled');
  });
});

describe('the two-factor op contracts', () => {
  it('declare the durable effect class and register both pairs as inverses', () => {
    const registry = createAdminOpRegistry<AdminTwoFactorDeps>([...adminTwoFactorOperations]);

    for (const name of [
      'twoFactor.clearStranded',
      'twoFactor.restoreStranded',
      'twoFactor.clear',
      'twoFactor.restore',
    ] as const) {
      expect(ADMIN_OP_CONTRACTS[name].effectClass, name).toBe('durable');
      expect(registry.get(name)?.contract.inverse, name).toBe(ADMIN_OP_CONTRACTS[name].inverse);
    }
  });

  it('fails the Iron Law gate when one half of a pair is registered alone', () => {
    const lone = adminTwoFactorOperations.filter(
      (operation) => operation.contract.name === 'twoFactor.clearStranded'
    );

    expect(() => createAdminOpRegistry<AdminTwoFactorDeps>(lone)).toThrow(/Reversibility Iron Law/);
  });
});
