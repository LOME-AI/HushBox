import { match } from 'ts-pattern';
import { SERVICE_NAMES, recordServiceEvidence } from '@hushbox/db';
import { unavailableError } from '../../../../lib/errors/index.js';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { SESSION_REVOKE_JOB_TYPE, enqueueWithinTx } from '../../../../lib/jobs/index.js';
import { fromPromise, okAsync } from '../../../../lib/result/index.js';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import { postPaymentAdjustmentWithinTx } from './payment-ledger.js';
import { CARD_DECLINED_ERROR_CODE, creditPaymentWithinTx } from './payments.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { SettlementTx } from '../../../../lib/idempotency/index.js';
import type { EnqueueJobResult, JobRegistry, JobWakeCapable } from '../../../../lib/jobs/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  AccountDefensePort,
  ChargebackLockEmailPort,
  BillingStores,
  PaymentRecord,
} from '../../ports/index.js';
import type { PaymentWebhookEvent } from './webhook-verify.js';

/**
 * CI service-evidence for the inbound payment-webhook seam: a row lands only
 * when `isCI`, and CI's `verify:evidence` step asserts it was exercised. The
 * name is the thing proven — our verifier accepted a real Helcim signature
 * over real Helcim bytes — not the relay that carried them. Recorded after
 * signature verification succeeds: an unverified delivery proves nothing.
 */
export function recordPaymentWebhookEvidence(db: Database, isCI: boolean): Promise<void> {
  return recordServiceEvidence(db, isCI, SERVICE_NAMES.HELCIM_WEBHOOK);
}

export interface PaymentWebhookDeps {
  /** Capability-bearing so the session-revoke enqueue leaves its wake behind. */
  readonly db: JobWakeCapable<Database>;
  readonly stores: BillingStores;
  readonly accountDefense: AccountDefensePort;
  readonly accountLockedEmail: ChargebackLockEmailPort;
  /**
   * Carries the `session.revoke.v1` registration for the in-transaction
   * enqueue (the revoke job is enqueued atomically with the clawback + lock).
   */
  readonly registry: JobRegistry;
}

/**
 * What one verified webhook delivery did. `unmatched` is the only kind the
 * route answers non-2xx for: a completed event racing ahead of the charge
 * finalize has no row to match (the transaction id lands on the row only at
 * finalize), so the provider's redelivery — and, past the threshold, the
 * verify job — are the retry paths.
 */
export type PaymentWebhookDisposition =
  | { readonly kind: 'credited'; readonly paymentId: string }
  | { readonly kind: 'already-completed'; readonly paymentId: string }
  | { readonly kind: 'completed-without-wallet'; readonly paymentId: string }
  | { readonly kind: 'unmatched' }
  | { readonly kind: 'decline-recorded'; readonly paymentId: string }
  | { readonly kind: 'decline-unmatched' }
  | { readonly kind: 'clawback-posted'; readonly paymentId: string }
  | { readonly kind: 'clawback-duplicate'; readonly paymentId: string }
  | { readonly kind: 'dispute-unmatched' }
  | { readonly kind: 'dispute-orphaned'; readonly paymentId: string }
  | { readonly kind: 'notify-only' }
  | { readonly kind: 'ignored' };

/**
 * The observability half of one verified webhook delivery, exhaustive over the
 * disposition union so a new kind cannot be added without deciding what it
 * rings. An `errorCode` naming a registered fingerprint marks a condition that
 * also pages; a bare warn is warn-only by decision.
 */
