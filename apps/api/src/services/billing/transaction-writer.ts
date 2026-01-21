import { eq, sql, and, ne } from 'drizzle-orm';
import { users, balanceTransactions, payments, type Database } from '@lome-chat/db';

export interface CreditBalanceParams {
  userId: string;
  amount: string;
  paymentId: string;
  transactionDetails?: {
    helcimTransactionId?: string;
    cardType?: string;
    cardLastFour?: string;
  };
  webhookReceivedAt?: Date;
}

export interface CreditBalanceResult {
  newBalance: string;
  transactionId: string;
}

export interface WebhookCreditParams {
  helcimTransactionId: string;
}

export interface WebhookCreditResult {
  newBalance: string;
  transactionId: string;
  paymentId: string;
}

/**
 * Process webhook credit by Helcim transaction ID.
 * Only claims payments in 'awaiting_webhook' status.
 * Returns null if payment already processed or not found.
 */
export async function processWebhookCredit(
  db: Database,
  params: WebhookCreditParams
): Promise<WebhookCreditResult | null> {
  return await db.transaction(async (tx) => {
    // Atomic idempotency: only claim payment if status is awaiting_webhook
    const [payment] = await tx
      .update(payments)
      .set({
        status: 'confirmed',
        webhookReceivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(payments.helcimTransactionId, params.helcimTransactionId),
          eq(payments.status, 'awaiting_webhook')
        )
      )
      .returning();

    if (!payment) {
      return null; // Already processed or not found
    }

    const [updatedUser] = await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${payment.amount}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, payment.userId))
      .returning({ balance: users.balance });

    if (!updatedUser) {
      throw new Error('Failed to update user balance');
    }

    const [transaction] = await tx
      .insert(balanceTransactions)
      .values({
        userId: payment.userId,
        amount: payment.amount,
        balanceAfter: updatedUser.balance,
        type: 'deposit',
        paymentId: payment.id,
      })
      .returning({ id: balanceTransactions.id });

    if (!transaction) {
      throw new Error('Failed to create balance transaction');
    }

    return {
      newBalance: updatedUser.balance,
      transactionId: transaction.id,
      paymentId: payment.id,
    };
  });
}

/**
 * Credits user balance atomically with idempotency.
 * Returns null if payment already confirmed (prevents double-credit).
 */
export async function creditUserBalance(
  db: Database,
  params: CreditBalanceParams
): Promise<CreditBalanceResult | null> {
  const { userId, amount, paymentId, transactionDetails, webhookReceivedAt } = params;

  return await db.transaction(async (tx) => {
    // Atomic idempotency: only update payment if not already confirmed
    const [claimedPayment] = await tx
      .update(payments)
      .set({
        status: 'confirmed',
        ...(transactionDetails?.helcimTransactionId && {
          helcimTransactionId: transactionDetails.helcimTransactionId,
        }),
        ...(transactionDetails?.cardType && { cardType: transactionDetails.cardType }),
        ...(transactionDetails?.cardLastFour && { cardLastFour: transactionDetails.cardLastFour }),
        ...(webhookReceivedAt && { webhookReceivedAt }),
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, paymentId), ne(payments.status, 'confirmed')))
      .returning({ id: payments.id });

    if (!claimedPayment) {
      return null; // Already confirmed
    }

    const [updatedUser] = await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${amount}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ balance: users.balance });

    if (!updatedUser) {
      throw new Error('Failed to update user balance');
    }

    const [transaction] = await tx
      .insert(balanceTransactions)
      .values({
        userId,
        amount,
        balanceAfter: updatedUser.balance,
        type: 'deposit',
        paymentId,
      })
      .returning({ id: balanceTransactions.id });

    if (!transaction) {
      throw new Error('Failed to create balance transaction');
    }

    return {
      newBalance: updatedUser.balance,
      transactionId: transaction.id,
    };
  });
}
