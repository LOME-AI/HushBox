import { Redis } from '@upstash/redis';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  jobs,
  users,
} from '@hushbox/db';
import { lockedUserFactory, userFactory } from '@hushbox/db/factories';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  checkSessionLiveness,
  createIdentityStores,
  createSessionRevokeJobRegistration,
  issueSession,
  revokeAllSessions,
} from '../../../identity/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import {
  createAppJobRegistry,
  createJobWakeCollector,
  grantJobWakes,
} from '../../../../lib/jobs/index.js';
import { errAsync } from '../../../../lib/result/index.js';
import { createAdminAuditReads } from '../../adapters/audit-reads.js';
import { createAdminStores } from '../../adapters/stores.js';
import { loadCustomer360 } from '../customer-360.js';
import { READ_AUDIT_ACTIONS } from '../read-audit.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { withUndoReason } from '../undo-round-trip.js';
import { adminUserOperations } from './index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { EvictUserPort } from '../../../identity/index.js';
import type { AdminCrossSliceReads } from '../../ports/index.js';
import type { Customer360Deps } from '../customer-360.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type { AdminOpHarnessInstance, AdminOpInterleavingAction } from '../describe-admin-op.js';
import type { JobShard } from '../../../../lib/jobs/index.js';
import type { AdminUserDeps, AdminUserPostDeps } from './user.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for admin user op tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const identityStores = createIdentityStores(db);
const adminStores = createAdminStores();
const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

const LOCK_CONTRACT = ADMIN_OP_CONTRACTS['user.lock'];
const UNLOCK_CONTRACT = ADMIN_OP_CONTRACTS['user.unlock'];
const REVOKE_ALL_CONTRACT = ADMIN_OP_CONTRACTS['sessions.revokeAll'];

/** Every user the harnesses create — their enqueued revoke jobs are cleared below. */
const createdUserIds: string[] = [];

afterAll(async () => {
  // admin_audit is append-only (actor-isolated); user rows are uuid-isolated.
  // Only the engine-claim key rows are removed; the session keys carry TTLs.
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/user.%'));
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/sessions.%'));
  // The lock/revokeAll ops commit session.revoke.v1 rows (bulk shard); clear
  // them so they never linger claimable on the shared jobs table.
  if (createdUserIds.length > 0) {
    await db.delete(jobs).where(
      inArray(
        jobs.dedupeKey,
        createdUserIds.map((id) => `session-revoke:${id}`)
      )
    );
  }
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    captureError: noop,
  };
}

interface EvictProbeState {
  readonly evicted: string[];
  armed: boolean;
}

/**
 * The ops' post-commit ephemeral seam: a recording eviction port that logs
 * each landed eviction and, when armed, rejects before recording (so the
 * battery can prove an ephemeral failure never fails the committed op).
 */
function probeEvict(state: EvictProbeState): EvictUserPort {
  return {
    evictUser: (userId: string): Promise<void> => {
      if (state.armed) return Promise.reject(new Error('evict probe armed to fail'));
      state.evicted.push(userId);
      return Promise.resolve();
    },
  };
}

interface UserHarness extends AdminOpHarnessInstance {
  readonly userId: string;
  readonly evicted: string[];
  /** The shards this harness's ops left for the request boundary to nudge. */
  readonly wakes: () => readonly JobShard[];
  /** The enqueued session.revoke.v1 row for this user, or undefined if none. */
  enqueuedRevoke(): Promise<{ type: string; shard: string } | undefined>;
  /** Runs the enqueued revoke job's handler — the work the dispatcher performs. */
  runEnqueuedRevoke(): Promise<void>;
}