export function signalPaymentWebhookDisposition(
  logger: Telemetry,
  disposition: PaymentWebhookDisposition
): void {
  match(disposition)
    // The payment flow working as designed — a credit, a replay of one, and a
    // decline recorded against a payment we hold. Only their rate would be
    // worth knowing, and rates are not instrumented.
    .with(
      { kind: 'credited' },
      { kind: 'already-completed' },
      { kind: 'decline-recorded' },
      () => undefined
    )
    // The 404 the route answers is this kind's whole behaviour: the provider
    // redelivers, so nothing here is wrong yet.
    .with({ kind: 'unmatched' }, () => undefined)
    .with({ kind: 'clawback-posted' }, () => {
      // Money left and an account was locked. Reversible only by a human who
      // knows it happened, which makes this the loudest signal on the route.
      logger.warn('payment chargeback clawed back and the account was locked', {
        errorCode: FINGERPRINT_CODES.paymentClawbackPosted,
      });
      logger.captureError(
        new Error('payment chargeback clawed back and the account was locked'),
        FINGERPRINT_CODES.paymentClawbackPosted
      );
    })
    .with({ kind: 'dispute-unmatched' }, () => {
      logger.warn('payment dispute matched no payment', {
        errorCode: FINGERPRINT_CODES.paymentDisputeUnmatched,
      });
      logger.captureError(
        new Error('payment dispute matched no payment'),
        FINGERPRINT_CODES.paymentDisputeUnmatched
      );
    })
    .with({ kind: 'dispute-orphaned' }, () => {
      logger.warn('payment dispute has no account to charge back', {
        errorCode: FINGERPRINT_CODES.paymentDisputeOrphaned,
      });
      logger.captureError(
        new Error('payment dispute has no account to charge back'),
        FINGERPRINT_CODES.paymentDisputeOrphaned
      );
    })
    .with({ kind: 'completed-without-wallet' }, () => {
      logger.warn('payment completed with no wallet to credit', {
        errorCode: FINGERPRINT_CODES.paymentCompletedWithoutWallet,
      });
      logger.captureError(
        new Error('payment completed with no wallet to credit'),
        FINGERPRINT_CODES.paymentCompletedWithoutWallet
      );
    })
    .with({ kind: 'notify-only' }, () => {
      // Covers every dispute that takes no money or lock action: inquiries,
      // retrievals, and chargebacks/reversals on payments that never completed
      // (no captured funds to claw back, no capture fraud warranting a lock).
      // Nothing downstream acts on one, so the page is the notification.
      logger.warn('payment dispute surfaced, no action taken', {
        errorCode: FINGERPRINT_CODES.paymentDisputeSurfaced,
      });
      logger.captureError(
        new Error('payment dispute surfaced, no action taken'),
        FINGERPRINT_CODES.paymentDisputeSurfaced
      );
    })
    // Warn-only: the mechanism worked. A replayed clawback is the idempotent
    // fence holding, and a decline for a payment we never had is what probing
    // traffic looks like.
    .with({ kind: 'clawback-duplicate' }, () => {
      logger.warn('payment clawback replay took no further action');
    })
    .with({ kind: 'decline-unmatched' }, () => {
      logger.warn('payment decline matched no payment');
    })
    .with({ kind: 'ignored' }, () => {
      logger.warn('unrecognized payment webhook event ignored');
    })
    .exhaustive();
}

export interface PaymentWebhookApplication {
  /** True when this delivery performed the effect (the byEventId claim). */
  readonly claimed: boolean;
  readonly disposition: PaymentWebhookDisposition;
}

function applied(
  claimed: boolean,
  disposition: PaymentWebhookDisposition
): PaymentWebhookApplication {
  return { claimed, disposition };
}

