import { z } from 'zod';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, NanoUSD } from '@hushbox/shared';
import { fromPromise, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { readBalance } from '../../../billing/public/read-balance.js';
import { redisDel, redisSet, redisTtl } from '../../../../lib/redis/index.js';
import {
  deleteOwnedConversationsWithinTx,
  leaveAllMembershipsWithinTx,
  ownedConversationIdsWithinTx,
  revokeLinksCreatedByWithinTx,
} from '../../../conversations/public/account-deletion.js';
import { requireUser } from '../guards.js';
import { clear, consume } from '../../../../lib/rate-limit/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import { MAX_KE_ARRAY_LENGTH, opaqueByteArray } from '../opaque/opaque.js';
import { evictUserBestEffort } from '../session/session.js';
import {
  STEP_UP_GATES,
  consumeStepUp,
  startGuardedStepUp,
  verifyStepUp,
} from '../session/step-up.js';
import { verifyStoredTotp } from '../two-factor/totp.js';
import type { JobWakeCapable } from '../../../../lib/jobs/index.js';
import type { BillingStores } from '../../../billing/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  EvictUserPort,
  IdentityUsersStore,
} from '../../ports/index.js';
import type { IdentitySecrets, OpaqueFinishFlow } from '../opaque/opaque.js';
import type { RedisClient } from '../keys.js';
import type { StepUpPending, StepUpVerdict } from '../session/step-up.js';

export const deleteAccountInitBodySchema = z.object({
  ke1: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
});

export const deleteAccountFinishBodySchema = z.object({
  ke3: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  deleteAccountSessionId: z.uuid(),
  // The client types the confirmation phrase; compared trim + lowercase against
  // DELETE_ACCOUNT_CONFIRMATION_PHRASE (no Unicode normalization — homoglyphs
  // do not match). A second factor is required only when the account has TOTP.
  confirmationPhrase: z.string().max(200),
  totpCode: z
    .string()
    .length(6)
    .regex(/^\d{6}$/)
    .optional(),
  // The purchased balance the client showed the user as forfeited; absent means
  // nothing was shown, which acknowledges a zero forfeit.
  acknowledgedForfeitNanoUsd: NanoUSD.optional(),
});

export interface DeleteAccountInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek'>;
  readonly userId: string;
  readonly ke1: number[];
}

export type DeleteAccountInitOutcome =
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'server-material-unreadable' }
  | {
      readonly kind: 'started';
      readonly ke2: number[];
      readonly deleteAccountSessionId: string;
    };

/**
 * Round one of an account-deletion request: opens a step-up challenge, behind
 * deletion's own guessing gate.
 *
 * The gate is deletion's own rather than the shared one so that no other flow's
 * password fumble can arm the 24-hour freeze this one guards — but it is spent
 * HERE, at init, because that is where an OPAQUE guess is answered. The
 * finish-side counter below records failed deletion attempts; only this one
 * meters password guesses.
 */
export function startDeleteAccount(
  args: DeleteAccountInitArgs
): ResultAsync<DeleteAccountInitOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    return startGuardedStepUp({
      redis: args.redis,
      gate: STEP_UP_GATES.deleteAccount,
      ke1: args.ke1,
      userId: args.userId,
      opaqueRegistration: user.opaqueRegistration,
      opaqueServerMaterial: user.opaqueServerMaterial,
      opaqueKek: args.secrets.opaqueKek,
    }).map(
      (stepUp): DeleteAccountInitOutcome =>
        stepUp.kind === 'started'
          ? {
              kind: 'started',
              ke2: stepUp.ke2,
              deleteAccountSessionId: stepUp.stepUpSessionId,
            }
          : stepUp
    );
  });
}

export type DeleteAccountOutcome =
  | { readonly kind: 'no-step-up' }
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'bad-proof' }
  | { readonly kind: 'invalid-phrase' }
  | { readonly kind: 'totp-required' }
  | { readonly kind: 'invalid-totp' }
  | { readonly kind: 'totp-not-configured' }
  | { readonly kind: 'totp-stranded' }
  | { readonly kind: 'forfeit-unacknowledged'; readonly purchasedBalanceNanoUsd: bigint }
  | AccountDeletionResult;

