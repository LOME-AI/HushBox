import { and, eq, sql } from 'drizzle-orm';
import { allowanceSpending, conversationSpending, memberBudgets } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { storeFailure } from './store-failure.js';
import type { Database } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingStores, SpendingUpsert } from '../ports/index.js';

/**
 * The allowance and budget part of the slice's repository: the cumulative
 * spending rows settlement adds to, the caps an owner sets, and the reads
 * admission checks them against.
 */
export function createBudgetStores(): Pick<
  BillingStores,
  | 'addSpendingWithinTx'
  | 'readAllowanceSpent'
  | 'readMemberBudget'
  | 'readConversationSpent'
  | 'setMemberBudgetCapWithinTx'
  | 'deleteMemberBudgetWithinTx'
  | 'lockConversationSpentWithinTx'
> {
  return {
    async addSpendingWithinTx(tx: SettlementTx, upsert: SpendingUpsert, amountNanoUsd: bigint) {
      if (upsert.scope === 'allowance') {
        await tx
          .insert(allowanceSpending)
          .values({ userId: upsert.userId, day: upsert.day, spentNanoUsd: amountNanoUsd })
          .onConflictDoUpdate({
            target: [allowanceSpending.userId, allowanceSpending.day],
            set: {
              spentNanoUsd: sql`${allowanceSpending.spentNanoUsd} + ${amountNanoUsd}`,
              updatedAt: sql`now()`,
            },
          });
        return;
      }
      if (upsert.scope === 'member') {
        // The durable owner-set cap is written only on the insert path; a spend
        // upsert accrues spent and must NOT clobber an existing cap.
        await tx
          .insert(memberBudgets)
          .values({
            memberId: upsert.memberId,
            budgetNanoUsd: upsert.budgetNanoUsd,
            spentNanoUsd: amountNanoUsd,
          })
          .onConflictDoUpdate({
            target: [memberBudgets.memberId],
            set: {
              spentNanoUsd: sql`${memberBudgets.spentNanoUsd} + ${amountNanoUsd}`,
              updatedAt: sql`now()`,
            },
          });
        return;
      }
      await tx
        .insert(conversationSpending)
        .values({
          conversationId: upsert.conversationId,
          spentNanoUsd: amountNanoUsd,
        })
        .onConflictDoUpdate({
          target: [conversationSpending.conversationId],
          set: {
            spentNanoUsd: sql`${conversationSpending.spentNanoUsd} + ${amountNanoUsd}`,
            updatedAt: sql`now()`,
          },
        });
    },

    readAllowanceSpent(db: Database, userId: string, day: string) {
      return fromPromise(
        db
          .select({ spentNanoUsd: allowanceSpending.spentNanoUsd })
          .from(allowanceSpending)
          .where(and(eq(allowanceSpending.userId, userId), eq(allowanceSpending.day, day))),
        storeFailure
      ).map((rows) => rows[0]?.spentNanoUsd ?? 0n);
    },

    readMemberBudget(db: Database, memberId: string) {
      return fromPromise(
        db
          .select({
            budgetNanoUsd: memberBudgets.budgetNanoUsd,
            spentNanoUsd: memberBudgets.spentNanoUsd,
          })
          .from(memberBudgets)
          .where(eq(memberBudgets.memberId, memberId)),
        storeFailure
      ).map((rows) => rows[0] ?? null);
    },

    readConversationSpent(db: Database, conversationId: string) {
      return fromPromise(
        db
          .select({ spentNanoUsd: conversationSpending.spentNanoUsd })
          .from(conversationSpending)
          .where(eq(conversationSpending.conversationId, conversationId)),
        storeFailure
      ).map((rows) => rows[0]?.spentNanoUsd ?? 0n);
    },

    setMemberBudgetCapWithinTx(tx, memberId, capNanoUsd) {
      // Upsert the owner-set cap only; spentNanoUsd defaults to 0 on the insert
      // path and is untouched on conflict, so a cap change never clobbers the
      // cumulative spend the settlement writer accrues. The conflict path is
      // WHERE-guarded (`spent <= new cap`) and the statement RETURNs the row it
      // wrote: zero rows back means the guard refused — a cap below the
      // accrued spend — with the stored row untouched. Atomic by construction:
      // the guard and the write are one statement, never check-then-act.
      return fromPromise(
        tx
          .insert(memberBudgets)
          .values({ memberId, budgetNanoUsd: capNanoUsd })
          .onConflictDoUpdate({
            target: [memberBudgets.memberId],
            set: { budgetNanoUsd: capNanoUsd, updatedAt: sql`now()` },
            setWhere: sql`${memberBudgets.spentNanoUsd} <= ${capNanoUsd}`,
          })
          .returning({ memberId: memberBudgets.memberId }),
        storeFailure
      ).map((rows): 'applied' | 'below-spent' => (rows.length > 0 ? 'applied' : 'below-spent'));
    },

    deleteMemberBudgetWithinTx(tx, memberId) {
      // Absent row = already done (the idempotent no-op) — no rows-affected
      // assertion, matching at-least-once retry semantics.
      return fromPromise(
        tx.delete(memberBudgets).where(eq(memberBudgets.memberId, memberId)),
        storeFailure
      ).map((): void => undefined);
    },

    lockConversationSpentWithinTx(tx, conversationId) {
      // Materialize a zero-spend row when none exists (row absence already
      // means "spent 0" to every reader), then read it FOR UPDATE so the
      // caller's cap-vs-spend validation holds the same lock a concurrent
      // settlement's spending upsert needs — serializing the two. Lock order
      // (spending row, then the conversations row the caller updates) matches
      // settlement's, so no deadlock is possible.
      return fromPromise(
        tx
          .insert(conversationSpending)
          .values({ conversationId, spentNanoUsd: 0n })
          .onConflictDoNothing({ target: [conversationSpending.conversationId] }),
        storeFailure
      )
        .andThen(() =>
          fromPromise(
            tx
              .select({ spentNanoUsd: conversationSpending.spentNanoUsd })
              .from(conversationSpending)
              .where(eq(conversationSpending.conversationId, conversationId))
              .for('update'),
            storeFailure
          )
        )
        .map((rows) => {
          const row = rows[0];
          /* v8 ignore next -- unreachable: the upsert above materializes the row inside this transaction, so the locked read always finds it; the fallback only satisfies the indexed-access type */
          if (row === undefined) return 0n;
          return row.spentNanoUsd;
        });
    },
  };
}