function applyCompleted(
  deps: PaymentWebhookDeps,
  transactionId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return fromPromise(
    runSettlement(deps.db, async (tx) => {
      const claimedRow = await deps.stores.claimPaymentCompletedWithinTx(tx, {
        helcimTransactionId: transactionId,
      });
      if (claimedRow === null) return null;
      if (claimedRow.userId === null) {
        return { paymentId: claimedRow.id, credited: false };
      }
      await creditPaymentWithinTx(deps.stores, tx, {
        paymentId: claimedRow.id,
        userId: claimedRow.userId,
        amountNanoUsd: claimedRow.amountNanoUsd,
      });
      return { paymentId: claimedRow.id, credited: true };
    }),
    (cause) => unavailableError('webhook credit settlement failed', cause)
  ).andThen((result) => {
    if (result !== null) {
      return okAsync(
        applied(
          true,
          result.credited
            ? { kind: 'credited', paymentId: result.paymentId }
            : { kind: 'completed-without-wallet', paymentId: result.paymentId }
        )
      );
    }
    return deps.stores
      .readPaymentByTransactionId(deps.db, transactionId)
      .map((row) =>
        row !== null && row.status === 'completed'
          ? applied(false, { kind: 'already-completed', paymentId: row.id })
          : applied(false, { kind: 'unmatched' })
      );
  });
}

function applyFailed(
  deps: PaymentWebhookDeps,
  transactionId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return deps.stores.readPaymentByTransactionId(deps.db, transactionId).andThen((row) => {
    if (row === null) return okAsync(applied(false, { kind: 'decline-unmatched' }));
    return fromPromise(
      runSettlement(deps.db, (tx) =>
        deps.stores.markPaymentFailedWithinTx(
          tx,
          row.id,
          CARD_DECLINED_ERROR_CODE,
          'awaiting_webhook'
        )
      ),
      (cause) => unavailableError('webhook decline settlement failed', cause)
    ).map((transitioned) =>
      transitioned
        ? applied(true, { kind: 'decline-recorded', paymentId: row.id })
        : applied(false, { kind: 'decline-unmatched' })
    );
  });
}

async function postClawbackWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  payment: PaymentRecord,
  userId: string
): Promise<'posted' | 'duplicate'> {
  // The event claim: the unique leg keys dedupe per payment, so a chargeback
  // and a later reversal on the same payment claw back exactly once.
  const posting = await postPaymentAdjustmentWithinTx(stores, tx, {
    paymentId: payment.id,
    userId,
    kind: 'clawback',
    deltaNanoUsd: -payment.amountNanoUsd,
    keys: {
      transactionId: crypto.randomUUID(),
      wallet: `clawback:${payment.id}:user`,
      house: `clawback:${payment.id}:house`,
    },
  });
  return posting.posted ? 'posted' : 'duplicate';
}

/**
 * Enqueues the must-happen `session.revoke.v1` job on the clawback
 * `SettlementTx`, so session revocation commits atomically with the clawback +
 * lock — it can never be lost the way a swallowed post-commit best-effort
 * watermark bump was. The dedupe key is per-payment, so a redelivered dispute
 * for the same payment does not double-enqueue; a distinct captured dispute for
 * the same user enqueues a fresh job (harmless — the handler is naturally
 * idempotent).
 */
function enqueueChargebackRevokeWithinTx(
  tx: JobWakeCapable<SettlementTx>,
  registry: JobRegistry,
  args: { readonly userId: string; readonly paymentId: string }
): Promise<EnqueueJobResult> {
  return enqueueWithinTx(tx, registry, {
    type: SESSION_REVOKE_JOB_TYPE,
    payload: { userId: args.userId },
    dedupeKey: `chargeback-revoke:${args.paymentId}`,
  });
}

/** What one clawback settlement did — posted (with its defense) or a duplicate. */
interface ClawbackAndDefense {
  readonly posted: 'posted' | 'duplicate';
  readonly locked: boolean;
  readonly lockEmail: string | null;
  readonly lockUserName: string | null;
}

function disputeDisposition(
  posted: 'posted' | 'duplicate',
  paymentId: string
): PaymentWebhookDisposition {
  return posted === 'posted'
    ? { kind: 'clawback-posted', paymentId }
    : { kind: 'clawback-duplicate', paymentId };
}