/** The executor's own outcomes — the tail of the finish-flow union. */
export type AccountDeletionResult = { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/**
 * What the hard-deletion executor itself needs. The finish flow supplies the
 * step-up gates on top; `executeAccountDeletion` is exported for the executor
 * paths a route-level proof cannot reach (the vanished-user race, injected
 * transaction failures).
 */
export interface AccountDeletionArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  /** Capability-bearing so the media-reclaim enqueue leaves its wake behind. */
  readonly db: JobWakeCapable<Database>;
  /** Chat's purge helpers + the media-reclaim enqueue (composition-root bound). */
  readonly purge: AccountDeletionPurge;
  readonly accountDeletedEmail: AccountDeletedEmailPort;
  /** Realtime eviction fan-out, best-effort after the revocation watermark. */
  readonly evictUser?: EvictUserPort | undefined;
  readonly userId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

export interface DeleteAccountFinishArgs extends AccountDeletionArgs {
  readonly secrets: Pick<IdentitySecrets, 'totpEncryptionSecret'>;
  readonly ke3: number[];
  readonly deleteAccountSessionId: string;
  readonly confirmationPhrase: string;
  readonly totpCode: string | undefined;
  /** Billing's stores, for the purchased-balance read behind the forfeit gate. */
  readonly billingStores: BillingStores;
  readonly acknowledgedForfeitNanoUsd: bigint | undefined;
}

/**
 * Round two: a step-up finish gated by the deletion lockout. Consuming the
 * handshake is the first-delivery claim; a bad proof advances the tight 1-hour
 * guessing gate (3 attempts), and exhausting that gate engages the separate
 * 24-hour hard lock — so a fumbled short sequence never freezes deletion for a
 * full day, but sustained failure does. A verified proof EXECUTES the hard
 * deletion synchronously and clears both. The gates answer in this order: the
 * hard lock, the purchased-balance forfeit (reached only by a verified proof),
 * the confirmation phrase, a guessing-gate attempt, the proof's verdict, and —
 * when the account has TOTP — a second factor; then the deletion runs.
 */
export function createDeleteAccountFinishFlow(
  args: DeleteAccountFinishArgs
): OpaqueFinishFlow<DeleteAccountOutcome> {
  let pending: StepUpPending | null = null;
  return {
    claim: () =>
      consumeStepUp(
        args.redis,
        STEP_UP_GATES.deleteAccount.definition,
        args.deleteAccountSessionId
      ).map((state) => {
        pending = state;
        return state !== null;
      }),
    execute: () => executeDelete(args, pending),
    onDuplicate: () => okAsync<DeleteAccountOutcome, DomainError>({ kind: 'no-step-up' }),
  };
}

function executeDelete(
  args: DeleteAccountFinishArgs,
  pending: StepUpPending | null
): ResultAsync<DeleteAccountOutcome, DomainError> {
  if (pending === null) {
    throw new Error('identity: delete-account finish executed without a claimed handshake');
  }
  // The 24-hour hard lock is a read-only gate checked before anything else:
  // once repeated failure has engaged it, deletion is frozen for the rest of
  // the day and no attempt (right phrase or not) proceeds. Reading it burns
  // nothing.
  return checkDeleteAccountHardLock(args.redis, args.userId).andThen((hardLock) => {
    if (hardLock !== null) {
      return okAsync<DeleteAccountOutcome, DomainError>({
        kind: 'locked',
        retryAfterSeconds: hardLock,
      });
    }
    // The proof is read before either gate below, because a proven password is
    // what clears the init-side guessing counter — and it must clear on the
    // wrong-phrase path too, where the password was right and only the typing
    // was wrong. Reading a verdict changes nothing; it decides only whether the
    // forfeit gate runs, which a verified proof reaches ahead of the phrase gate.
    const verdict = verifyStepUp(pending, args.userId, args.ke3);
    return clearInitGateOnProof(args, verdict).andThen(() =>
      verdict === 'ok' ? gateForfeitThenResolve(args, verdict) : gateThenResolve(args, verdict)
    );
  });
}

/**
 * Refuses a deletion whose current purchased balance exceeds the forfeit the
 * request acknowledged, so credit that landed after the client read the balance
 * is never lost unseen. It runs only behind a verified proof, which keeps the
 * balance from anyone who has not proved the password, and ahead of the phrase,
 * attempt and TOTP gates, so a refusal the user did not cause spends no deletion
 * attempt and consumes no TOTP code.
 */
function gateForfeitThenResolve(
  args: DeleteAccountFinishArgs,
  verdict: StepUpVerdict
): ResultAsync<DeleteAccountOutcome, DomainError> {
  return readBalance(args.billingStores, args.db, args.userId, args.now).andThen(
    ({ purchasedNanoUsd }) =>
      purchasedNanoUsd > (args.acknowledgedForfeitNanoUsd ?? 0n)
        ? okAsync<DeleteAccountOutcome, DomainError>({
            kind: 'forfeit-unacknowledged',
            purchasedBalanceNanoUsd: purchasedNanoUsd,
          })
        : gateThenResolve(args, verdict)
  );
}

/**
 * Refunds the init-side guess once the password is proven, and only then: junk
 * KE3 bytes prove nothing, so a bad proof leaves the attempt charged whatever
 * else the request carried.
 */
function clearInitGateOnProof(
  args: DeleteAccountFinishArgs,
  verdict: StepUpVerdict
): ResultAsync<void, DomainError> {
  return verdict === 'ok'
    ? clear(args.redis, STEP_UP_GATES.deleteAccount.lockout, args.userId)
    : okAsync();
}

/** The deletion gates in their shipped order: phrase, then attempt, then proof. */
function gateThenResolve(
  args: DeleteAccountFinishArgs,
  verdict: StepUpVerdict
): ResultAsync<DeleteAccountOutcome, DomainError> {
  // The confirmation phrase is a cheap, server-state-free gate that runs
  // BEFORE the guessing-gate reservation, so a wrong phrase never burns a
  // deletion attempt. (The byEventId claim already consumed the step-up
  // handshake, so a wrong phrase costs the client a fresh init — a deliberate
  // consequence of the claim-is-consume model, not a lockout charge.)
  if (args.confirmationPhrase.trim().toLowerCase() !== DELETE_ACCOUNT_CONFIRMATION_PHRASE) {
    return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'invalid-phrase' });
  }
  // Spend one attempt on the tight 1-hour guessing gate before acting on the
  // step-up verdict: the atomic increment is the gate and the failure record at
  // once (a success clears the counter). Exhausting the gate — 3 failures inside
  // the hour — engages the separate 24-hour hard lock, so a short fumble never
  // freezes deletion for a full day but sustained abuse does.
  return consume(args.redis, IDENTITY_KEYS.deleteAccountLockout, args.userId).andThen(
    (decision) => {
      if (!decision.allowed) {
        return engageDeleteAccountHardLock(args.redis, args.userId).map(
          (): DeleteAccountOutcome => ({
            kind: 'locked',
            retryAfterSeconds: IDENTITY_KEYS.deleteAccountHardLock.ttlSeconds,
          })
        );
      }
      return resolveVerdict(args, verdict);
    }
  );
}

