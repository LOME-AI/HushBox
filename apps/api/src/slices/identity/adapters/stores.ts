import { and, asc, count, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { FINGERPRINT_BYTES } from '@hushbox/crypto';
import {
  accountDeletionEvents,
  termsAcceptances,
  userAcquisition,
  users,
  verificationTokens,
} from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  AcquisitionSelfReport,
  AcquisitionValues,
  ClearTotpOutcome,
  ConsumeEmailVerificationOutcome,
  DisableTotpOutcome,
  EnableTotpOutcome,
  IdentityStores,
  IdentityUserRecord,
  InsertRegisteredOutcome,
  LockUserOutcome,
  RecordSelfReportOutcome,
  RegistrationValues,
  ResealServerMaterialOutcome,
  RestoreStrandedTotpOutcome,
  RestoreTotpOutcome,
  RotatePasswordArgs,
  RotatePasswordOutcome,
  ServerMaterialRow,
  StrandedTotpGroup,
  UnlockUserOutcome,
  UnverifiedUser,
  UserLockReason,
} from '../ports/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('identity store query failed', cause);
}

const RECORD_COLUMNS = {
  id: users.id,
  email: users.email,
  username: users.username,
  opaqueRegistration: users.opaqueRegistration,
  opaqueServerMaterial: users.opaqueServerMaterial,
  opaqueKekFingerprint: users.opaqueKekFingerprint,
  publicKey: users.publicKey,
  passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
  recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
  recoveryPublicKey: users.recoveryPublicKey,
  totpSecretEncrypted: users.totpSecretEncrypted,
  totpEnabled: users.totpEnabled,
  lockedAt: users.lockedAt,
  emailVerified: users.emailVerified,
  hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
} as const;

/**
 * The registration INSERT inside a settlement transaction. `ON CONFLICT DO
 * NOTHING` keeps a racing duplicate from poisoning the transaction (a throwing
 * unique violation would abort every sibling write): a conflict returns zero
 * rows, and the two discriminable outcomes are then read back — email first,
 * so a row colliding on both constraints reports the email.
 */
async function insertRegisteredUserWithinTx(
  tx: SettlementTx,
  values: RegistrationValues
): Promise<InsertRegisteredOutcome> {
  const inserted = await tx
    .insert(users)
    .values({ ...values, emailVerified: false })
    .onConflictDoNothing()
    .returning({ id: users.id });
  const created = inserted[0];
  if (created !== undefined) return { kind: 'created', userId: created.id };
  const byEmail = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, values.email))
    .limit(1);
  return byEmail.length > 0 ? { kind: 'email-taken' } : { kind: 'username-taken' };
}

/**
 * First answer wins. The guard is in the WHERE clause, so two answers racing
 * from two tabs resolve at the row rather than in application code; zero rows
 * is then read back, because "no acquisition row" and "already answered" are
 * different states that a rows-affected count alone cannot separate.
 */
async function recordSelfReportedChannelAtomic(
  db: Database,
  input: {
    readonly userId: string;
    readonly channel: AcquisitionSelfReport['channel'] & string;
    readonly context: NonNullable<AcquisitionSelfReport['skipped']>;
    readonly at: Date;
  }
): Promise<RecordSelfReportOutcome> {
  const updated = await db
    .update(userAcquisition)
    .set({
      selfReportedChannel: input.channel,
      selfReportedContext: input.context,
      selfReportedAt: input.at,
    })
    .where(
      and(eq(userAcquisition.userId, input.userId), isNull(userAcquisition.selfReportedChannel))
    )
    .returning({ id: userAcquisition.id });
  if (updated.length > 0) return 'recorded';
  const existing = await db
    .select({ id: userAcquisition.id })
    .from(userAcquisition)
    .where(eq(userAcquisition.userId, input.userId))
    .limit(1);
  return existing.length > 0 ? 'already-answered' : 'no-account-row';
}

