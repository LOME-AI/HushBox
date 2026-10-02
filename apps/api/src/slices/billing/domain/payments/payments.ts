import { z } from 'zod';
import {
  ERROR_CODES,
  MAX_DEPOSIT_USD,
  MIN_DEPOSIT_USD,
  NANO_USD_PER_CENT,
  NanoUSD,
  nanoUSD,
} from '@hushbox/shared';
import { conflictError, unavailableError, validationError } from '../../../../lib/errors/index.js';
import { byExternalPreClaim, runSettlement } from '../../../../lib/idempotency/index.js';
import { BACKOFF_CAP_SECONDS, rideOutSeconds } from '../../../../lib/jobs/backoff.js';
import { enqueueWithinTx } from '../../../../lib/jobs/index.js';
import { errAsync, fromPromise, okAsync } from '../../../../lib/result/index.js';
import { postPaymentAdjustmentWithinTx } from './payment-ledger.js';
import type { Database } from '@hushbox/db';
import type { Principal } from '../../../../lib/context/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { DbWriter, Idempotent, SettlementTx } from '../../../../lib/idempotency/index.js';
import type { EnqueueJobResult, JobRegistry, JobWakeCapable } from '../../../../lib/jobs/index.js';
import type { PaymentAdjustmentKeys } from './payment-ledger.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type {
  BillingStores,
  ChargeOutcome,
  PaymentProvider,
  PaymentRecord,
} from '../../ports/index.js';

/** Product spec (README pricing): card loading starts at $5 (= 5·10^9 nano-USD). */
export const PAYMENT_MINIMUM_NANO_USD = BigInt(MIN_DEPOSIT_USD) * 100n * NANO_USD_PER_CENT;

/** The ceiling on one charge, from the same shared bound the web form enforces. */
export const PAYMENT_MAXIMUM_NANO_USD = BigInt(MAX_DEPOSIT_USD) * 100n * NANO_USD_PER_CENT;

/** The only decline detail persisted — a code, never provider freeform text. */
export const CARD_DECLINED_ERROR_CODE = 'card_declined';

export const PAYMENT_VERIFY_JOB_TYPE = 'payment.verify.v1';

/**
 * The merchant reference submitted to Helcim as the charge's `invoiceNumber`,
 * re-derived from the payment id alone at verify time — no stored column. It
 * is the uuid's 32 hex digits with hyphens stripped: Helcim's
 * `GET /card-transactions?invoiceNumber=` search filters on it, whereas the
 * pre-claim id forwarded as the idempotency-key header is not searchable. The
 * length assertion fails fast if a non-uuid id ever reaches here (a defect).
 */
export function paymentReference(paymentId: string): string {
  const reference = paymentId.replaceAll('-', '').toLowerCase();
  if (reference.length !== 32) {
    throw new Error('billing: payment id is not a 32-hex-digit uuid');
  }
  return reference;
}

/**
 * The webhook threshold: the delayed verify job fires this long after the
 * pre-claim. Past it, an unresolved pre-claim is reconciled against the
 * provider (`awaiting_webhook`) or expired (`pending` — the charge call never
 * finished and no transaction id exists to query by).
 */
export const PAYMENT_VERIFY_DELAY_SECONDS = 30 * 60;

/**
 * Failure budget before the dispatcher dead-letters the verify job at claim
 * time. Only transient provider failures consume it — every terminal state of
 * the pre-claim maps to `ok`, so the job succeeds for every legal payload
 * (jobs philosophy: a job that cannot reach success is a code defect).
 *
 * Sized against the backoff curve so the budget spans more than a day of
 * sustained provider unavailability: an approved charge whose webhook never
 * landed is a captured card with an uncredited wallet, so the reconciler must
 * outlast a vendor outage rather than give the row up inside one.
 */
export const PAYMENT_VERIFY_MAX_FAILURES = 32;

/**
 * Slack past the verify path's own window before an unresolved deposit stops
 * blocking the next one: the last scheduled attempt still has to be claimed
 * and executed, and the dispatcher's idle decay can defer that claim.
 */