/**
 * Reads the 24-hour hard lock's remaining lifetime: the retry-after seconds
 * when engaged, or null when it stands clear. The TTL is the freeze duration,
 * so the key's mere presence is the lock (`redisTtl` returns null for a missing
 * or non-expiring key, and the lock is always written with an expiry).
 */
function checkDeleteAccountHardLock(
  redis: RedisClient,
  userId: string
): ResultAsync<number | null, DomainError> {
  return redisTtl(redis, IDENTITY_KEYS.deleteAccountHardLock, userId);
}

/** Engages the 24-hour hard lock (called when the 1-hour guessing gate trips). */
function engageDeleteAccountHardLock(
  redis: RedisClient,
  userId: string
): ResultAsync<void, DomainError> {
  return redisSet(redis, IDENTITY_KEYS.deleteAccountHardLock, 1, userId);
}

function resolveVerdict(
  args: DeleteAccountFinishArgs,
  verdict: StepUpVerdict
): ResultAsync<DeleteAccountOutcome, DomainError> {
  if (verdict === 'session-mismatch') {
    return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'no-step-up' });
  }
  if (verdict === 'bad-proof') {
    return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'bad-proof' });
  }
  return gateTotpThenExecute(args);
}

/**
 * After a verified password proof, require a valid TOTP code when the account
 * has 2FA — reusing the shared stored-TOTP verifier (its own lockout + replay
 * protection). A TOTP-less account skips straight to the executor.
 */
