import type { AcquisitionPlatform, GrowthChannel, GrowthSelfReportContext } from '@hushbox/shared';
import type { Database, userLockReasonEnum } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** A user row resolved to what the auth flows need. */
export interface IdentityUserRecord {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly opaqueRegistration: Uint8Array;
  /** This user's OPAQUE server material, sealed under the KEK; the blob's head is the KEK fingerprint. */
  readonly opaqueServerMaterial: Uint8Array;
  /** Fingerprint of the KEK that sealed the material — non-secret. */
  readonly opaqueKekFingerprint: Uint8Array;
  /** The X25519 account public key clients wrap content to. */
  readonly publicKey: Uint8Array;
  readonly passwordWrappedPrivateKey: Uint8Array;
  readonly recoveryWrappedPrivateKey: Uint8Array;
  /** The X25519 public half of the recovery phrase's keypair — the recipient a reset challenge is sealed to. */
  readonly recoveryPublicKey: Uint8Array;
  /** Null until TOTP enrollment is confirmed. */
  readonly totpSecretEncrypted: Uint8Array | null;
  readonly totpEnabled: boolean;
  readonly lockedAt: Date | null;
  /** False until the email-verification token is consumed; gates login. */
  readonly emailVerified: boolean;
  /** True once the user has saved their recovery phrase (one-shot flag). */
  readonly hasAcknowledgedPhrase: boolean;
}

export interface RegistrationValues {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly opaqueRegistration: Uint8Array;
  readonly opaqueServerMaterial: Uint8Array;
  readonly opaqueKekFingerprint: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly passwordWrappedPrivateKey: Uint8Array;
  readonly recoveryWrappedPrivateKey: Uint8Array;
  readonly recoveryPublicKey: Uint8Array;
}

/**
 * Where one account came from, as registration stamps it. `campaign` is
 * already resolved against the active tags, so the value the FK sees names a
 * campaign row that exists.
 */
export interface AcquisitionValues {
  readonly userId: string;
  readonly campaign: string;
  readonly platform: AcquisitionPlatform;
}

/**
 * The self-report half of one account's acquisition row — the only part the
 * due-prompt predicate reads. The campaign and platform are deliberately
 * absent: what the person said and what the software recorded are different
 * facts, and no read that decides which question to ask needs the second one.
 */
export interface AcquisitionSelfReport {
  /** Null until the question is answered; an answer is never overwritten. */
  readonly channel: GrowthChannel | null;
  /** The last context skipped, ordered in time: `first_payment` means both were. */
  readonly skipped: GrowthSelfReportContext | null;
}

/**
 * What one answer found. `already-answered` is the idempotent no-op a second
 * answer converges on, and `no-account-row` is an account carrying no
 * acquisition row at all — nothing to answer against, never an error.
 */
export type RecordSelfReportOutcome = 'recorded' | 'already-answered' | 'no-account-row';

/**
 * The two discriminable unique violations surface as values (the signup UI
 * renders them); any other failure is the error channel.
 */
export type InsertRegisteredOutcome =
  | { readonly kind: 'created'; readonly userId: string }
  | { readonly kind: 'email-taken' }
  | { readonly kind: 'username-taken' };

/** Why a user account is locked — derived from the `user_lock_reason` pgEnum. */
export type UserLockReason = (typeof userLockReasonEnum.enumValues)[number];

/**
 * Outcome of the general lock transition. `already-locked` reports the
 * standing lock (original reason + timestamp) so a caller can surface or
 * snapshot it — the row is never re-written, preserving the first lock's
 * reason and time (already-done is a no-op).
 */
export type LockUserOutcome =
  | { readonly kind: 'locked' }
  | {
      readonly kind: 'already-locked';
      readonly lockedAt: Date;
      readonly lockReason: UserLockReason;
    }
  | { readonly kind: 'not-found' };

/**
 * Outcome of the general unlock transition. `unlocked` carries the prior
 * reason — the admin engine snapshots it as the undo inverse's input, so a
 * chargeback lock undone-and-redone restores `chargeback`, never a default.
 */
export type UnlockUserOutcome =
  | { readonly kind: 'unlocked'; readonly priorLockReason: UserLockReason }
  | { readonly kind: 'not-locked' }
  | { readonly kind: 'not-found' };