function applyDisputeToPayment(
  deps: PaymentWebhookDeps,
  payment: PaymentRecord,
  userId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  // A dispute on a payment the webhook never completed has no captured funds to
  // claw back and no capture fraud warranting a lock — surface it only.
  if (payment.status !== 'completed') {
    return okAsync(applied(false, { kind: 'notify-only' }));
  }
  return fromPromise(
    runSettlement(deps.db, async (tx): Promise<ClawbackAndDefense> => {
      const posted = await postClawbackWithinTx(deps.stores, tx, payment, userId);
      if (posted !== 'posted') {
        return { posted, locked: false, lockEmail: null, lockUserName: null };
      }
      // Atomic with the clawback: the lock AND the revoke-job enqueue commit in
      // the SAME transaction, gated on the freshly-posted clawback. A lock (or
      // enqueue) failure throws and rolls the clawback back — the provider
      // redelivers and re-drives all three together, so money is never reversed
      // while the account stays open and its sessions live.
      const lock = await deps.accountDefense.lockForChargebackWithinTx(tx, userId);
      await enqueueChargebackRevokeWithinTx(tx, deps.registry, {
        userId,
        paymentId: payment.id,
      });
      return {
        posted,
        locked: lock.locked,
        lockEmail: lock.email,
        lockUserName: lock.userName,
      };
    }),
    (cause) => unavailableError('clawback settlement failed', cause)
  ).andThen((settled) => {
    if (settled.posted !== 'posted') {
      // Duplicate delivery: the clawback already posted, so no lock and no
      // enqueue — a replay (even after an admin unlock) performs no defense.
      return okAsync(applied(false, disputeDisposition('duplicate', payment.id)));
    }
    // Post-commit best-effort lock notification, only on a freshly-performed
    // lock (an already-locked user was notified by the earlier dispute); it
    // never blocks or fails the webhook.
    const notify: ResultAsync<unknown, DomainError> =
      settled.locked && settled.lockEmail !== null
        ? deps.accountLockedEmail
            .sendChargebackLockEmail({
              to: settled.lockEmail,
              ...(settled.lockUserName === null ? {} : { userName: settled.lockUserName }),
            })
            .orElse(() => okAsync())
        : okAsync();
    return notify.map(() => applied(true, disputeDisposition('posted', payment.id)));
  });
}

function applyDispute(
  deps: PaymentWebhookDeps,
  transactionId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return deps.stores.readPaymentByTransactionId(deps.db, transactionId).andThen((payment) => {
    if (payment === null) return okAsync(applied(false, { kind: 'dispute-unmatched' }));
    if (payment.userId === null) {
      return okAsync(applied(false, { kind: 'dispute-orphaned', paymentId: payment.id }));
    }
    return applyDisputeToPayment(deps, payment, payment.userId);
  });
}

/**
 * Applies one signature-verified Helcim event. Every effect is claim-fenced
 * in Postgres (status transition or unique leg keys), so the route's
 * `byEventId` composition gets a duplicate- and race-safe executor; the
 * dispute taxonomy is enforced here — auto-defense (clawback + lock) only on a
 * chargeback or reversal against a completed payment; a dispute on a
 * non-completed payment, inquiries, and retrievals notify only.
 */
export function applyPaymentWebhookEvent(
  deps: PaymentWebhookDeps,
  event: PaymentWebhookEvent
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return match(event)
    .with({ type: 'payment.completed' }, ({ transactionId }) => applyCompleted(deps, transactionId))
    .with({ type: 'payment.failed' }, ({ transactionId }) => applyFailed(deps, transactionId))
    .with({ type: 'dispute.chargeback' }, ({ transactionId }) => applyDispute(deps, transactionId))
    .with({ type: 'dispute.reversal' }, ({ transactionId }) => applyDispute(deps, transactionId))
    .with({ type: 'dispute.inquiry' }, () => okAsync(applied(false, { kind: 'notify-only' })))
    .with({ type: 'dispute.retrieval' }, () => okAsync(applied(false, { kind: 'notify-only' })))
    .with({ type: 'unrecognized' }, () => okAsync(applied(false, { kind: 'ignored' })))
    .exhaustive();
}