async function createUserHarness(
  options: { hooks?: AdminOpEngineHooks } = {},
  seed: { locked?: boolean; lockReason?: 'chargeback' | 'admin' } = {}
): Promise<UserHarness> {
  const values =
    seed.locked === true
      ? lockedUserFactory.build({ lockReason: seed.lockReason ?? 'chargeback' })
      : userFactory.build();
  const [user] = await db.insert(users).values(values).returning({ id: users.id });
  if (user === undefined) throw new Error('user harness: user insert returned no row');
  createdUserIds.push(user.id);
  const actor = `admin-user-test-${crypto.randomUUID()}@hushbox.ai`;
  // A collector per harness on the shared handle: re-granting REPLACES the
  // collector, which is the per-test isolation wanted here (files run their
  // tests in order) and is exactly why a production boundary keeps its mint
  // and its discharge in one scope instead.
  const jobWakes = createJobWakeCollector();
  grantJobWakes(db, jobWakes);
  const probe: EvictProbeState = { evicted: [], armed: false };
  const evictPort = probeEvict(probe);
  // The durable revocation cutoff runs through this registration (real Redis
  // watermark bump), exactly as the live dispatcher would; the op only enqueues
  // it in-tx. The eviction port is shared so the job's best-effort eviction and
  // the op's prompt one land in one recorded log.
  const sessionRevokeRegistration = createSessionRevokeJobRegistration({
    resolveRevoke: () => ({ redis, evictUser: evictPort }),
    now: () => Date.now(),
  });
  const jobRegistry = createAppJobRegistry([sessionRevokeRegistration]);
  // Two separately constructed objects: the eviction port reaches the effect
  // only through the post-commit half, never from an op body's `ctx.deps`.
  const opDeps: AdminUserDeps = {
    // The same narrowed identity surface the composition root binds, so the
    // battery runs the ops against a value carrying no base-database write
    // rather than one the type merely hides.
    identityStores: {
      users: {
        lockForDeletionWithinTx: identityStores.users.lockForDeletionWithinTx.bind(
          identityStores.users
        ),
        lockUserWithinTx: identityStores.users.lockUserWithinTx.bind(identityStores.users),
        unlockUserWithinTx: identityStores.users.unlockUserWithinTx.bind(identityStores.users),
      },
    },
    jobRegistry,
  };
  const postDeps: AdminUserPostDeps = { evictUser: evictPort };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminUserDeps, AdminUserPostDeps>([...adminUserOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps,
    postDeps,
    executorId: `admin-user-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    userId: user.id,
    evicted: probe.evicted,
    wakes: (): readonly JobShard[] => jobWakes.shards(),
    projection: async (): Promise<{ locked: boolean; lockReason: string | null }> => {
      const rows = await db
        .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
        .from(users)
        .where(eq(users.id, user.id));
      const row = rows[0];
      if (row === undefined) throw new Error('user harness: projection user is gone');
      return { locked: row.lockedAt !== null, lockReason: row.lockReason };
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    enqueuedRevoke: async (): Promise<{ type: string; shard: string } | undefined> => {
      const rows = await db
        .select({ type: jobs.type, shard: jobs.shard })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `session-revoke:${user.id}`));
      return rows[0];
    },
    runEnqueuedRevoke: async (): Promise<void> => {
      const rows = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `session-revoke:${user.id}`));
      const row = rows[0];
      if (row === undefined) throw new Error('user harness: no session.revoke.v1 job enqueued');
      await sessionRevokeRegistration.handler({
        jobId: row.id,
        payload: { userId: user.id },
        claims: 1,
        completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
      });
    },
    ephemeral: {
      log: () => probe.evicted,
      armFailure: () => {
        probe.armed = true;
      },
    },
  };
}

function userOf(harness: AdminOpHarnessInstance): string {
  return (harness as UserHarness).userId;
}

async function livenessOf(inputs: {
  userId: string;
  sessionId: string;
  createdAt: number;
}): Promise<'active' | 'revoked'> {
  const result = await checkSessionLiveness(redis, inputs);
  return result._unsafeUnwrap();
}

async function issueFullSession(userId: string, createdAt: number): Promise<string> {
  const result = await issueSession({
    request: new Request('http://localhost/auth/login/finish'),
    response: new Response(),
    redis,
    secret: SESSION_SECRET,
    isProduction: false,
    userId,
    kind: 'full',
    now: createdAt,
  });
  return result._unsafeUnwrap().sessionId;
}

/**
 * Seeded session-churn interleavings. Lock state (the projection) is durable
 * and admin-owned; session activity is the ephemeral state `user.lock`'s
 * containment touches — churning it between op and undo proves the pair's
 * durable delta nets to zero regardless. A chargeback-lock action is
 * deliberately excluded: it is a non-commutative write to the same flag the
 * op owns (the Charter's feasibility rule excludes conflicting actions).
 */
const sessionChurnActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'user-logs-in',
    run: async (harness, rng) => {
      await issueFullSession(userOf(harness), Date.now() + Math.floor(rng() * 10_000));
    },
  },
  {
    name: 'user-logs-out-everywhere',
    run: async (harness, rng) => {
      const revoked = await revokeAllSessions(
        redis,
        userOf(harness),
        Date.now() + Math.floor(rng() * 10_000)
      );
      revoked._unsafeUnwrap();
    },
  },
];

const lockTarget = { userId: '' };
describeAdminOp({
  contract: LOCK_CONTRACT,
  createHarness: async (options) => {
    const harness = await createUserHarness(options);
    lockTarget.userId = harness.userId;
    return harness;
  },
  validInput: () => ({
    userId: lockTarget.userId,
    lockReason: 'admin',
    reason: `contain account ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', lockReason: 'admin', reason: 'x' },
  hasEphemeralEffects: true,
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      userId: userOf(harness),
      lockReason: 'admin',
      reason: `interleaving lock ${crypto.randomUUID()}`,
    }),
    actions: sessionChurnActions,
  },
});

