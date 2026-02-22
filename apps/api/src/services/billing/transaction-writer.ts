import { eq, sql, and, inArray } from 'drizzle-orm';
import {
  wallets,
  ledgerEntries,
  payments,
  usageRecords,
  llmCompletions,
  type Database,
} from '@hushbox/db';

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
  ledgerEntryId: string;
}

export interface WebhookCreditParams {
  helcimTransactionId: string;
}

export interface WebhookCreditResult {
  newBalance: string;
  ledgerEntryId: string;
  paymentId: string;
}

export interface ChargeForUsageParams {
  userId: string;
  cost: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number | undefined;
  sourceType: string;
  sourceId: string;
}

export interface ChargeResult {
  usageRecordId: string;
  walletId: string;
  walletType: string;
  newBalance: string;
}

/**
 * Process webhook credit by Helcim transaction ID.
 * Only claims payments in 'awaiting_webhook' status.
 * Credits the user's purchased wallet and creates a ledger entry.
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
        status: 'completed',
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
      return null;
    }

    if (!payment.userId) {
      throw new Error('Payment has no associated user');
    }

    // Credit the purchased wallet
    const [updatedWallet] = await tx
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} + ${payment.amount}::numeric`,
      })
      .where(and(eq(wallets.userId, payment.userId), eq(wallets.type, 'purchased')))
      .returning({ id: wallets.id, balance: wallets.balance });

    if (!updatedWallet) {
      throw new Error('Failed to update wallet balance');
    }

    // Create ledger entry for the deposit
    const [ledgerEntry] = await tx
      .insert(ledgerEntries)
      .values({
        walletId: updatedWallet.id,
        amount: payment.amount,
        balanceAfter: updatedWallet.balance,
        entryType: 'deposit',
        paymentId: payment.id,
      })
      .returning({ id: ledgerEntries.id });

    if (!ledgerEntry) {
      throw new Error('Failed to create ledger entry');
    }

    return {
      newBalance: updatedWallet.balance,
      ledgerEntryId: ledgerEntry.id,
      paymentId: payment.id,
    };
  });
}

function buildPaymentUpdate(
  transactionDetails?: CreditBalanceParams['transactionDetails'],
  webhookReceivedAt?: Date
): Record<string, unknown> {
  return {
    status: 'completed' as const,
    ...(transactionDetails?.helcimTransactionId && {
      helcimTransactionId: transactionDetails.helcimTransactionId,
    }),
    ...(transactionDetails?.cardType && { cardType: transactionDetails.cardType }),
    ...(transactionDetails?.cardLastFour && { cardLastFour: transactionDetails.cardLastFour }),
    ...(webhookReceivedAt && { webhookReceivedAt }),
    updatedAt: new Date(),
  };
}

/**
 * Credit user's purchased wallet balance from a payment deposit.
 * Idempotent: only claims payments in 'pending' or 'awaiting_webhook' status.
 * Failed/refunded payments cannot be re-claimed. Returns null if already completed.
 */
