import { and, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { PAYMENT_STATUSES } from '@hushbox/shared';
import { payments } from '@hushbox/db';
import { isUniqueViolationOn } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import { requireRow, storeFailure } from './store-failure.js';
import type { Database } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type {
  BillingStores,
  InFlightPaymentQuery,
  PaymentChargeIdentifiers,
  PaymentCompletedMatch,
  PaymentInsertInput,
  PaymentRecord,
  PaymentStatus,
  PaymentTransactionIdWrite,
  PaymentTransactionIdWriteOutcome,
} from '../ports/index.js';

/**
 * The `payments.helcim_transaction_id` UNIQUE constraint, as Postgres names it
 * in the migration that created the column. Matching on the name is what keeps
 * the translation to this one condition: the same table's primary key and
 * idempotency-key constraints raise the same SQLSTATE under different names.
 */
const PAYMENT_TRANSACTION_ID_UNIQUE = 'payments_helcim_transaction_id_unique';

/** The pre-claim lifecycle's verdicts — every other status is still in flight. */
const TERMINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  'completed',
  'failed',
  'expired',
]);

/**
 * Subtraction rather than a second list: a status added to the lifecycle is
 * audited by default, where an enumerated non-terminal set would exempt it
 * silently.
 */
const NON_TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = PAYMENT_STATUSES.filter(
  (status) => !TERMINAL_PAYMENT_STATUSES.has(status)
);

const PAYMENT_COLUMNS = {
  id: payments.id,
  userId: payments.userId,
  amountNanoUsd: payments.amountNanoUsd,
  status: payments.status,
  idempotencyKey: payments.idempotencyKey,
  helcimTransactionId: payments.helcimTransactionId,
  cardType: payments.cardType,
  cardLastFour: payments.cardLastFour,
  errorCode: payments.errorCode,
  createdAt: payments.createdAt,
} as const;

function toPaymentRecord(row: {
  id: string;
  userId: string | null;
  amountNanoUsd: bigint;
  status: PaymentStatus;
  idempotencyKey: string;
  helcimTransactionId: string | null;
  cardType: string | null;
  cardLastFour: string | null;
  errorCode: string | null;
  createdAt: Date;
}): PaymentRecord {
  return {
    id: row.id,
    userId: row.userId,
    amountNanoUsd: row.amountNanoUsd,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    helcimTransactionId: row.helcimTransactionId,
    cardType: row.cardType,
    cardLastFour: row.cardLastFour,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
  };
}

/**
 * The payments part of the slice's repository: the Pattern-D pre-claim, every
 * status transition the charge and its webhook drive, and the reads the verify
 * job and the unresolved-row auditor run.
 */
export function createPaymentStores(): Pick<
  BillingStores,
  | 'insertPaymentIfAbsentWithinTx'
  | 'countInFlightPaymentsWithinTx'
  | 'markPaymentChargedWithinTx'
  | 'markPaymentFailedWithinTx'
  | 'markPaymentExpiredWithinTx'
  | 'transitionPaymentStatusWithinTx'
  | 'setPaymentTransactionIdWithinTx'
  | 'claimPaymentCompletedWithinTx'
  | 'readPayment'
  | 'readPaymentByTransactionId'
  | 'findStalePendingPayments'
  | 'countUnresolvedPayments'