const PAYMENT_IN_FLIGHT_MARGIN_SECONDS = BACKOFF_CAP_SECONDS;

/**
 * The age past which a still-non-terminal pre-claim no longer blocks a new
 * deposit: the verify job's scheduling delay, plus the retry budget's whole
 * wall-clock span at its widest jitter, plus the claim margin. Past it the
 * verify path can no longer resolve the row, so holding the user out of the
 * product would buy nothing — the window is what makes the guard release
 * itself with no sweep and no cleaner.
 *
 * Derived from {@link PAYMENT_VERIFY_MAX_FAILURES} and the shared backoff
 * curve, never written down: raising the budget widens this with it.
 */
export function inFlightPaymentCutoff(now: Date): Date {
  const windowSeconds =
    PAYMENT_VERIFY_DELAY_SECONDS +
    rideOutSeconds(PAYMENT_VERIFY_MAX_FAILURES, () => 1) +
    PAYMENT_IN_FLIGHT_MARGIN_SECONDS;
  return new Date(now.getTime() - Math.round(windowSeconds * 1000));
}

/** Request body for the charge-initiation route (amounts as NanoUSD strings). */
export const initiatePaymentBodySchema = z.object({
  amountNanoUsd: NanoUSD,
  cardToken: z.string().min(1),
  customerCode: z.string().min(1),
});

/**
 * The billing principal's own `userId` from the pipeline principal. Shared by the
 * `billing-token`-class charge and wallet-read routes, which the in-app billing
 * page reaches with a full session and the mobile → web handoff with its own
 * credential — so both kinds are legal; anything else here is a composition
 * defect.
 */
export function billingPrincipalUserId(principal: Principal): string {
  if (principal.kind === 'full') return principal.claims.userId;
  if (principal.kind === 'billing-portal') return principal.credential.userId;
  throw new Error('billing: payment route reached without a session principal');
}

export interface InitiateCardPaymentDeps {
  /** Capability-bearing so the verify-job enqueue leaves its wake behind. */
  readonly db: JobWakeCapable<Database>;
  readonly stores: BillingStores;
  readonly provider: PaymentProvider;
  readonly registry: JobRegistry;
}

interface InitiateCardPaymentArgs {
  readonly userId: string;
  readonly amountNanoUsd: bigint;
  readonly cardToken: string;
  readonly customerCode: string;
  readonly ipAddress: string;
  /** The client's `Idempotency-Key` header value (scoped per user in storage). */
  readonly idempotencyKey: string;
  readonly now: Date;
}

interface CardPaymentOutcome {
  readonly paymentId: string;
  readonly status: 'awaiting_webhook' | 'completed' | 'failed' | 'expired';
  readonly amountNanoUsd: bigint;
}

/**
 * A pre-claim replay maps straight off the row; `pending` is unreachable here
 * (a pending claim always re-runs the charge first) and therefore a defect.
 */
export function cardPaymentOutcomeOf(payment: PaymentRecord): CardPaymentOutcome {
  if (payment.status === 'pending') {
    throw new Error('card payment outcome requested for a still-pending pre-claim');
  }
  return {
    paymentId: payment.id,
    status: payment.status,
    amountNanoUsd: payment.amountNanoUsd,
  };
}

interface ChargeClaim {
  readonly payment: PaymentRecord;
  readonly created: boolean;
}

type ExternalCharge =
  | { readonly kind: 'replay' }
  | { readonly kind: 'charged'; readonly outcome: ChargeOutcome };

function validateChargeAmount(amountNanoUsd: bigint): DomainError | null {
  if (amountNanoUsd < PAYMENT_MINIMUM_NANO_USD) {
    return validationError('payment amount is below the minimum');
  }
  if (amountNanoUsd > PAYMENT_MAXIMUM_NANO_USD) {
    return validationError('payment amount is above the maximum');
  }
  if (amountNanoUsd % NANO_USD_PER_CENT !== 0n) {
    return validationError('payment amount must be whole cents');
  }
  return null;
}

