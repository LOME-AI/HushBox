import { eq, sql } from 'drizzle-orm';
import { users, balanceTransactions, messages, type Database } from '@lome-chat/db';
import { calculateMessageCostFromOpenRouter, type DeductionSource } from '@lome-chat/shared';
import type { GenerationStats } from '../openrouter/types.js';

export interface MessageBillingParams {
  userId: string;
  messageId: string;
  model: string;
  generationStats: GenerationStats;
  inputCharacters: number;
  outputCharacters: number;
  /** Which balance to deduct from (defaults to 'balance' for backward compatibility) */
  deductionSource?: DeductionSource;
}

export interface MessageBillingResult {
  transactionId: string;
  totalCharge: number;
  newBalance: string;
}

/**
 * Bill user for a message after successful generation.
 * Uses calculateMessageCostFromOpenRouter for consistent pricing.
 * Creates balance transaction and updates message with cost in atomic transaction.
 */
export async function billMessage(
  db: Database,
  params: MessageBillingParams
): Promise<MessageBillingResult> {
  const {
    userId,
    messageId,
    model,
    generationStats,
    inputCharacters,
    outputCharacters,
    deductionSource = 'balance',
  } = params;

  // Use central pricing function
  const totalCharge = calculateMessageCostFromOpenRouter({
    openRouterCost: generationStats.total_cost,
    inputCharacters,
    outputCharacters,
  });

  // Format as string with 8 decimal places (negative for debit)
  const chargeAmount = (-totalCharge).toFixed(8);
  const costAmount = totalCharge.toFixed(8);

  // Convert to cents for free allowance (integer column)
  const chargeCents = Math.round(totalCharge * 100);

  const transactionId = crypto.randomUUID();

  // Atomic transaction: update balance, create transaction, update message with cost
  const result = await db.transaction(async (tx) => {
    let newBalance: string;

    if (deductionSource === 'freeAllowance') {
      // Deduct from free allowance (integer cents column)
      const [updatedUser] = await tx
        .update(users)
        .set({
          freeAllowanceCents: sql`${users.freeAllowanceCents} - ${chargeCents}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ balance: users.balance, freeAllowanceCents: users.freeAllowanceCents });

      if (!updatedUser) {
        throw new Error('Failed to update user free allowance');
      }

      // Balance unchanged, but we need it for the transaction record
      newBalance = updatedUser.balance;
    } else {
      // Deduct from primary balance (numeric column)
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

    // 2. Create balance transaction record
    const sourceNote = deductionSource === 'freeAllowance' ? ' (free allowance)' : '';
    await tx.insert(balanceTransactions).values({
      id: transactionId,
      userId,
      amount: chargeAmount,
      balanceAfter: newBalance,
      type: 'usage',
      description: `AI response: ${model} (${String(generationStats.native_tokens_prompt)}+${String(generationStats.native_tokens_completion)} tokens, ${String(inputCharacters + outputCharacters)} chars)${sourceNote}`,
    });

    // 3. Update message with cost AND transaction link
    await tx
      .update(messages)
      .set({
        cost: costAmount,
        balanceTransactionId: transactionId,
      })
      .where(eq(messages.id, messageId));

    return { newBalance };
  });

  return {
    transactionId,
    totalCharge,
    newBalance: result.newBalance,
  };
}