> {
  return {
    async insertPaymentIfAbsentWithinTx(tx: SettlementTx, input: PaymentInsertInput) {
      const inserted = await tx
        .insert(payments)
        .values({
          userId: input.userId,
          amountNanoUsd: input.amountNanoUsd,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: payments.idempotencyKey })
        .returning(PAYMENT_COLUMNS);
      const created = inserted[0];
      if (created !== undefined) return { payment: toPaymentRecord(created), created: true };
      const existing = await tx
        .select(PAYMENT_COLUMNS)
        .from(payments)
        .where(eq(payments.idempotencyKey, input.idempotencyKey));
      return {
        payment: toPaymentRecord(
          requireRow(existing[0], 'payment insert conflicted but no row exists')
        ),
        created: false,
      };
    },

    async countInFlightPaymentsWithinTx(tx: SettlementTx, query: InFlightPaymentQuery) {
      const rows = await tx
        .select({ inFlight: sql<number>`count(*)`.mapWith(Number) })
        .from(payments)
        .where(
          and(
            eq(payments.userId, query.userId),
            ne(payments.id, query.excludePaymentId),
            inArray(payments.status, NON_TERMINAL_PAYMENT_STATUSES),
            gt(payments.createdAt, query.since)
          )
        );
      return requireRow(rows[0], 'count(*) returned no row').inFlight;
    },

    async markPaymentChargedWithinTx(
      tx: SettlementTx,
      paymentId: string,
      charge: PaymentChargeIdentifiers
    ) {
      const updated = await tx
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: charge.helcimTransactionId,
          ...(charge.cardType === undefined ? {} : { cardType: charge.cardType }),
          ...(charge.cardLastFour === undefined ? {} : { cardLastFour: charge.cardLastFour }),
          updatedAt: sql`now()`,
        })
        .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
        .returning({ id: payments.id });
      return updated.length === 1;
    },

    async markPaymentFailedWithinTx(
      tx: SettlementTx,
      paymentId: string,
      errorCode: string,
      from: PaymentStatus
    ) {
      const updated = await tx
        .update(payments)
        .set({ status: 'failed', errorCode, updatedAt: sql`now()` })
        .where(and(eq(payments.id, paymentId), eq(payments.status, from)))
        .returning({ id: payments.id });
      return updated.length === 1;
    },

    async markPaymentExpiredWithinTx(tx: SettlementTx, paymentId: string) {
      const updated = await tx
        .update(payments)
        .set({ status: 'expired', updatedAt: sql`now()` })
        .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
        .returning({ id: payments.id });
      return updated.length === 1;
    },

    async transitionPaymentStatusWithinTx(
      tx: SettlementTx,
      paymentId: string,
      from: PaymentStatus,
      to: PaymentStatus
    ) {
      const updated = await tx
        .update(payments)
        .set({ status: to, updatedAt: sql`now()` })
        .where(and(eq(payments.id, paymentId), eq(payments.status, from)))
        .returning(PAYMENT_COLUMNS);
      const moved = updated[0];
      if (moved !== undefined) {
        return { outcome: 'transitioned', payment: toPaymentRecord(moved) } as const;
      }
      // Zero rows: read the actual state to tell a missing row from one
      // another writer already moved. The update above already decided the
      // outcome, so this read classifies it and never gates it.
      const existing = await tx
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, paymentId));
      const status = existing[0]?.status;
      return status === undefined
        ? ({ outcome: 'missing' } as const)
        : ({ outcome: 'wrong-status', status } as const);
    },

    async setPaymentTransactionIdWithinTx(
      tx: SettlementTx,
      paymentId: string,
      write: PaymentTransactionIdWrite
    ): Promise<PaymentTransactionIdWriteOutcome> {
      try {
        // Savepointed: a UNIQUE violation aborts the enclosing transaction, but
        // this method reports outcomes by return and defects by throw, so an
        // `id-taken` return has to mean the handle survived. The nested
        // call rolls back to the savepoint and re-throws, leaving the settlement
        // handle usable. `ON CONFLICT` is an INSERT clause; this is an UPDATE.
        const updated = await tx.transaction((guarded) =>
          guarded
            .update(payments)
            .set({ helcimTransactionId: write.next, updatedAt: sql`now()` })
            .where(
              and(
                eq(payments.id, paymentId),
                write.expected === null
                  ? isNull(payments.helcimTransactionId)
                  : eq(payments.helcimTransactionId, write.expected)
              )
            )
            .returning({ id: payments.id })
        );
        return updated.length === 1 ? 'written' : 'guard-mismatch';
      } catch (error) {
        // The column's own UNIQUE constraint is the arbitration for "another
        // row already owns this id" — reading the table first to find out
        // would be the banned check-then-act, and would race a concurrent
        // operator besides. Matched by constraint NAME, so the table's other
        // unique constraints (its primary key, its idempotency key) and every
        // other SQLSTATE re-raise unchanged and stay defects.
        if (isUniqueViolationOn(error, PAYMENT_TRANSACTION_ID_UNIQUE)) return 'id-taken';
        throw error;
      }
    },

    async claimPaymentCompletedWithinTx(tx: SettlementTx, match: PaymentCompletedMatch) {
      const matcher =
        'paymentId' in match
          ? eq(payments.id, match.paymentId)
          : eq(payments.helcimTransactionId, match.helcimTransactionId);
      const claimed = await tx
        .update(payments)
        .set({ status: 'completed', webhookReceivedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(matcher, eq(payments.status, 'awaiting_webhook')))
        .returning(PAYMENT_COLUMNS);
      const row = claimed[0];
      return row === undefined ? null : toPaymentRecord(row);
    },

    readPayment(db: Database, paymentId: string) {
      return fromPromise(
        db.select(PAYMENT_COLUMNS).from(payments).where(eq(payments.id, paymentId)),
        storeFailure
      ).map((rows) => (rows[0] === undefined ? null : toPaymentRecord(rows[0])));
    },

    readPaymentByTransactionId(db: Database, helcimTransactionId: string) {
      return fromPromise(
        db
          .select(PAYMENT_COLUMNS)
          .from(payments)
          .where(eq(payments.helcimTransactionId, helcimTransactionId)),
        storeFailure
      ).map((rows) => (rows[0] === undefined ? null : toPaymentRecord(rows[0])));
    },

    findStalePendingPayments(db: Database, olderThan: Date, limit: number) {
      return fromPromise(
        db
          .select({
            id: payments.id,
            userId: payments.userId,
            amountNanoUsd: payments.amountNanoUsd,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .where(and(eq(payments.status, 'pending'), lt(payments.createdAt, olderThan)))
          .orderBy(payments.createdAt)
          .limit(limit),
        storeFailure
      );
    },

    countUnresolvedPayments(db: Database, olderThan: Date) {
      return fromPromise(
        db
          .select({ unresolved: sql<number>`count(*)`.mapWith(Number) })
          .from(payments)
          .where(
            and(
              inArray(payments.status, NON_TERMINAL_PAYMENT_STATUSES),
              lt(payments.createdAt, olderThan)
            )
          ),
        storeFailure
      ).map((rows) => requireRow(rows[0], 'count(*) returned no row').unresolved);
    },
  };
}