/**
 * Rolls the pre-claim transaction back when the guard refuses, taking the row
 * it had already inserted with it — a refused claim that survived would itself
 * block the user for the whole guard window. Never escapes this module:
 * {@link preClaimPayment}'s failure mapper turns it into the typed refusal.
 */
class PaymentInFlightAbort extends Error {}

function preClaimPayment(
  deps: InitiateCardPaymentDeps,
  args: InitiateCardPaymentArgs
): ResultAsync<ChargeClaim, DomainError> {
  return fromPromise(
    runSettlement(deps.db, async (tx) => {
      const claim = await deps.stores.insertPaymentIfAbsentWithinTx(tx, {
        userId: args.userId,
        amountNanoUsd: args.amountNanoUsd,
        // User-scoped so two users choosing the same client key never collide
        // on the global unique column.
        idempotencyKey: `pay:${args.userId}:${args.idempotencyKey}`,
      });
      // A re-execution re-sends the pre-claim id as the provider key, which the
      // provider replays instead of capturing twice — only a fresh claim can
      // become a second capture, so only a fresh claim is guarded.
      if (!claim.created) return claim;
      // The user's wallet row is the serialization point: concurrent fresh
      // pre-claims block here, so each counts what the other committed rather
      // than racing it. Taken after the payments insert, the order the webhook
      // credit path also takes, so the two cannot deadlock against each other.
      const wallet = await deps.stores.insertWalletIfAbsentWithinTx(tx, args.userId, 'purchased');
      await deps.stores.lockWalletWithinTx(tx, wallet.id);
      const inFlight = await deps.stores.countInFlightPaymentsWithinTx(tx, {
        userId: args.userId,
        since: inFlightPaymentCutoff(args.now),
        excludePaymentId: claim.payment.id,
      });
      if (inFlight > 0) {
        throw new PaymentInFlightAbort('an earlier deposit is still unresolved');
      }
      await enqueuePaymentVerifyWithinTx(tx, deps.registry, {
        paymentId: claim.payment.id,
        now: args.now,
      });
      return claim;
    }),
    (cause) =>
      cause instanceof PaymentInFlightAbort
        ? conflictError(cause.message, undefined, ERROR_CODES.PAYMENT_IN_FLIGHT)
        : unavailableError('payment pre-claim failed', cause)
  ).andThen((claim) => {
    if (
      !claim.created &&
      (claim.payment.userId !== args.userId || claim.payment.amountNanoUsd !== args.amountNanoUsd)
    ) {
      return errAsync(conflictError('idempotency key reused with a different payment body'));
    }
    return okAsync(claim);
  });
}

function chargeExternal(
  deps: InitiateCardPaymentDeps,
  args: InitiateCardPaymentArgs,
  claim: ChargeClaim
): ResultAsync<ExternalCharge, DomainError> {
  // Only a pending pre-claim charges: a fresh claim, or a crash-recovery retry
  // re-sending with the SAME provider key (the payment row id), which the
  // provider replays instead of capturing twice.
  if (claim.payment.status !== 'pending') {
    return okAsync<ExternalCharge, DomainError>({ kind: 'replay' });
  }
  return deps.provider
    .charge({
      idempotencyKey: claim.payment.id,
      reference: paymentReference(claim.payment.id),
      amount: nanoUSD(args.amountNanoUsd),
      cardToken: args.cardToken,
      customerCode: args.customerCode,
      ipAddress: args.ipAddress,
    })
    .map((outcome): ExternalCharge => ({ kind: 'charged', outcome }));
}

