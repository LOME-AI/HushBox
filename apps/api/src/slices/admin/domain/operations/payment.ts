import { ADMIN_OP_CONTRACTS, ERROR_CODES } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { postPaymentAdjustmentWithinTx } from '../../../billing/index.js';
import { defineAdminOp } from '../registry.js';
import { deriveAdjustmentKeys, recordWalletMove } from './money-adjustment.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { BillingStores, PaymentRecord, PaymentStatus } from '../../../billing/index.js';
import type { AdminOpContext, AdminOpOutcome, AdminOpTarget } from '../registry.js';
import type { AdminWalletSnapshotPostDeps } from './money-adjustment.js';

/**
 * The operator's repair path for the irreducible residual: a `payments` row
 * whose money state no mechanism can determine, because the provider denied
 * both the stored transaction id and the merchant-reference search. Two
 * mutual pairs — expire ↔ restore moves no money, complete ↔ claw back moves
 * exactly the row's captured amount — so every verdict a human reaches here
 * is reversible by the op that puts the row back.
 *
 * The status transition is the arbitration in every one of them: an atomic
 * conditional update on the row's current status, so an op racing the webhook
 * or the verify job loses cleanly instead of double-crediting.
 */

const forceExpireContract = ADMIN_OP_CONTRACTS['payment.forceExpire'];
const restoreAwaitingWebhookContract = ADMIN_OP_CONTRACTS['payment.restoreAwaitingWebhook'];
const forceCompleteAndCreditContract = ADMIN_OP_CONTRACTS['payment.forceCompleteAndCredit'];
const uncompleteAndClawbackContract = ADMIN_OP_CONTRACTS['payment.uncompleteAndClawback'];

/** The money pair share one input schema, so one input type covers them. */
type PaymentOpInput = (typeof forceCompleteAndCreditContract)['input'];

/** The money-free pair's, likewise: the target plus the id they move. */
type PaymentHandleInput = (typeof forceExpireContract)['input'];

export interface AdminPaymentDeps {
  readonly billingStores: BillingStores;
}

/** What the engine hands the snapshot effect once the transaction has committed. */
export type AdminPaymentPostDeps = AdminWalletSnapshotPostDeps;

type PaymentOpContext = AdminOpContext<AdminPaymentDeps, AdminPaymentPostDeps>;

/** The audit row's target for every op here. */
function paymentTarget(paymentId: string): AdminOpTarget {
  return { type: 'payment', id: paymentId };
}

/**
 * The one arbitration: `from → to` under the row's current status. A refusal
 * distinguishes a row that does not exist from one another writer already
 * moved, because only the second is the webhook winning a race the operator
 * also entered.
 */
async function transitionPayment(
  ctx: PaymentOpContext,
  paymentId: string,
  from: PaymentStatus,
  to: PaymentStatus
): Promise<Result<PaymentRecord, DomainError>> {
  const moved = await ctx.deps.billingStores.transitionPaymentStatusWithinTx(
    ctx.tx,
    paymentId,
    from,
    to
  );
  if (moved.outcome === 'transitioned') return ok(moved.payment);
  if (moved.outcome === 'missing') return err(notFoundError('payment does not exist'));
  return err(conflictError(`payment is ${moved.status}, not ${from}`));
}

/** The status change every op lands, rendered for the preview diff. */
function statusEffect(from: PaymentStatus, to: PaymentStatus): AdminOpOutcome['effects'][number] {
  return { label: 'payment.status', before: from, after: to };
}

/** The transaction-id column's change, rendered for the preview diff. */
function transactionIdEffect(
  before: string | null,
  after: string | null
): AdminOpOutcome['effects'][number] {
  return { label: 'payment.helcimTransactionId', before, after };
}

interface StatusVerdictSpec {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  /**
   * Which end of the transaction-id column an operator-supplied id names:
   * `attach` writes it onto an empty column, `detach` clears exactly it.
   */
  readonly handle: 'attach' | 'detach';
  /**
   * A precondition on the moved row that the `WHERE status = from` predicate
   * cannot express, applied when no id is supplied. Its refusal rolls the
   * transition back with it, because the engine fails the whole settlement
   * transaction on an `Err`.
   */
  readonly refuse?: (payment: PaymentRecord) => DomainError | undefined;
}

/**
 * The money-free pair's shared body. The status transition is the
 * arbitration; a supplied transaction id then moves the column with a second
 * guarded update, whose predicate is the side the column is currently on — so
 * neither direction can overwrite a handle the row already carries, and the
 * two ops are one another's exact undo through one field.
 *
 * The second update is not a check-then-act: the transition above already
 * holds this row's write lock for the rest of the settlement transaction, so
 * no other writer can move between them.
 */