function gateTotpThenExecute(
  args: DeleteAccountFinishArgs
): ResultAsync<DeleteAccountOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    if (!user.totpEnabled) return executeAndClear(args);
    if (args.totpCode === undefined) {
      return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'totp-required' });
    }
    return verifyStoredTotp({
      redis: args.redis,
      encryptedSecret: user.totpSecretEncrypted,
      secrets: args.secrets,
      userId: args.userId,
      code: args.totpCode,
      now: args.now,
    }).andThen((verdict) => {
      if (verdict.kind === 'ok') return executeAndClear(args);
      if (verdict.kind === 'locked') {
        return okAsync<DeleteAccountOutcome, DomainError>({
          kind: 'locked',
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
      }
      if (verdict.kind === 'not-configured') {
        return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'totp-not-configured' });
      }
      if (verdict.kind === 'stranded') {
        return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'totp-stranded' });
      }
      return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'invalid-totp' });
    });
  });
}

/**
 * Runs the executor and, once the delete committed, clears BOTH deletion
 * mechanisms — the 1-hour guessing gate and the 24-hour hard lock — so a
 * re-registered account never inherits a stale freeze.
 *
 * Neither clear can fail the outcome, because the transaction has already
 * committed: an error here would tell a caller its account survived when the
 * row is gone, and no retry can undo a hard deletion. `clear` absorbs its own
 * failures; the hard lock's delete is a general-purpose helper whose other
 * callers need their errors, so it is absorbed at this one call site instead.
 * Both fail safe — an undeleted lock expires on its own 24-hour TTL, and the
 * only account it could freeze no longer exists. The two differ in cost, not
 * in outcome: only the `clear` is bounded, so the hard lock's delete carries the
 * Redis client's whole retry schedule and a dying endpoint still holds a
 * committed deletion's response for seconds.
 */
function executeAndClear(
  args: DeleteAccountFinishArgs
): ResultAsync<DeleteAccountOutcome, DomainError> {
  return executeAccountDeletion(args).andThen((outcome) =>
    outcome.kind === 'deleted'
      ? clear(args.redis, IDENTITY_KEYS.deleteAccountLockout, args.userId)
          .andThen(() => redisDel(args.redis, IDENTITY_KEYS.deleteAccountHardLock, args.userId))
          .orElse((): ResultAsync<void, DomainError> => okAsync())
          .map((): DeleteAccountOutcome => outcome)
      : okAsync<DeleteAccountOutcome, DomainError>(outcome)
  );
}

/**
 * The hard-deletion executor: ONE transaction deletes the account (legacy
 * ordering preserved), then the post-commit tail revokes sessions and sends
 * the confirmation. Synchronous with the request, like legacy — the response
 * is only sent after the account is gone.
 */
export function executeAccountDeletion(
  args: AccountDeletionArgs
): ResultAsync<AccountDeletionResult, DomainError> {
  return fromPromise(runDeletionTransaction(args), (cause) =>
    unavailableError('account deletion transaction failed', cause)
  ).andThen((capture) =>
    capture === null
      ? okAsync<AccountDeletionResult, DomainError>({ kind: 'not-found' })
      : revokeAndNotify(args, capture.email).map(
          (): AccountDeletionResult => ({
            kind: 'deleted',
          })
        )
  );
}