/**
 * A credential rotation's inputs. `observedRegistration` is the record the
 * flow read at its init round: the UPDATE is a compare-and-swap on it, so a
 * rotation racing another (two devices, or a change racing a recovery reset)
 * cannot silently overwrite a record the client never saw.
 */
export interface RotatePasswordArgs {
  readonly userId: string;
  readonly observedRegistration: Uint8Array;
  readonly opaqueRegistration: Uint8Array;
  readonly passwordWrappedPrivateKey: Uint8Array;
  readonly opaqueServerMaterial: Uint8Array;
  readonly opaqueKekFingerprint: Uint8Array;
}

/** `conflict`: the stored record was no longer the observed one; nothing was written. */
export type RotatePasswordOutcome = 'rotated' | 'conflict';

/** One user's sealed material as the re-seal job reads it. */
export interface ServerMaterialRow {
  readonly id: string;
  readonly opaqueServerMaterial: Uint8Array;
  readonly opaqueKekFingerprint: Uint8Array;
  /**
   * The sealed TOTP secret, null for an account with no second factor. It
   * rides this row because the re-seal job walks the table once and re-keys
   * both blobs of a row together; its own key id is inside the blob.
   */
  readonly totpSecretEncrypted: Uint8Array | null;
  /**
   * Whether the second factor is live. The re-seal job reads it to tell an
   * operator condition from the cleared state: a blob it cannot open aborts the
   * run while the factor is enabled, and is left alone once it is cleared.
   */
  readonly totpEnabled: boolean;
}

/** `already-done`: the stored blob was no longer the observed one (another pass re-sealed it). */
export type ResealServerMaterialOutcome = 'resealed' | 'already-done';

/** Outcome of an atomic conditional TOTP-enable transition. */
export type EnableTotpOutcome = 'enabled' | 'already-enabled';
/** Outcome of an atomic conditional TOTP-disable transition. */
export type DisableTotpOutcome = 'disabled' | 'not-enabled';

/**
 * One stale TOTP key id and how many rows a bulk clear disabled under it —
 * the whole record the bulk inverse needs (fingerprint + count, never user
 * ids). The fingerprint is the blob's leading key-id bytes, non-secret by
 * construction.
 */
export interface StrandedTotpGroup {
  readonly fingerprint: Uint8Array;
  readonly count: number;
}

/** `count-mismatch`: the cleared rows under the fingerprint were not exactly `expectedCount`; nothing was written. */
export type RestoreStrandedTotpOutcome = 'restored' | 'count-mismatch';

/** `cleared` carries the row's key id so the caller can record `{ fingerprint, count: 1 }` for the shared inverse. */
export type ClearTotpOutcome =
  | { readonly kind: 'cleared'; readonly fingerprint: Uint8Array }
  | { readonly kind: 'not-enabled' }
  | { readonly kind: 'not-found' };

/** `not-cleared`: the row exists but is not in the cleared state (enabled, or user-disabled with a null ciphertext). */
export type RestoreTotpOutcome = 'restored' | 'not-cleared' | 'not-found';

