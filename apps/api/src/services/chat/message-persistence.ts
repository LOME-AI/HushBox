import { eq, sql } from 'drizzle-orm';
import { users, balanceTransactions, messages, type Database } from '@lome-chat/db';
import type { StoredDeductionSource } from '@lome-chat/shared';

export interface SaveMessageWithBillingParams {
  messageId: string;
  conversationId: string;
  content: string;
  model: string;
  userId: string;
  totalCost: number;
  inputCharacters: number;
  outputCharacters: number;
  deductionSource?: StoredDeductionSource;
}

export interface SaveMessageWithBillingResult {
  message: typeof messages.$inferSelect;
  transactionId: string;
  totalCharge: number;
  newBalance: string;
}

/**
 * Atomically saves message and bills user in single transaction.
 * If any step fails, entire operation rolls back - no partial state.
 *
 * Cost must be pre-calculated before calling this function.
 */
export async function saveMessageWithBilling(
  db: Database,
  params: SaveMessageWithBillingParams
): Promise<SaveMessageWithBillingResult> {
  const {
    messageId,
    conversationId,
    content,
    model,
    userId,
    totalCost,
    inputCharacters,
    outputCharacters,
    deductionSource = 'balance',
  } = params;

  const costAmount = totalCost.toFixed(8);
  const chargeAmount = (-totalCost).toFixed(8);
  // Use string with 8 decimal precision for fractional cents support
  const chargeCents = (totalCost * 100).toFixed(8);
  const transactionId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    // 1. Insert message with cost already set
    const [message] = await tx
      .insert(messages)
      .values({
        id: messageId,
        conversationId,
        role: 'assistant',
        content,
        model,
        cost: costAmount,
      })
      .returning();

    if (!message) {
      throw new Error('Failed to insert message');
    }

    // 2. Update user balance or free allowance
    let newBalance: string;

    if (deductionSource === 'freeAllowance') {
      // Deduct from free allowance (in cents)
      const [updatedUser] = await tx
        .update(users)
        .set({
          freeAllowanceCents: sql`${users.freeAllowanceCents} - ${chargeCents}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ balance: users.balance });

      if (!updatedUser) {
        throw new Error('Failed to update user free allowance');
      }

      newBalance = updatedUser.balance;
    } else {
      // Deduct from primary balance (in dollars)
      const [updatedUser] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} + ${chargeAmount}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ balance: users.balance });

      if (!updatedUser) {
        throw new Error('Failed to update user balance');
      }

      newBalance = updatedUser.balance;
    }

    // 3. Insert balance transaction
    await tx.insert(balanceTransactions).values({
      id: transactionId,
      userId,
      amount: chargeAmount,
      balanceAfter: newBalance,
      type: 'usage',
      model,
      inputCharacters,
      outputCharacters,
      deductionSource,
    });

    // 4. Link message to transaction
    await tx
      .update(messages)
      .set({ balanceTransactionId: transactionId })
      .where(eq(messages.id, messageId));

    return {
      message,
      transactionId,
      totalCharge: totalCost,
      newBalance,
    };
  });
}