async function enableTotpAtomic(
  db: Database,
  userId: string,
  encryptedSecret: Uint8Array
): Promise<EnableTotpOutcome> {
  const updated = await db
    .update(users)
    .set({ totpSecretEncrypted: encryptedSecret, totpEnabled: true })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, false)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'enabled' : 'already-enabled';
}

/**
 * The credential rotation as a compare-and-swap on the record bytes the flow
 * observed at its init round. Zero rows means the record moved underneath the
 * flow (a racing rotation); the caller answers a typed conflict rather than
 * reading the row back, because the client cannot resume either way.
 */
async function rotatePasswordAtomic(
  db: Database,
  args: RotatePasswordArgs
): Promise<RotatePasswordOutcome> {
  const updated = await db
    .update(users)
    .set({
      opaqueRegistration: args.opaqueRegistration,
      passwordWrappedPrivateKey: args.passwordWrappedPrivateKey,
      opaqueServerMaterial: args.opaqueServerMaterial,
      opaqueKekFingerprint: args.opaqueKekFingerprint,
    })
    .where(and(eq(users.id, args.userId), eq(users.opaqueRegistration, args.observedRegistration)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'rotated' : 'conflict';
}

interface ResealArgs {
  readonly userId: string;
  readonly observedBlob: Uint8Array;
  readonly newBlob: Uint8Array;
  readonly newFingerprint: Uint8Array;
}

async function resealServerMaterialAtomic(
  db: Database,
  args: ResealArgs
): Promise<ResealServerMaterialOutcome> {
  const updated = await db
    .update(users)
    .set({ opaqueServerMaterial: args.newBlob, opaqueKekFingerprint: args.newFingerprint })
    .where(and(eq(users.id, args.userId), eq(users.opaqueServerMaterial, args.observedBlob)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'resealed' : 'already-done';
}

async function resealTotpSecretAtomic(
  db: Database,
  args: { readonly userId: string; readonly observedBlob: Uint8Array; readonly newBlob: Uint8Array }
): Promise<ResealServerMaterialOutcome> {
  const updated = await db
    .update(users)
    .set({ totpSecretEncrypted: args.newBlob })
    .where(and(eq(users.id, args.userId), eq(users.totpSecretEncrypted, args.observedBlob)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'resealed' : 'already-done';
}

async function readServerMaterialBatch(
  db: Database,
  afterId: string | null,
  limit: number
): Promise<ServerMaterialRow[]> {
  return db
    .select({
      id: users.id,
      opaqueServerMaterial: users.opaqueServerMaterial,
      opaqueKekFingerprint: users.opaqueKekFingerprint,
      totpSecretEncrypted: users.totpSecretEncrypted,
      totpEnabled: users.totpEnabled,
    })
    .from(users)
    .where(afterId === null ? undefined : gt(users.id, afterId))
    .orderBy(asc(users.id))
    .limit(limit);
}

async function disableTotpAtomic(db: Database, userId: string): Promise<DisableTotpOutcome> {
  const updated = await db
    .update(users)
    .set({ totpSecretEncrypted: null, totpEnabled: false })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, true)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'disabled' : 'not-enabled';
}

/**
 * The key id a stored TOTP blob carries: its leading fingerprint bytes
 * (`encryptTotpSecret` writes `fingerprint ‖ sealed`). Decoded through the
 * column's own codec so a returned key id is the same `Uint8Array` shape a
 * column read gives.
 */
const TOTP_KEY_ID =
  sql`substring(${users.totpSecretEncrypted} from 1 for ${FINGERPRINT_BYTES})`.mapWith(
    users.totpSecretEncrypted
  );

/** A fingerprint bound as a bytea parameter through the column's codec. */
function boundTotpKeyId(fingerprint: Uint8Array): SQL {
  return sql`${sql.param(fingerprint, users.totpSecretEncrypted)}`;
}

/**
 * The cleared state — flag off, ciphertext retained. Only the admin clear
 * doors produce it: a user's own disable nulls the ciphertext, and enable
 * writes flag and ciphertext together. That is what lets the bulk inverse
 * referee on fingerprint + count without user ids.
 */
function totpCleared(): SQL {
  return sql`${eq(users.totpEnabled, false)} AND ${isNotNull(users.totpSecretEncrypted)}`;
}

/**
 * Narrows a sweep to named key ids. Only ever narrows — the staleness
 * predicate stands beside it, so naming the live key reaches nothing. The
 * list is non-empty at every caller (the admin contract bounds it), so no
 * empty-`IN` form is constructed.
 */
function underTotpKeyIds(keyIds: readonly Uint8Array[]): SQL {
  const bound = keyIds.map((keyId) => boundTotpKeyId(keyId));
  const separator = sql`, `;
  return sql`${TOTP_KEY_ID} in (${sql.join(bound, separator)})`;
}

async function disableStrandedTotpTx(
  tx: SettlementTx,
  currentFingerprint: Uint8Array,
  keyIds?: readonly Uint8Array[]
): Promise<StrandedTotpGroup[]> {
  const rows = await tx
    .update(users)
    .set({ totpEnabled: false })
    .where(
      and(
        eq(users.totpEnabled, true),
        isNotNull(users.totpSecretEncrypted),
        ne(TOTP_KEY_ID, boundTotpKeyId(currentFingerprint)),
        keyIds === undefined ? undefined : underTotpKeyIds(keyIds)
      )
    )
    .returning({ fingerprint: TOTP_KEY_ID });
  const groups = new Map<string, StrandedTotpGroup>();
  for (const row of rows) {
    const key = Buffer.from(row.fingerprint).toString('hex');
    const group = groups.get(key);
    groups.set(
      key,
      group === undefined
        ? { fingerprint: row.fingerprint, count: 1 }
        : { fingerprint: group.fingerprint, count: group.count + 1 }
    );
  }
  return [...groups.values()];
}

/**
 * One conditional UPDATE: the count of cleared rows under the fingerprint is
 * a subquery in the predicate, so the statement's own snapshot decides both
 * the count and the rows — never check-then-act. Zero rows means the count
 * did not match (a racing restore already took the rows, or a different clear
 * touched the group); nothing is written.
 */
async function restoreStrandedTotpTx(
  tx: SettlementTx,
  fingerprint: Uint8Array,
  expectedCount: number
): Promise<RestoreStrandedTotpOutcome> {
  const underFingerprint = and(totpCleared(), eq(TOTP_KEY_ID, boundTotpKeyId(fingerprint)));
  const matching = tx.select({ count: count() }).from(users).where(underFingerprint);
  const updated = await tx
    .update(users)
    .set({ totpEnabled: true })
    .where(and(underFingerprint, eq(sql`(${matching})`, expectedCount)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'restored' : 'count-mismatch';
}

/** Disambiguates a zero-row per-user transition: the row is absent, or it is in some other state. */
async function userRowExists(tx: SettlementTx, userId: string): Promise<boolean> {
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return rows.length > 0;
}

async function clearTotpTx(tx: SettlementTx, userId: string): Promise<ClearTotpOutcome> {
  const updated = await tx
    .update(users)
    .set({ totpEnabled: false })
    .where(
      and(eq(users.id, userId), eq(users.totpEnabled, true), isNotNull(users.totpSecretEncrypted))
    )
    .returning({ fingerprint: TOTP_KEY_ID });
  const row = updated[0];
  if (row !== undefined) return { kind: 'cleared', fingerprint: row.fingerprint };
  return (await userRowExists(tx, userId)) ? { kind: 'not-enabled' } : { kind: 'not-found' };
}

async function restoreTotpTx(tx: SettlementTx, userId: string): Promise<RestoreTotpOutcome> {
  const updated = await tx
    .update(users)
    .set({ totpEnabled: true })
    .where(and(eq(users.id, userId), totpCleared()))
    .returning({ id: users.id });
  if (updated.length > 0) return 'restored';
  return (await userRowExists(tx, userId)) ? 'not-cleared' : 'not-found';
}

/**
 * The deletion executor's opening lock: `SELECT email … FOR UPDATE` on the
 * users row. Serializes racing finishes (the loser blocks, then sees null once
 * the winner's delete commits) and captures the email before the cascade
 * destroys it — the post-commit notification's only source.
 */
async function lockForDeletionTx(
  tx: SettlementTx,
  userId: string
): Promise<{ email: string } | null> {
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  return rows[0] ?? null;
}

/**
 * The chargeback auto-defense lock, run on the webhook's clawback `SettlementTx`
 * so the lock and the ledger clawback commit atomically (a lock failure rolls
 * the clawback back). An atomic conditional UPDATE guarded by `locked_at IS
 * NULL`, so exactly the first delivery flips the row and every later delivery
 * matches zero rows (idempotent — never check-then-act). `locked_at` and
 * `lock_reason` are written together to keep the users-table check constraint
 * (both null or both set) satisfied; `now()` is DB-side so the timestamp is
 * authoritative regardless of the caller's clock. Returns `locked` true with the
 * captured email and username when this delivery transitioned the row, else
 * `locked` false with both null — the notification rides only the fresh
 * transition.
 */
async function lockForChargebackWithinTx(
  tx: SettlementTx,
  userId: string
): Promise<{ locked: boolean; email: string | null; userName: string | null }> {
  const updated = await tx
    .update(users)
    .set({ lockedAt: sql`now()`, lockReason: 'chargeback' })
    .where(and(eq(users.id, userId), isNull(users.lockedAt)))
    .returning({ email: users.email, userName: users.username });
  const row = updated[0];
  return row === undefined
    ? { locked: false, email: null, userName: null }
    : { locked: true, email: row.email, userName: row.userName };
}

/**
 * The general reason-parameterized lock on the caller's transaction. An atomic
 * conditional UPDATE guarded by `locked_at IS NULL` (never check-then-act);
 * `locked_at` and `lock_reason` are written together to keep the users-table
 * paired-null check constraint satisfied, and `now()` is DB-side so the
 * timestamp is authoritative regardless of the caller's clock. On 0 rows the
 * actual state is read back inside the same transaction to disambiguate: an
 * existing lock is reported as-is (`already-locked` — the original reason and
 * timestamp are never clobbered), a missing row is `not-found`.
 */
async function lockUserTx(
  tx: SettlementTx,
  userId: string,
  reason: UserLockReason
): Promise<LockUserOutcome> {
  const updated = await tx
    .update(users)
    .set({ lockedAt: sql`now()`, lockReason: reason })
    .where(and(eq(users.id, userId), isNull(users.lockedAt)))
    .returning({ id: users.id });
  if (updated.length > 0) return { kind: 'locked' };
  const current = await tx
    .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
    .from(users)
    .where(eq(users.id, userId));
  const row = current[0];
  if (row === undefined) return { kind: 'not-found' };
  if (row.lockedAt === null || row.lockReason === null) {
    // The zero-row UPDATE saw the row locked, but the read-back (a newer
    // READ COMMITTED snapshot) sees it unlocked — a concurrent unlock landed
    // between the two statements, or an invariant broke. Either way the
    // throw fails closed: the transaction rolls back and the caller retries
    // against the settled state.
    throw new Error('lockUserWithinTx: row exists unlocked after a zero-row lock transition');
  }
  return { kind: 'already-locked', lockedAt: row.lockedAt, lockReason: row.lockReason };
}

/**
 * The general unlock on the caller's transaction. `SELECT … FOR UPDATE` (the
 * deletion-lock pattern) captures the prior reason under the row lock — the
 * undo-inverse snapshot the admin engine needs — then clears `locked_at` and
 * `lock_reason` together (the paired-null check constraint forbids clearing
 * one alone). The row lock serializes read-then-clear against concurrent
 * lock/unlock writers, so the returned prior reason is exactly what this
 * transaction cleared. Unlocking an unlocked or unknown user changes nothing.
 */
async function unlockUserTx(tx: SettlementTx, userId: string): Promise<UnlockUserOutcome> {
  const rows = await tx
    .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };
  if (row.lockedAt === null || row.lockReason === null) return { kind: 'not-locked' };
  await tx.update(users).set({ lockedAt: null, lockReason: null }).where(eq(users.id, userId));
  return { kind: 'unlocked', priorLockReason: row.lockReason };
}

async function consumeEmailVerificationTx(
  db: Database,
  token: string,
  now: Date
): Promise<ConsumeEmailVerificationOutcome> {
  return db.transaction(async (tx) => {
    // The DELETE is the single-use arbiter (never check-then-act): concurrent
    // consumers serialize on the token row, and every loser deletes 0 rows —
    // exactly one transaction can answer `verified`.
    const deleted = await tx
      .delete(verificationTokens)
      .where(
        and(
          eq(verificationTokens.token, token),
          eq(verificationTokens.purpose, 'email_verification'),
          gt(verificationTokens.expiresAt, now)
        )
      )
      .returning({ userId: verificationTokens.userId });
    const row = deleted[0];
    if (!row) return { kind: 'invalid' };
    await tx.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId));
    return { kind: 'verified', userId: row.userId };
  });
}

/**
 * Drizzle implementation of the identity stores. Single-writer: the identity
 * slice owns the `users` and `verification_tokens` tables; other slices read
 * them through their own published surfaces.
 */
export function createIdentityStores(db: Database): IdentityStores {
  function findOne(condition: SQL): ResultAsync<IdentityUserRecord | null, DomainError> {
    return fromPromise(
      db.select(RECORD_COLUMNS).from(users).where(condition).limit(1),
      storeFailure
    ).map((rows) => rows[0] ?? null);
  }

  return {
    users: {
      findByEmail: (email) => findOne(eq(users.email, email)),
      findByUsername: (username) => findOne(eq(users.username, username)),
      findById: (userId) => findOne(eq(users.id, userId)),
      insertRegisteredWithinTx: (tx, values) => insertRegisteredUserWithinTx(tx, values),
      insertAcquisitionWithinTx: async (tx, values: AcquisitionValues) => {
        await tx.insert(userAcquisition).values(values);
      },
      insertTermsAcceptanceWithinTx: async (tx, values) => {
        await tx.insert(termsAcceptances).values(values);
      },
      readAcquisitionSelfReport: (userId) =>
        fromPromise(
          db
            .select({
              channel: userAcquisition.selfReportedChannel,
              skipped: userAcquisition.selfReportSkipped,
            })
            .from(userAcquisition)
            .where(eq(userAcquisition.userId, userId))
            .limit(1),
          storeFailure
        ).map((rows): AcquisitionSelfReport | null => rows[0] ?? null),
      recordSelfReportedChannel: (input) =>
        fromPromise(recordSelfReportedChannelAtomic(db, input), storeFailure),
      // Monotonic in the WHERE clause: the pgEnum compares by declaration
      // order, so `<` is the "earlier context" test and a replayed first skip
      // finds nothing to move.
      recordSelfReportSkip: (input) =>
        fromPromise(
          db
            .update(userAcquisition)
            .set({ selfReportSkipped: input.context })
            .where(
              and(
                eq(userAcquisition.userId, input.userId),
                isNull(userAcquisition.selfReportedChannel),
                sql`(${userAcquisition.selfReportSkipped} is null or ${userAcquisition.selfReportSkipped} < ${input.context})`
              )
            ),
          storeFailure
        ).map((): void => undefined),
      enableTotp: (userId, encryptedSecret) =>
        fromPromise(enableTotpAtomic(db, userId, encryptedSecret), storeFailure),
      disableTotp: (userId) => fromPromise(disableTotpAtomic(db, userId), storeFailure),
      rotatePassword: (args) => fromPromise(rotatePasswordAtomic(db, args), storeFailure),
      readServerMaterialBatch: (afterId, limit) =>
        fromPromise(readServerMaterialBatch(db, afterId, limit), storeFailure),
      resealServerMaterial: (userId, observedBlob, newBlob, newFingerprint) =>
        fromPromise(
          resealServerMaterialAtomic(db, { userId, observedBlob, newBlob, newFingerprint }),
          storeFailure
        ),
      resealTotpSecret: (userId, observedBlob, newBlob) =>
        fromPromise(resealTotpSecretAtomic(db, { userId, observedBlob, newBlob }), storeFailure),
      liftStatementTimeoutWithinTx: async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = 0`);
      },
      lockForDeletionWithinTx: (tx, userId) => lockForDeletionTx(tx, userId),
      // Anonymous by design: the forensic event never references the user.
      insertDeletionEventWithinTx: async (tx, event) => {
        await tx.insert(accountDeletionEvents).values({
          deletedAt: event.deletedAt,
          ipAddress: event.ipAddress,
          userAgent: event.userAgent,
        });
      },
      deleteUserWithinTx: async (tx, userId) => {
        await tx.delete(users).where(eq(users.id, userId));
      },
      saveRecoveryKey: (userId, recoveryWrappedPrivateKey, recoveryPublicKey) =>
        fromPromise(
          db
            .update(users)
            .set({ recoveryWrappedPrivateKey, recoveryPublicKey, hasAcknowledgedPhrase: true })
            .where(eq(users.id, userId)),
          storeFailure
        ).map((): void => undefined),
      lockForChargebackWithinTx: (tx, userId) => lockForChargebackWithinTx(tx, userId),
      lockUserWithinTx: (tx, userId, reason) => lockUserTx(tx, userId, reason),
      unlockUserWithinTx: (tx, userId) => unlockUserTx(tx, userId),
      disableStrandedTotpWithinTx: (tx, currentFingerprint, keyIds) =>
        disableStrandedTotpTx(tx, currentFingerprint, keyIds),
      restoreStrandedTotpWithinTx: (tx, fingerprint, expectedCount) =>
        restoreStrandedTotpTx(tx, fingerprint, expectedCount),
      clearTotpWithinTx: (tx, userId) => clearTotpTx(tx, userId),
      restoreTotpWithinTx: (tx, userId) => restoreTotpTx(tx, userId),
    },
    verification: {
      issueEmailVerification: (userId, token, expiresAt) =>
        fromPromise(
          db
            .insert(verificationTokens)
            .values({ userId, token, purpose: 'email_verification', expiresAt }),
          storeFailure
        ).map((): void => undefined),
      issueVerificationDecoy: (token) =>
        // A DELETE against the fresh random token matches 0 rows by
        // construction — a single indexed write-path round-trip mirroring the
        // issue INSERT's cost without touching any state.
        fromPromise(
          db.delete(verificationTokens).where(eq(verificationTokens.token, token)),
          storeFailure
        ).map((): void => undefined),
      consumeEmailVerification: (token, now) =>
        fromPromise(consumeEmailVerificationTx(db, token, now), storeFailure),
      findUnverifiedByEmail: (email): ResultAsync<UnverifiedUser | null, DomainError> =>
        fromPromise(
          db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(and(eq(users.email, email), eq(users.emailVerified, false)))
            .limit(1),
          storeFailure
        ).map((rows) => rows[0] ?? null),
      findLatestVerificationToken: (email, now) =>
        fromPromise(
          db
            .select({ token: verificationTokens.token })
            .from(verificationTokens)
            .innerJoin(users, eq(verificationTokens.userId, users.id))
            .where(
              and(
                eq(users.email, email),
                eq(verificationTokens.purpose, 'email_verification'),
                gt(verificationTokens.expiresAt, now)
              )
            )
            .orderBy(desc(verificationTokens.createdAt))
            .limit(1),
          storeFailure
        ).map((rows) => rows[0]?.token ?? null),
    },
  };
}