async function statusVerdict(
  ctx: PaymentOpContext,
  input: { readonly paymentId: string; readonly helcimTransactionId?: string | undefined },
  spec: StatusVerdictSpec
): Promise<Result<AdminOpOutcome, DomainError>> {
  const { paymentId } = input;
  const moved = await transitionPayment(ctx, paymentId, spec.from, spec.to);
  if (moved.isErr()) return err(moved.error);
  const supplied = input.helcimTransactionId;
  if (supplied === undefined) {
    const refusal = spec.refuse?.(moved.value);
    if (refusal !== undefined) return err(refusal);
    return ok({
      effects: [statusEffect(spec.from, spec.to)],
      target: paymentTarget(paymentId),
      inverseInput: { paymentId },
    });
  }
  const attaching = spec.handle === 'attach';
  const write = attaching ? { expected: null, next: supplied } : { expected: supplied, next: null };
  const written = await ctx.deps.billingStores.setPaymentTransactionIdWithinTx(
    ctx.tx,
    paymentId,
    write
  );
  // An id another `payments` row already owns is a typo an operator can make
  // from the provider dashboard, so it earns its own code: the refusal it
  // deserves says the id names a payment already on record, which is a
  // different next move from "this row's column is not where you said".
  if (written === 'id-taken') {
    return err(
      conflictError(
        'transaction id already belongs to another payment',
        undefined,
        ERROR_CODES.PAYMENT_TRANSACTION_ID_TAKEN
      )
    );
  }
  if (written === 'guard-mismatch') {
    return err(
      conflictError(
        attaching
          ? 'payment already carries a transaction id'
          : 'payment does not carry that transaction id'
      )
    );
  }
  return ok({
    effects: [statusEffect(spec.from, spec.to), transactionIdEffect(write.expected, write.next)],
    target: paymentTarget(paymentId),
    // The undo must reproduce the whole act, so the id rides back on the
    // inverse's own input: the force-expire undoing an attach detaches exactly
    // it, and the restore undoing a detach re-attaches exactly it.
    inverseInput: { paymentId, helcimTransactionId: supplied },
  });
}

/**
 * `awaiting_webhook` asserts the card WAS captured: it is the state the
 * stuck-payment auditor pages on and the one
 * {@link paymentForceCompleteAndCredit} grants money against. A row the
 * verify job expired out of `pending` never reached the provider and so
 * carries no transaction id — restoring it with nothing supplied would mint
 * that assertion from a charge that never happened, landing the state the
 * reconciler (`domain/payments/payment-verify.ts`) classifies as a code
 * defect. Refused instead, and the operator's route past it is to supply the
 * id the dashboard shows.
 *
 * The refusal also bites the row {@link paymentForceExpire} leaves behind
 * when it detaches an id — deliberately: that row is back to exactly the
 * pre-restore state, and refusing it again is the same verdict on the same
 * facts, not an inverse the Law failed to provide.
 */
function requireCapturedCharge(payment: PaymentRecord): DomainError | undefined {
  return payment.helcimTransactionId === null
    ? conflictError('payment carries no transaction id to await a webhook for')
    : undefined;
}

/**
 * Expires a row the provider denies. Supplying the row's transaction id also
 * detaches it, which is what the undo of an id-attaching restore needs and the
 * only reason the field exists here: a row whose only claim to a provider
 * handle is an operator's own earlier restore must not keep that handle once
 * the restore is reversed. Guarded on an exact match, so a mistyped id refuses
 * rather than stripping identity the capture really has.
 */
export const paymentForceExpire = defineAdminOp<
  AdminPaymentDeps,
  PaymentHandleInput,
  AdminPaymentPostDeps
>(forceExpireContract, {
  execute: (ctx, input) =>
    statusVerdict(ctx, input, { from: 'awaiting_webhook', to: 'expired', handle: 'detach' }),
});

/**
 * The repair for the one case the refusal above leaves stranded: the operator
 * finds, in the provider dashboard, that a row the verify job expired out of
 * `pending` WAS captured. The id read there is the only new fact in the
 * situation and exactly what the row lacks, so supplying it is what makes the
 * restore truthful rather than a claim minted from nothing.
 *
 * Attaching is guarded on an empty column, so a row that already carries an id
 * is refused rather than rewritten: {@link paymentForceCompleteAndCredit}
 * grants money against `awaiting_webhook`, and pointing a row at another
 * capture's handle is how that grant lands on the wrong money.
 *
 * The invariant every arm preserves, and the one the rest of the payment path
 * reads as "the card WAS captured": a row this op leaves in `awaiting_webhook`
 * always carries a transaction id — the one it already had, or the one the
 * operator supplied.
 */