export async function creditUserBalance(
  db: Database,
  params: CreditBalanceParams
): Promise<CreditBalanceResult | null> {
  const { userId, amount, paymentId, transactionDetails, webhookReceivedAt } = params;

  return await db.transaction(async (tx) => {
    // Atomic idempotency: only claim payments in claimable states.
    // Failed/refunded payments must NOT be re-claimable as completed.
    const [claimedPayment] = await tx
      .update(payments)
      .set(buildPaymentUpdate(transactionDetails, webhookReceivedAt))
      .where(
        and(eq(payments.id, paymentId), inArray(payments.status, ['pending', 'awaiting_webhook']))
      )
      .returning({ id: payments.id });

    if (!claimedPayment) {
      return null;
    }

    // Credit the purchased wallet
    const [updatedWallet] = await tx
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} + ${amount}::numeric`,
      })
      .where(and(eq(wallets.userId, userId), eq(wallets.type, 'purchased')))
      .returning({ id: wallets.id, balance: wallets.balance });

    if (!updatedWallet) {
      throw new Error('Failed to update wallet balance');
    }

    // Create ledger entry for the deposit
    const [ledgerEntry] = await tx
      .insert(ledgerEntries)
      .values({
        walletId: updatedWallet.id,
        amount,
        balanceAfter: updatedWallet.balance,
        entryType: 'deposit',
        paymentId,
      })
      .returning({ id: ledgerEntries.id });

    if (!ledgerEntry) {
      throw new Error('Failed to create ledger entry');
    }

    return {
      newBalance: updatedWallet.balance,
      ledgerEntryId: ledgerEntry.id,
    };
  });
}

/**
 * Charge a user for LLM usage. Walks wallets in priority order
 * and debits the first with sufficient balance.
 *
 * Atomic transaction:
 * 1. INSERT usage_records (pending)
 * 2. INSERT llm_completions
 * 3. Query wallets by priority, find first with sufficient balance
 * 4. Atomic: UPDATE wallets SET balance = balance - cost WHERE balance >= cost
 * 5. INSERT ledger_entries
 * 6. UPDATE usage_records SET status='completed'
 *
 * If no wallet has sufficient balance: marks usage_record as 'failed', throws error.
 */
export async function chargeForUsage(
  db: Database,
  params: ChargeForUsageParams
): Promise<ChargeResult> {
  const {
    userId,
    cost,
    model,
    provider,
    inputTokens,
    outputTokens,
    cachedTokens = 0,
    sourceType,
    sourceId,
  } = params;

  return await db.transaction(async (tx) => {
    // Step 1: Insert usage record (pending)
    const [usageRecord] = await tx
      .insert(usageRecords)
      .values({
        userId,
        type: 'llm_completion',
        status: 'pending',
        cost,
        sourceType,
        sourceId,
      })
      .returning({ id: usageRecords.id });

    if (!usageRecord) {
      throw new Error('Failed to create usage record');
    }

    // Step 2: Insert LLM completion details
    await tx
      .insert(llmCompletions)
      .values({
        usageRecordId: usageRecord.id,
        model,
        provider,
        inputTokens,
        outputTokens,
        cachedTokens,
      })
      .returning({ id: llmCompletions.id });

    // Step 3: Query wallets ordered by priority
    const walletRows = await tx
      .select({
        id: wallets.id,
        type: wallets.type,
        balance: wallets.balance,
        priority: wallets.priority,
      })
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .orderBy(wallets.priority);

    // Step 4: Try each wallet in priority order
    let chargedWallet: { id: string; type: string; balance: string } | null = null;

    for (const wallet of walletRows) {
      // Atomic debit: only succeeds if balance >= cost
      const [updated] = await tx
        .update(wallets)
        .set({
          balance: sql`${wallets.balance} - ${cost}::numeric`,
        })
        .where(and(eq(wallets.id, wallet.id), sql`${wallets.balance} >= ${cost}::numeric`))
        .returning({ id: wallets.id, balance: wallets.balance });

      if (updated) {
        chargedWallet = { id: updated.id, type: wallet.type, balance: updated.balance };
        break;
      }
    }

    // No wallet had sufficient balance
    if (!chargedWallet) {
      // Mark usage record as failed
      await tx
        .update(usageRecords)
        .set({ status: 'failed' })
        .where(eq(usageRecords.id, usageRecord.id))
        .returning({ id: usageRecords.id });

      throw new Error('Insufficient balance');
    }

    // Step 5: Insert ledger entry
    await tx
      .insert(ledgerEntries)
      .values({
        walletId: chargedWallet.id,
        amount: `-${cost}`,
        balanceAfter: chargedWallet.balance,
        entryType: 'usage_charge',
        usageRecordId: usageRecord.id,
      })
      .returning({ id: ledgerEntries.id });

    // Step 6: Mark usage record as completed
    await tx
      .update(usageRecords)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(usageRecords.id, usageRecord.id))
      .returning({ id: usageRecords.id });

    return {
      usageRecordId: usageRecord.id,
      walletId: chargedWallet.id,
      walletType: chargedWallet.type,
      newBalance: chargedWallet.balance,
    };
  });
}