function finalizeCharge(
  deps: InitiateCardPaymentDeps,
  payment: PaymentRecord,
  outcome: ChargeOutcome
): ResultAsync<CardPaymentOutcome, DomainError> {
  return fromPromise(
    runSettlement(deps.db, (tx: SettlementTx) =>
      outcome.status === 'approved'
        ? deps.stores.markPaymentChargedWithinTx(tx, payment.id, {
            helcimTransactionId: outcome.transactionId,
            ...(outcome.cardType === undefined ? {} : { cardType: outcome.cardType }),
            ...(outcome.cardLastFour === undefined ? {} : { cardLastFour: outcome.cardLastFour }),
          })
        : deps.stores.markPaymentFailedWithinTx(tx, payment.id, CARD_DECLINED_ERROR_CODE, 'pending')
    ),
    (cause) => unavailableError('payment finalize failed', cause)
  ).andThen((transitioned) => {
    if (transitioned) {
      return okAsync<CardPaymentOutcome, DomainError>({
        paymentId: payment.id,
        status: outcome.status === 'approved' ? 'awaiting_webhook' : 'failed',
        amountNanoUsd: payment.amountNanoUsd,
      });
    }
    // 0 rows: a concurrent retry finalized first — read and replay its state.
    return deps.stores.readPayment(deps.db, payment.id).andThen((row) => {
      if (row === null) {
        throw new Error('payment pre-claim row vanished during finalize');
      }
      return okAsync(cardPaymentOutcomeOf(row));
    });
  });
}

/**
 * Pattern D, whole: the durable `payments` pre-claim (plus the delayed verify
 * job, same transaction) commits BEFORE the card charge; the charge carries
 * the pre-claim id as its provider idempotency key; finalize records the
 * approval (`awaiting_webhook`) or decline. A crash at any point leaves the
 * pre-claim row as the reconciliation anchor for the webhook and the verify
 * job — never a second capture.
 */
export function initiateCardPayment(
  deps: InitiateCardPaymentDeps,
  args: InitiateCardPaymentArgs
): ResultAsync<Idempotent<CardPaymentOutcome>, DomainError> {
  const invalid = validateChargeAmount(args.amountNanoUsd);
  if (invalid !== null) {
    return errAsync<Idempotent<CardPaymentOutcome>, DomainError>(invalid);
  }
  return byExternalPreClaim<ChargeClaim, ExternalCharge, CardPaymentOutcome, DomainError>({
    preClaim: () => preClaimPayment(deps, args),
    external: (claim) => chargeExternal(deps, args, claim),
    finalize: (claim, external) =>
      external.kind === 'replay'
        ? okAsync(cardPaymentOutcomeOf(claim.payment))
        : finalizeCharge(deps, claim.payment, external.outcome),
  });
}

interface CreditPaymentArgs {
  readonly paymentId: string;
  readonly userId: string;
  readonly amountNanoUsd: bigint;
}

/**
 * The per-payment key strategy for the automatic credit: one deposit per
 * `payments` row, whoever delivers it (webhook or verify job).
 */
export function depositAdjustmentKeys(paymentId: string): PaymentAdjustmentKeys {
  return {
    transactionId: crypto.randomUUID(),
    wallet: `deposit:${paymentId}:user`,
    house: `deposit:${paymentId}:house`,
  };
}

/**
 * The webhook-finalization credit. Exactly-once rides on the caller's
 * completed-claim transition in the SAME transaction; the per-payment leg keys
 * are the independent DB-backed second guard, applied by the shared door.
 */
export async function creditPaymentWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  args: CreditPaymentArgs
): Promise<void> {
  await postPaymentAdjustmentWithinTx(stores, tx, {
    paymentId: args.paymentId,
    userId: args.userId,
    kind: 'deposit',
    deltaNanoUsd: args.amountNanoUsd,
    keys: depositAdjustmentKeys(args.paymentId),
  });
}

/**
 * Pattern C enqueue inside the pre-claim transaction: delayed to the webhook
 * threshold, deduped per payment so a retried pre-claim never double-enqueues.
 */
export function enqueuePaymentVerifyWithinTx(
  tx: JobWakeCapable<DbWriter>,
  registry: JobRegistry,
  args: { readonly paymentId: string; readonly now: Date }
): Promise<EnqueueJobResult> {
  return enqueueWithinTx(tx, registry, {
    type: PAYMENT_VERIFY_JOB_TYPE,
    payload: { paymentId: args.paymentId },
    dedupeKey: `payment.verify:${args.paymentId}`,
    scheduledAt: new Date(args.now.getTime() + PAYMENT_VERIFY_DELAY_SECONDS * 1000),
  });
}