export interface IdentityUsersStore {
  /** Lookup by already-lowercased email. */
  findByEmail(email: string): ResultAsync<IdentityUserRecord | null, DomainError>;
  /** Lookup by already-normalized username. */
  findByUsername(username: string): ResultAsync<IdentityUserRecord | null, DomainError>;
  findById(userId: string): ResultAsync<IdentityUserRecord | null, DomainError>;
  /**
   * The registration INSERT composed INSIDE a settlement transaction, so the
   * new user row and its wallets + welcome credit commit atomically (a crash
   * leaves neither). Uses `ON CONFLICT DO NOTHING` — never a throwing insert —
   * so a racing duplicate resolves to `email-taken` / `username-taken` as a
   * value without poisoning the transaction; the caller rolls back by simply
   * not provisioning when the outcome is not `created`. Inserts unverified.
   */
  insertRegisteredWithinTx(
    tx: SettlementTx,
    values: RegistrationValues
  ): Promise<InsertRegisteredOutcome>;
  /**
   * The acquisition stamp, composed INSIDE the registration settlement
   * transaction so the account and where it came from commit together: a
   * registration that rolls back leaves no orphan source row, and one that
   * commits is never missing its own.
   */
  insertAcquisitionWithinTx(tx: SettlementTx, values: AcquisitionValues): Promise<void>;
  /**
   * The Terms acceptance, composed INSIDE the registration settlement
   * transaction so an account never commits without the record of the Terms
   * revision it accepted.
   */
  insertTermsAcceptanceWithinTx(
    tx: SettlementTx,
    values: { userId: string; revision: number }
  ): Promise<void>;
  /** This account's self-report state, or null when it carries no acquisition row. */
  readAcquisitionSelfReport(userId: string): ResultAsync<AcquisitionSelfReport | null, DomainError>;
  /**
   * First answer wins, as one conditional UPDATE guarded on the channel still
   * being null — never check-then-act. Zero rows affected is read back rather
   * than assumed: an account with no acquisition row and one that already
   * answered are different states and only a read tells them apart.
   */
  recordSelfReportedChannel(input: {
    readonly userId: string;
    readonly channel: GrowthChannel;
    readonly context: GrowthSelfReportContext;
    readonly at: Date;
  }): ResultAsync<RecordSelfReportOutcome, DomainError>;
  /**
   * The monotonic skip: it moves forward through the ordered contexts and
   * never back, so a stale tab replaying the first skip cannot undo the
   * second, and it refuses once the question has been answered.
   */
  recordSelfReportSkip(input: {
    readonly userId: string;
    readonly context: GrowthSelfReportContext;
  }): ResultAsync<void, DomainError>;
  /**
   * Atomic conditional enable (`… WHERE totp_enabled = false`): 0 rows means
   * TOTP was already enabled — never check-then-act.
   */
  enableTotp(
    userId: string,
    encryptedSecret: Uint8Array
  ): ResultAsync<EnableTotpOutcome, DomainError>;
  /** Atomic conditional disable (`… WHERE totp_enabled = true`). */
  disableTotp(userId: string): ResultAsync<DisableTotpOutcome, DomainError>;
  /**
   * Rewrites the OPAQUE record, the password-wrapped key and the sealed server
   * material in one UPDATE, guarded by `opaque_registration = observed` —
   * never check-then-act. Zero rows is `conflict`, which the caller surfaces
   * as a typed refusal: the losing client has already persisted an export key
   * that no longer opens the stored wrap, so a silent success would strand it.
   */
  rotatePassword(args: RotatePasswordArgs): ResultAsync<RotatePasswordOutcome, DomainError>;
  /**
   * The re-seal job's read: material rows in id order, keyset-paged after
   * `afterId` (null starts from the first row), at most `limit` rows.
   */
  readServerMaterialBatch(
    afterId: string | null,
    limit: number
  ): ResultAsync<readonly ServerMaterialRow[], DomainError>;
  /**
   * The re-seal job's write: a compare-and-swap on the observed blob, so a
   * row another pass already re-sealed is `already-done` rather than
   * overwritten with a blob opened from stale bytes.
   */
  resealServerMaterial(
    userId: string,
    observedBlob: Uint8Array,
    newBlob: Uint8Array,
    newFingerprint: Uint8Array
  ): ResultAsync<ResealServerMaterialOutcome, DomainError>;
  /**
   * The re-seal job's TOTP write, the twin of {@link IdentityUsersStore.resealServerMaterial}:
   * a compare-and-swap on the observed blob, leaving `totp_enabled` untouched.
   * The key id lives inside the blob, so no separate fingerprint column moves
   * with it.
   */
  resealTotpSecret(
    userId: string,
    observedBlob: Uint8Array,
    newBlob: Uint8Array
  ): ResultAsync<ResealServerMaterialOutcome, DomainError>;
  /**
   * Lifts the statement bound the request path's sessions start with, for the
   * rest of the caller's transaction only (`SET LOCAL statement_timeout = 0`):
   * the bound returns at commit or rollback. Throws on infra failure.
   */
  liftStatementTimeoutWithinTx(tx: SettlementTx): Promise<void>;
  /**
   * The deletion executor's opening lock: `SELECT email … FOR UPDATE` on the
   * users row. Serializes racing finishes (the loser sees null once the
   * winner's delete commits) and captures the email before the cascade
   * destroys it. Throws on infra failure — inside the deletion transaction a
   * throw aborts the whole commit.
   */
  lockForDeletionWithinTx(
    tx: SettlementTx,
    userId: string
  ): Promise<{ readonly email: string } | null>;
  /**
   * The anonymous forensic deletion event (deletedAt/ipAddress/userAgent —
   * deliberately no user reference), committed with the delete it records.
   */
  insertDeletionEventWithinTx(
    tx: SettlementTx,
    event: {
      readonly deletedAt: Date;
      readonly ipAddress: string | null;
      readonly userAgent: string | null;
    }
  ): Promise<void>;
  /** The hard delete; the FK graph cascades/pseudonymizes everything else. */
  deleteUserWithinTx(tx: SettlementTx, userId: string): Promise<void>;
  /**
   * Persists a client-rewrapped recovery key and flags phrase acknowledgement
   * in one convergent UPDATE — repeats reach the same end state (idempotent).
   * The public half rides the same UPDATE: it is the key the reset challenge
   * is sealed to, so a blob stored against a different phrase's public key
   * would leave the account permanently unable to reset.
   */
  saveRecoveryKey(
    userId: string,
    recoveryWrappedPrivateKey: Uint8Array,
    recoveryPublicKey: Uint8Array
  ): ResultAsync<void, DomainError>;
  /**
   * The chargeback auto-defense lock, composed INSIDE the webhook's clawback
   * settlement transaction so the ledger clawback and the lock commit
   * atomically — a lock failure rolls the clawback back, and the provider's
   * redelivery re-drives both together (no money-reversed-but-not-locked
   * divergence). An atomic conditional
   * `UPDATE users SET locked_at = now(), lock_reason = 'chargeback'
   * WHERE id = ? AND locked_at IS NULL RETURNING email, username` on the
   * caller's `tx`. Never check-then-act — the `locked_at IS NULL` predicate is
   * the guard, so exactly the first delivery transitions: `locked` is true (with
   * the captured email and username) only for that delivery, and false with both
   * null when the account was already locked or the id is unknown (they ride the
   * transition only, since the best-effort lock notification fires only on a
   * fresh lock).
   * `locked_at` and `lock_reason` are set together to satisfy the users-table
   * check constraint tying their nullness. Throws on infra failure — inside the
   * settlement transaction a throw aborts the whole commit.
   */
  lockForChargebackWithinTx(
    tx: SettlementTx,
    userId: string
  ): Promise<{
    readonly locked: boolean;
    readonly email: string | null;
    readonly userName: string | null;
  }>;
  /**
   * The general reason-parameterized lock, composed inside the caller's
   * transaction (the admin slice's operations engine is the intended composer
   * — `users` is identity's table, single-writer). An atomic conditional
   * `UPDATE … WHERE id = ? AND locked_at IS NULL` (never check-then-act);
   * `locked_at` and `lock_reason` are written together to satisfy the
   * users-table paired-null check constraint. On 0 rows the actual state is
   * read back to disambiguate `already-locked` (the standing lock is reported,
   * never clobbered) from `not-found`. Throws on infra failure — inside the
   * settlement transaction a throw aborts the whole commit.
   */
  lockUserWithinTx(
    tx: SettlementTx,
    userId: string,
    reason: UserLockReason
  ): Promise<LockUserOutcome>;
  /**
   * The general unlock, composed inside the caller's transaction. Takes the
   * row lock (`SELECT … FOR UPDATE`, the deletion-lock pattern) to read the
   * prior reason, then clears `locked_at` and `lock_reason` together (the
   * paired-null check constraint forbids clearing one alone) — the row lock
   * makes read-then-clear atomic against concurrent lock/unlock writers.
   * Returns the prior reason on a fresh unlock (the undo-inverse snapshot);
   * `not-locked` / `not-found` are idempotent no-ops. Throws on infra failure.
   */
  unlockUserWithinTx(tx: SettlementTx, userId: string): Promise<UnlockUserOutcome>;
  /**
   * The bulk clear of second factors stranded under a retired TOTP key,
   * composed inside the caller's transaction (the admin operations engine is
   * the composer; `users` is identity's table, single-writer). One UPDATE
   * flips `totp_enabled` off on every enabled row whose blob's key id is not
   * `currentFingerprint`, RETURNING each row's key id; the ciphertext is
   * retained, which is what distinguishes the cleared state
   * (`totp_enabled = false AND totp_secret_encrypted IS NOT NULL`) from a
   * user's own disable (which nulls the ciphertext). Returns one group per
   * stale key id touched — a clear can span several retired keys, and the
   * inverse restores per key id. Throws on infra failure.
   *
   * `keyIds` narrows the act to the retired keys it names, leaving every other
   * retired key's rows enabled; absent, the sweep reaches every retired key.
   * It only ever narrows — the staleness predicate stands beside it, so a
   * scope naming the live key still reaches nothing. A supplied list is
   * non-empty (the admin contract bounds it both ways), so absence is the only
   * way to ask for the sweep.
   */
  disableStrandedTotpWithinTx(
    tx: SettlementTx,
    currentFingerprint: Uint8Array,
    keyIds?: readonly Uint8Array[]
  ): Promise<readonly StrandedTotpGroup[]>;
  /**
   * The bulk inverse: re-enables the cleared rows under `fingerprint`, but
   * only when exactly `expectedCount` such rows exist — one conditional UPDATE
   * whose predicate carries the count (never check-then-act), so a group
   * recorded by one audited clear can never over-restore rows a different
   * clear touched. `expectedCount` is a recorded group's count, so it is
   * never zero. Throws on infra failure.
   */
  restoreStrandedTotpWithinTx(
    tx: SettlementTx,
    fingerprint: Uint8Array,
    expectedCount: number
  ): Promise<RestoreStrandedTotpOutcome>;
  /**
   * The per-user clear on the caller's transaction: an atomic conditional
   * UPDATE guarded by `totp_enabled = true AND totp_secret_encrypted IS NOT
   * NULL`, retaining the ciphertext and RETURNING the blob's key id. On 0 rows
   * the row's existence is read back to disambiguate `not-enabled` from
   * `not-found`. Throws on infra failure.
   */
  clearTotpWithinTx(tx: SettlementTx, userId: string): Promise<ClearTotpOutcome>;
  /**
   * The per-user inverse: one conditional UPDATE guarded by the cleared state
   * (`totp_enabled = false AND totp_secret_encrypted IS NOT NULL`). On 0 rows
   * the row's existence is read back to disambiguate `not-cleared` from
   * `not-found`. Throws on infra failure.
   */
  restoreTotpWithinTx(tx: SettlementTx, userId: string): Promise<RestoreTotpOutcome>;
}