/**
 * Ordering invariants enforced inside the transaction (legacy parity):
 *   1. Lock the users row FOR UPDATE and capture the email BEFORE the cascade
 *      destroys it (racing finishes serialize here — the loser sees null).
 *   2. Capture owned-conversation ids + their content storage keys BEFORE the
 *      users delete cascades the rows away; the reclaim job's payload is the
 *      only surviving map from account to R2 ciphertext.
 *   3. Stamp conversation_members.leftAt BEFORE deleting users so the FK's
 *      userId-SET-NULL leaves rows satisfying the userId/linkId/leftAt check,
 *      then revoke the shared links this account minted — also before the users
 *      delete, whose FK nulls shared_links.createdBy and leaves them unfindable.
 *   4. In NON-owned conversations, capture the storage keys of the account's
 *      messages' content items, delete those items, and stamp the messages'
 *      deletedAt — the rows stay. This selects by sender, so it runs before
 *      step 5 removes the sender id.
 *   5. Null messages.senderId in NON-owned conversations (senderId has no FK
 *      by design, so nothing else would clear it); owned ones die in step 6.
 *   6. Delete the owned conversations explicitly (see
 *      deleteOwnedConversationsWithinTx for why the users cascade alone
 *      aborts against membership rows this transaction rewrote).
 *   7. Insert the ANONYMOUS deletion event, then delete the users row.
 *   8. Enqueue media.reclaimUser.v1 with the owned and foreign keys captured
 *      in steps 2 and 4, each once — atomic with the delete (Pattern C);
 *      skipped when neither step captured a key.
 * A throw anywhere rolls the whole thing back: no partial deletion exists.
 *
 * Before all of them the transaction lifts the request path's statement bound
 * for itself: the owned-conversation cascade grows with the account, and a
 * bound it outgrew would cancel the deletion on every retry.
 */
async function runDeletionTransaction(
  args: AccountDeletionArgs
): Promise<{ email: string } | null> {
  return runSettlement(args.db, async (tx) => {
    await args.store.liftStatementTimeoutWithinTx(tx);
    const locked = await args.store.lockForDeletionWithinTx(tx, args.userId);
    if (locked === null) return null;
    const ownedIds = await ownedConversationIdsWithinTx(tx, args.userId);
    const ownedKeys = await args.purge.captureContentStorageKeysWithinTx(tx, ownedIds);
    await leaveAllMembershipsWithinTx(tx, args.userId, args.now);
    await revokeLinksCreatedByWithinTx(tx, args.userId, args.now);
    const foreignKeys = await args.purge.deleteForeignMessageContentWithinTx(
      tx,
      args.userId,
      ownedIds,
      args.now
    );
    await args.purge.detachMessageSendersWithinTx(tx, args.userId, ownedIds);
    await deleteOwnedConversationsWithinTx(tx, args.userId);
    await args.store.insertDeletionEventWithinTx(tx, {
      deletedAt: args.now,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    });
    await args.store.deleteUserWithinTx(tx, args.userId);
    // Disjoint by construction: storage keys are unique per content item, and
    // the two captures select messages from disjoint conversation sets.
    const storageKeys = [...ownedKeys, ...foreignKeys];
    if (storageKeys.length > 0) {
      await args.purge.enqueueMediaReclaimWithinTx(tx, { userId: args.userId, storageKeys });
    }
    return { email: locked.email };
  });
}

/**
 * The post-commit tail, legacy order (notify before cleanup) adapted to the
 * new architecture: the pw-changed watermark stales every session issued
 * before now, the realtime fan-out closes live sockets, then the confirmation
 * email goes out. A watermark failure PROPAGATES even though the delete
 * already committed — session revocation must never silently lag a deletion
 * (the credentials rotation carries the same tradeoff); only the eviction and
 * the email are best-effort.
 */
function revokeAndNotify(args: AccountDeletionArgs, email: string): ResultAsync<void, DomainError> {
  return redisSet(args.redis, IDENTITY_KEYS.passwordChangedAt, args.now.getTime(), args.userId)
    .andThen(() => evictUserBestEffort(args.evictUser, args.userId))
    .andThen(() =>
      args.accountDeletedEmail.sendAccountDeletedEmail({ to: email }).orElse(() => okAsync())
    );
}