export const paymentRestoreAwaitingWebhook = defineAdminOp<
  AdminPaymentDeps,
  PaymentHandleInput,
  AdminPaymentPostDeps
>(restoreAwaitingWebhookContract, {
  execute: (ctx, input) =>
    statusVerdict(ctx, input, {
      from: 'expired',
      to: 'awaiting_webhook',
      handle: 'attach',
      refuse: requireCapturedCharge,
    }),
});

interface PaymentAdjustmentSpec {
  readonly opName: (typeof forceExpireContract)['name'];
  readonly ledgerKind: 'deposit' | 'clawback';
  /** +1n credits the wallet; -1n debits it (the house counter-leg mirrors). */
  readonly walletSign: 1n | -1n;
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  /** The operator's justification, part of the adjustment's logical identity. */
  readonly reason: string;
}

/**
 * Posts the money half of a completed/un-completed verdict through billing's
 * published payment-adjustment door — the one definition of what a payment's
 * legs are, shared by every writer of a payment's money half, so this path
 * cannot drift onto a different account or wallet type.
 *
 * Only the key strategy is this op's own: `admin:`-prefixed keys derived from
 * the adjustment's identity, never the webhook's per-payment `deposit:` keys.
 * Deliberate — a claw back returns the row to `awaiting_webhook`, where a real
 * webhook may still land, and a webhook blocked by an admin run's leftover key
 * would fail every redelivery forever. Exactly-once therefore rests on the
 * status transition {@link moneyVerdict} lands, which is atomic; the derived
 * leg keys are the second fence, refusing a re-post of the same logical
 * adjustment rather than double-applying it.
 */
async function adjustForPayment(
  ctx: PaymentOpContext,
  payment: PaymentRecord,
  spec: PaymentAdjustmentSpec
): Promise<Result<AdminOpOutcome, DomainError>> {
  const { userId } = payment;
  if (userId === null) {
    // The account was hard-deleted and the row pseudonymized; there is no
    // wallet to move money into or out of, and inventing one is not a repair.
    return err(conflictError('payment has no account to settle against'));
  }
  const keys = await deriveAdjustmentKeys({
    opName: spec.opName,
    subject: { paymentId: payment.id },
    amountNanoUsd: payment.amountNanoUsd.toString(10),
    reason: spec.reason,
    undoes: ctx.undoes,
  });
  const posting = await postPaymentAdjustmentWithinTx(ctx.deps.billingStores, ctx.tx, {
    paymentId: payment.id,
    userId,
    kind: spec.ledgerKind,
    deltaNanoUsd: spec.walletSign * payment.amountNanoUsd,
    keys,
  });
  if (!posting.posted) {
    return err(conflictError('this payment adjustment already posted to the ledger'));
  }

  return ok({
    effects: [statusEffect(spec.from, spec.to), recordWalletMove(ctx, spec.opName, posting)],
    target: paymentTarget(payment.id),
    inverseInput: { paymentId: payment.id },
  });
}

/** The money pair's shared body: transition first, then move exactly the row's amount. */
async function moneyVerdict(
  ctx: PaymentOpContext,
  input: { readonly paymentId: string; readonly reason: string },
  spec: Omit<PaymentAdjustmentSpec, 'reason'>
): Promise<Result<AdminOpOutcome, DomainError>> {
  const moved = await transitionPayment(ctx, input.paymentId, spec.from, spec.to);
  if (moved.isErr()) return err(moved.error);
  return adjustForPayment(ctx, moved.value, { ...spec, reason: input.reason });
}

export const paymentForceCompleteAndCredit = defineAdminOp<
  AdminPaymentDeps,
  PaymentOpInput,
  AdminPaymentPostDeps
>(forceCompleteAndCreditContract, {
  execute: (ctx, input) =>
    moneyVerdict(ctx, input, {
      opName: forceCompleteAndCreditContract.name,
      ledgerKind: 'deposit',
      walletSign: 1n,
      from: 'awaiting_webhook',
      to: 'completed',
    }),
});

export const paymentUncompleteAndClawback = defineAdminOp<
  AdminPaymentDeps,
  PaymentOpInput,
  AdminPaymentPostDeps
>(uncompleteAndClawbackContract, {
  execute: (ctx, input) =>
    moneyVerdict(ctx, input, {
      opName: uncompleteAndClawbackContract.name,
      ledgerKind: 'clawback',
      walletSign: -1n,
      from: 'completed',
      to: 'awaiting_webhook',
    }),
});