/** Result of consuming an email-verification token. */
export type ConsumeEmailVerificationOutcome =
  | { readonly kind: 'verified'; readonly userId: string }
  | { readonly kind: 'invalid' };

/** The unverified account a resend targets. */
export interface UnverifiedUser {
  readonly id: string;
  readonly username: string;
}

export interface IdentityVerificationStore {
  /** Inserts a fresh single-use email-verification token. */
  issueEmailVerification(
    userId: string,
    token: string,
    expiresAt: Date
  ): ResultAsync<void, DomainError>;
  /**
   * Enumeration decoy: one write-shaped database round-trip of comparable
   * cost to `issueEmailVerification` that changes nothing. The resend flow
   * runs it for an unknown (or already-verified) email so its timing mirrors
   * the known-unverified path instead of returning early.
   */
  issueVerificationDecoy(token: string): ResultAsync<void, DomainError>;
  /**
   * Consumes a token and flips `emailVerified` in ONE transaction: an unexpired
   * `email_verification` token deletes itself and verifies its user; a missing
   * or expired token is `invalid`. Single-use — a replay finds nothing.
   */
  consumeEmailVerification(
    token: string,
    now: Date
  ): ResultAsync<ConsumeEmailVerificationOutcome, DomainError>;
  /** The unverified account for an email, or null (verified or unknown). */
  findUnverifiedByEmail(email: string): ResultAsync<UnverifiedUser | null, DomainError>;
  /**
   * DEV-ONLY: the newest live email-verification token for an email, so a
   * local signup can be completed without a real inbox. Never reachable in
   * production (the route's `dev-only` class 404s there).
   */
  findLatestVerificationToken(email: string, now: Date): ResultAsync<string | null, DomainError>;
}

export interface IdentityStores {
  readonly users: IdentityUsersStore;
  readonly verification: IdentityVerificationStore;
}

/** Stores are constructed per request from the pipeline's `c.var.db`. */
export type IdentityStoresFactory = (db: Database) => IdentityStores;