const unlockTarget = { userId: '' };
describeAdminOp({
  contract: UNLOCK_CONTRACT,
  createHarness: async (options) => {
    const harness = await createUserHarness(options, { locked: true, lockReason: 'chargeback' });
    unlockTarget.userId = harness.userId;
    return harness;
  },
  validInput: () => ({
    userId: unlockTarget.userId,
    reason: `dispute resolved ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', reason: 'x' },
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      userId: userOf(harness),
      reason: `interleaving unlock ${crypto.randomUUID()}`,
    }),
    actions: sessionChurnActions,
  },
});

const revokeAllTarget = { userId: '' };
describeAdminOp({
  contract: REVOKE_ALL_CONTRACT,
  createHarness: async (options) => {
    const harness = await createUserHarness(options);
    revokeAllTarget.userId = harness.userId;
    return harness;
  },
  validInput: () => ({
    userId: revokeAllTarget.userId,
    reason: `suspected session theft ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', reason: 'x' },
  hasEphemeralEffects: true,
});

async function executeOk(
  harness: UserHarness,
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

describe('user.lock / user.unlock / sessions.revokeAll semantics', () => {
  it('kills a live session at the next request when the user is locked (full containment)', async () => {
    const harness = await createUserHarness();
    const createdAt = Date.now();
    const sessionId = await issueFullSession(harness.userId, createdAt);
    const inputs = { userId: harness.userId, sessionId, createdAt };
    expect(await livenessOf(inputs)).toBe('active');

    await executeOk(harness, 'user.lock', {
      userId: harness.userId,
      lockReason: 'admin',
      reason: 'containment probe',
    });

    // The durable cutoff is the enqueued session.revoke.v1 job (committed in the
    // settlement tx), not a post-commit watermark bump — so the session stays
    // live until the job runs; the ephemeral evicted the socket for promptness.
    expect(harness.evicted).toEqual([harness.userId]);
    expect(await harness.enqueuedRevoke()).toEqual({ type: 'session.revoke.v1', shard: 'bulk' });
    expect(await livenessOf(inputs)).toBe('active');

    // The dispatcher runs the job: its watermark bump is what revokes the session.
    await harness.runEnqueuedRevoke();
    expect(await livenessOf(inputs)).toBe('revoked');
  });

  it('enqueues the session.revoke.v1 cutoff in the settlement tx and never in preview', async () => {
    const harness = await createUserHarness();

    const previewed = await harness.engine.run({
      name: 'user.lock',
      input: { userId: harness.userId, lockReason: 'admin', reason: 'preview only' },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    previewed._unsafeUnwrap();
    expect(await harness.enqueuedRevoke()).toBeUndefined();

    await executeOk(harness, 'user.lock', {
      userId: harness.userId,
      lockReason: 'admin',
      reason: 'commit the lock',
    });
    expect(await harness.enqueuedRevoke()).toEqual({ type: 'session.revoke.v1', shard: 'bulk' });
  });

  it('leaves user.lock\u2019s bulk wake on the boundary, and nothing on a preview', async () => {
    const harness = await createUserHarness();

    const previewed = await harness.engine.run({
      name: 'user.lock',
      input: { userId: harness.userId, lockReason: 'admin', reason: 'preview only' },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    previewed._unsafeUnwrap();
    // The op body holds no wake of its own; a rolled-back preview merges none.
    expect(harness.wakes()).toEqual([]);

    await executeOk(harness, 'user.lock', {
      userId: harness.userId,
      lockReason: 'admin',
      reason: 'commit the lock',
    });
    expect(harness.wakes()).toEqual(['bulk']);
  });

  it('leaves sessions.revokeAll\u2019s bulk wake on the boundary', async () => {
    const harness = await createUserHarness();

    await executeOk(harness, 'sessions.revokeAll', {
      userId: harness.userId,
      reason: 'containment sweep',
    });

    expect(harness.wakes()).toEqual(['bulk']);
  });

  it('restores the ORIGINAL lock reason when an unlock is undone (chargeback, not admin)', async () => {
    const harness = await createUserHarness({}, { locked: true, lockReason: 'chargeback' });

    const unlocked = await executeOk(harness, 'user.unlock', {
      userId: harness.userId,
      reason: 'dispute resolved',
    });
    expect(await harness.projection()).toEqual({ locked: false, lockReason: null });
    if (unlocked.inverseInput === null) throw new Error('expected inverseInput');
    expect(unlocked.inverseInput['lockReason']).toBe('chargeback');

    await executeOk(
      harness,
      'user.lock',
      withUndoReason(unlocked.inverseInput, 'The dispute was reopened by the bank.'),
      unlocked.auditId
    );

    expect(await harness.projection()).toEqual({ locked: true, lockReason: 'chargeback' });
  });

  it('refuses to clobber a standing lock — already-locked is a conflict, nothing committed', async () => {
    const harness = await createUserHarness({}, { locked: true, lockReason: 'chargeback' });

    const result = await harness.engine.run({
      name: 'user.lock',
      input: { userId: harness.userId, lockReason: 'admin', reason: 'double lock' },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.projection()).toEqual({ locked: true, lockReason: 'chargeback' });
    expect(await harness.auditCount()).toBe(0);
    // A refused lock commits nothing — no revoke job is enqueued.
    expect(await harness.enqueuedRevoke()).toBeUndefined();
  });

  it('refuses to unlock an unlocked user with a typed conflict', async () => {
    const harness = await createUserHarness();

    const result = await harness.engine.run({
      name: 'user.unlock',
      input: { userId: harness.userId, reason: 'nothing to unlock' },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an unknown user with a typed not-found on every user op', async () => {
    const harness = await createUserHarness();
    const missing = crypto.randomUUID();
    const attempts: [string, Record<string, unknown>][] = [
      ['user.lock', { userId: missing, lockReason: 'admin', reason: 'missing' }],
      ['user.unlock', { userId: missing, reason: 'missing' }],
      ['sessions.revokeAll', { userId: missing, reason: 'missing' }],
    ];

    for (const [name, input] of attempts) {
      const result = await harness.engine.run({
        name,
        input,
        actor: harness.actor,
        mode: 'execute',
        role: 'operator',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(result.isErr() && result.error.code).toBe('not_found');
    }
    expect(await harness.auditCount()).toBe(0);
  });

  it('does not restore sessions on unlock — a lock-revoked session stays dead', async () => {
    const harness = await createUserHarness();
    const createdAt = Date.now();
    const sessionId = await issueFullSession(harness.userId, createdAt);
    const inputs = { userId: harness.userId, sessionId, createdAt };

    await executeOk(harness, 'user.lock', {
      userId: harness.userId,
      lockReason: 'admin',
      reason: 'lock first',
    });
    await harness.runEnqueuedRevoke();
    await executeOk(harness, 'user.unlock', {
      userId: harness.userId,
      reason: 'unlock after',
    });

    expect(await livenessOf(inputs)).toBe('revoked');
  });

  it('sessions.revokeAll kills a live session through the durable job and evicts best-effort', async () => {
    const harness = await createUserHarness();
    const createdAt = Date.now();
    const sessionId = await issueFullSession(harness.userId, createdAt);
    const inputs = { userId: harness.userId, sessionId, createdAt };
    expect(await livenessOf(inputs)).toBe('active');

    const executed = await executeOk(harness, 'sessions.revokeAll', {
      userId: harness.userId,
      reason: 'revoke everything',
    });

    expect(executed.inverseInput).toBeNull();
    expect(harness.evicted).toEqual([harness.userId]);
    expect(await harness.enqueuedRevoke()).toEqual({ type: 'session.revoke.v1', shard: 'bulk' });
    await harness.runEnqueuedRevoke();
    expect(await livenessOf(inputs)).toBe('revoked');
    expect(await harness.projection()).toEqual({ locked: false, lockReason: null });
  });

  it('registers lock/unlock as an inverse pair and revokeAll alone (Iron Law gate)', () => {
    const registry = createAdminOpRegistry<AdminUserDeps, AdminUserPostDeps>([
      ...adminUserOperations,
    ]);

    expect(registry.get('user.lock')?.contract.inverse).toBe('user.unlock');
    expect(registry.get('user.unlock')?.contract.inverse).toBe('user.lock');
    expect(registry.get('sessions.revokeAll')?.contract.inverse).toBeNull();

    const loneLock = adminUserOperations.filter(
      (operation) => operation.contract.name === 'user.lock'
    );
    expect(() => createAdminOpRegistry<AdminUserDeps, AdminUserPostDeps>(loneLock)).toThrow(
      /Reversibility Iron Law/
    );
  });
});

/**
 * The header's account facts, beside rejecting stubs for every panel this
 * block does not read: a panel whose read rejects loads as failed and never
 * blanks the view, so the admin-history panel is observable here without
 * billing, notifications or conversations wiring. The account-facts read is
 * not the view's only unstubbable dependency — a failed identity lookup fails
 * the whole view too, which is why `customer360Deps` hands it the real users
 * store.
 */
function headerOnlyCrossSlice(): AdminCrossSliceReads {
  const notUnderTest = (): Promise<never> =>
    Promise.reject(new Error('panel not under test in this block'));
  return {
    userAccountFacts: () =>
      Promise.resolve({ createdAt: new Date(TEST_DAY_START), lockReason: null }),
    walletSummaries: notUnderTest,
    deviceTokenSummary: notUnderTest,
    conversationCounts: notUnderTest,
    jobsTouchingUser: notUnderTest,
    listJobs: notUnderTest,
    jobCounts: notUnderTest,
  };
}

function customer360Deps(): Customer360Deps {
  // A refused read, never a throw: the money panel's isolation catches a
  // failed `Result`, while a synchronous throw escapes it and fails the whole
  // view — which would red this block for the stub rather than for the row.
  const billingUnavailable = <T>(): ResultAsync<T, DomainError> =>
    errAsync(unavailableError('billing panel not under test in this block'));
  return {
    db,
    role: 'operator' as const,
    stores: adminStores,
    auditReads: createAdminAuditReads(),
    crossSlice: headerOnlyCrossSlice(),
    identity: identityStores.users,
    billing: {
      balance: billingUnavailable,
      ledgerHistory: billingUnavailable,
      usage: billingUnavailable,
    },
    clock: { now: (): Date => new Date(TEST_DAY_START) },
  };
}

describe('a preview against a named user reaches the target-scoped review surfaces', () => {
  it('is returned by a target-filtered audit query for that user', async () => {
    const harness = await createUserHarness();

    const previewed = await harness.engine.run({
      name: 'user.lock',
      input: { userId: harness.userId, lockReason: 'admin', reason: 'probing the account' },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isOk()).toBe(true);

    const page = await createAdminAuditReads().search(db, {
      targetType: 'user',
      targetId: harness.userId,
      limit: 10,
    });

    expect(page.rows.map((row) => row.action)).toEqual([READ_AUDIT_ACTIONS.opPreview]);
  });

  it('records a preview against a user id that does not exist', async () => {
    const harness = await createUserHarness();
    const missing = crypto.randomUUID();

    const previewed = await harness.engine.run({
      name: 'user.lock',
      input: {
        userId: missing,
        lockReason: 'admin',
        reason: 'probing an id that resolves to nobody',
      },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isErr()).toBe(true);

    // Unconditional: the row goes down before the transaction, so its presence
    // says nothing about whether the id names an account — which is why this
    // member records the target it was handed and still writes first.
    const page = await createAdminAuditReads().search(db, {
      targetType: 'user',
      targetId: missing,
      limit: 10,
    });
    expect(page.rows.map((row) => row.action)).toEqual([READ_AUDIT_ACTIONS.opPreview]);
  });

  it('appears in that user’s admin-history panel', async () => {
    const harness = await createUserHarness();

    const previewed = await harness.engine.run({
      name: 'user.lock',
      input: { userId: harness.userId, lockReason: 'admin', reason: 'probing the account' },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isOk()).toBe(true);

    const view = await loadCustomer360(customer360Deps(), {
      actor: `admin-360-${crypto.randomUUID()}@hushbox.ai`,
      query: { userId: harness.userId },
    });

    expect(view.isOk()).toBe(true);
    if (!view.isOk()) return;
    const panel = view.value.panels.adminHistory;
    expect(panel.ok).toBe(true);
    if (!panel.ok) return;
    expect(panel.data.actions.map((row) => row.action)).toContain(READ_AUDIT_ACTIONS.opPreview);
  });
});
