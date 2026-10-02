import { sql } from 'drizzle-orm';
import {
  conversationSpending,
  ledgerEntries,
  llmCompletions,
  memberBudgets,
  payments,
  usageRecords,
} from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createBillingStores } from './stores.js';
import type { Database } from '@hushbox/db';
import type { Modality } from '@hushbox/shared';
import type { SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * Dev/E2E producers for billing states the live settlement path cannot be
 * asked to produce: a persona's RICH history — completed card payments and
 * 90-day usage — and a payment parked mid-flight. The live path stamps `now`,
 * so it cannot mint 90-day-old rows, and its mock provider self-delivers the
 * confirming webhook, so it cannot leave a capture uncredited. These producers
 * therefore do timestamp-controlled DIRECT writes, but stay strictly
 * CONFORMANT: every ledger transaction is a signed leg pair summing to zero
 * (the deferred `ledger_entries_zero_sum` trigger rejects anything else), money
 * is nano-USD `bigint` throughout, and the wallet balance / `ledgerSeq` /
 * per-leg `balanceAfterNanoUsd` bookkeeping advances exactly as the real
 * settlement writers do (`creditPaymentWithinTx`, `chargeWithinTx`).
 *
 * The rich volume/model-mix/90-day spread is the caller's: producers faithfully
 * persist whatever specs they are given. Idempotency rides on caller-supplied
 * stable keys — a re-run finds the deterministic idempotency keys already
 * present and is a no-op (the anchor row's `created` flag gates every downstream
 * write, so the wallet balance never double-advances).
 *
 * They live in this slice, published on its barrel, because the tables they
 * write are billing's: seeding reaches them through the owner like every other
 * caller.
 */

export interface SeedBillingDeps {
  readonly db: Database;
}

/** One completed card payment plus its zero-sum deposit, backdated. */
export interface PaymentSpec {
  /** Stable arbitration key: the deposit's idempotency keys derive from it. */
  readonly stableKey: string;
  readonly amountNanoUsd: bigint;
  readonly cardType: string;
  readonly cardLastFour: string;
  readonly helcimTransactionId: string;
  /** Backdated timestamp stamped on the payment row and its ledger legs. */
  readonly createdAt: Date;
}

interface SeedPaymentsHistoryParams {
  readonly userId: string;
  readonly purchasedWalletId: string;
  readonly payments: readonly PaymentSpec[];
}

interface SeedPaymentsHistoryResult {
  /** Payments actually inserted (0 on a full idempotent re-run). */
  readonly paymentsCreated: number;
  readonly finalBalanceNanoUsd: bigint;
}

/** The language token dimension written to `llm_completions` for a text charge. */
export interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
}

/** One settled usage record plus its zero-sum charge, backdated. */
export interface UsageSpec {
  /** Stable arbitration key: the usage/charge idempotency keys derive from it. */
  readonly stableKey: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: Modality;
  /** Already-billable model cost; charged as-is, mirroring `chargeWithinTx`. */
  readonly billableCostNanoUsd: bigint;
  /** Additive storage fee, charged on top and NEVER marked up. Defaults to 0. */
  readonly storageFeeNanoUsd?: bigint;
  readonly isEstimated?: boolean;
  readonly generationId?: string;
  /** The settlement anchor content item; null is legal for seed history. */
  readonly contentItemId?: string | null;
  /** Present for a `text` charge → one `llm_completions` row. */
  readonly tokens?: UsageTokens;
  /** Optional group attribution → durable cumulative `member_budgets` row. */
  readonly memberBudget?: { readonly memberId: string; readonly budgetNanoUsd: bigint };
  /**
   * Who SENT the turn, when the caller wants the sender recorded beside the
   * payer. Omitted, the row carries a payer and no sender — which is what the
   * analytics ladder reads as an account that never sent anything.
   */
  readonly senderUserId?: string;
  /** Backdated timestamp stamped on the usage record and its ledger legs. */
  readonly createdAt: Date;
}

interface SeedUsageHistoryParams {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  readonly records: readonly UsageSpec[];
}

interface SeedUsageHistoryResult {
  /** Usage records actually inserted (0 on a full idempotent re-run). */
  readonly usageRecordsCreated: number;
  readonly totalChargedNanoUsd: bigint;
  readonly finalBalanceNanoUsd: bigint;
}

/** The billable model cost plus the additive (never-marked-up) storage fee. */
function chargedAmount(billableCostNanoUsd: bigint, storageFeeNanoUsd: bigint): bigint {
  return billableCostNanoUsd + storageFeeNanoUsd;
}

/**
 * Backdated completed payments, each with a conformant deposit leg pair
 * (user purchased wallet ↔ `payments-in` house account). Mirrors
 * `creditPaymentWithinTx`'s leg structure, adding the explicit backdated
 * `createdAt` the store writers cannot set. Runs in one settlement transaction
 * so the deferred zero-sum trigger validates every group at commit.
 */
export async function seedPaymentsHistory(
  deps: SeedBillingDeps,
  params: SeedPaymentsHistoryParams
): Promise<SeedPaymentsHistoryResult> {
  const stores = createBillingStores();
  return runSettlement(deps.db, async (tx: SettlementTx) => {
    const wallet = await stores.lockWalletWithinTx(tx, params.purchasedWalletId);
    let balance = wallet.balanceNanoUsd;
    let ledgerSeq = wallet.ledgerSeq;
    let created = 0;

    for (const spec of params.payments) {
      const inserted = await tx
        .insert(payments)
        .values({
          userId: params.userId,
          amountNanoUsd: spec.amountNanoUsd,
          status: 'completed',
          idempotencyKey: `seed:pay:${params.userId}:${spec.stableKey}`,
          helcimTransactionId: spec.helcimTransactionId,
          cardType: spec.cardType,
          cardLastFour: spec.cardLastFour,
          createdAt: spec.createdAt,
          updatedAt: spec.createdAt,
          webhookReceivedAt: spec.createdAt,
        })
        .onConflictDoNothing({ target: payments.idempotencyKey })
        .returning({ id: payments.id });
      const paymentRow = inserted[0];
      if (paymentRow === undefined) continue;
      created += 1;

      balance += spec.amountNanoUsd;
      ledgerSeq += 1n;
      const transactionId = crypto.randomUUID();
      await tx.insert(ledgerEntries).values([
        {
          transactionId,
          kind: 'deposit',
          amountNanoUsd: spec.amountNanoUsd,
          balanceAfterNanoUsd: balance,
          walletId: wallet.id,
          paymentId: paymentRow.id,
          idempotencyKey: `seed:deposit:${params.userId}:${spec.stableKey}:user`,
          createdAt: spec.createdAt,
        },
        {
          transactionId,
          kind: 'deposit',
          amountNanoUsd: -spec.amountNanoUsd,
          houseAccount: 'payments-in',
          paymentId: paymentRow.id,
          idempotencyKey: `seed:deposit:${params.userId}:${spec.stableKey}:house`,
          createdAt: spec.createdAt,
        },
      ]);
    }

    if (created > 0) {
      await stores.updateWalletBalanceWithinTx(tx, wallet.id, balance, ledgerSeq);
    }
    return { paymentsCreated: created, finalBalanceNanoUsd: balance };
  });
}

/** One captured-but-uncredited payment, as the dev seam asks for it. */
interface AwaitingWebhookPaymentSpec {
  readonly userId: string;
  readonly amountNanoUsd: bigint;
  /** Arbitration key on the row; callers mint a fresh one per payment. */
  readonly stableKey: string;
  /** The capture handle the provider would name in its confirming webhook. */
  readonly helcimTransactionId: string;
}

/**
 * A payment row parked at `awaiting_webhook` with NO ledger legs behind it:
 * the card was captured and the wallet was never credited. That is the state
 * the reconciler cannot resolve on its own and the operator's payment
 * resolve operations exist to repair, so the admin surfaces need a way to
 * reach it — and the live path cannot hold a row there, since the mock
 * provider confirms its own charge within seconds.
 *
 * It writes no ledger legs by design: legs are exactly what the row is
 * missing. Nothing here is idempotent because nothing repeats — the caller
 * mints a fresh key per row, and a reused one hits the unique constraint
 * rather than silently returning someone else's payment.
 */
export async function seedAwaitingWebhookPayment(
  deps: SeedBillingDeps,
  spec: AwaitingWebhookPaymentSpec
): Promise<{ readonly paymentId: string; readonly amountNanoUsd: bigint }> {
  const [row] = await deps.db
    .insert(payments)
    .values({
      userId: spec.userId,
      amountNanoUsd: spec.amountNanoUsd,
      status: 'awaiting_webhook',
      idempotencyKey: spec.stableKey,
      helcimTransactionId: spec.helcimTransactionId,
      cardType: 'VISA',
      cardLastFour: '4242',
    })
    .returning({ id: payments.id, amountNanoUsd: payments.amountNanoUsd });
  /* v8 ignore next 3 -- an insert with no conflict clause either returns its
     row or throws; the empty-array arm exists only to narrow the type. */
  if (row === undefined) {
    throw new Error('seed awaiting-webhook payment: insert returned no row');
  }
  return { paymentId: row.id, amountNanoUsd: row.amountNanoUsd };
}

/** Per-member cumulative charge accrual collected while walking the records. */
interface MemberAccrual {
  readonly budgetNanoUsd: bigint;
  spentNanoUsd: bigint;
}

/** Running wallet bookkeeping carried record-to-record through the walk. */
interface ChargeCursor {
  balanceNanoUsd: bigint;
  ledgerSeq: bigint;
}

/** One `usage_records` row as a seed spec describes it. */
function usageRowValues(
  params: SeedUsageHistoryParams,
  spec: UsageSpec,
  charged: bigint
): typeof usageRecords.$inferInsert {
  return {
    // Seeded history is a solo user's own spend: they are the payer, and the
    // charge legs below debit their wallet.
    payerUserId: params.userId,
    ...(spec.senderUserId === undefined ? {} : { senderUserId: spec.senderUserId }),
    contentItemId: spec.contentItemId ?? null,
    runId: crypto.randomUUID(),
    conversationId: params.conversationId,
    modelId: spec.modelId,
    providerName: spec.providerName,
    modality: spec.modality,
    ...(spec.generationId === undefined ? {} : { generationId: spec.generationId }),
    costNanoUsd: charged,
    isEstimated: spec.isEstimated ?? false,
    idempotencyKey: `seed:usage:${params.userId}:${spec.stableKey}`,
    createdAt: spec.createdAt,
  };
}

/**
 * Writes one usage record and, only when it was freshly inserted, its
 * `llm_completions` dimension (text) and the conformant charge leg pair (user
 * wallet debit ↔ `revenue` house credit) — mirroring `chargeWithinTx`. Advances
 * `cursor` in place on a fresh insert and returns the charged amount; returns
 * null on an idempotent replay (the deterministic key already present), leaving
 * the cursor untouched so the wallet balance never double-advances.
 */
async function writeSeedUsageChargeWithinTx(
  tx: SettlementTx,
  params: SeedUsageHistoryParams,
  spec: UsageSpec,
  cursor: ChargeCursor
): Promise<bigint | null> {
  const charged = chargedAmount(spec.billableCostNanoUsd, spec.storageFeeNanoUsd ?? 0n);
  const inserted = await tx
    .insert(usageRecords)
    .values(usageRowValues(params, spec, charged))
    .onConflictDoNothing({ target: usageRecords.idempotencyKey })
    .returning({ id: usageRecords.id });
  const usageRow = inserted[0];
  if (usageRow === undefined) return null;

  if (spec.modality === 'text' && spec.tokens !== undefined) {
    await tx.insert(llmCompletions).values({
      usageRecordId: usageRow.id,
      inputTokens: spec.tokens.inputTokens,
      outputTokens: spec.tokens.outputTokens,
      reasoningTokens: spec.tokens.reasoningTokens ?? 0,
      cachedInputTokens: spec.tokens.cachedInputTokens ?? 0,
    });
  }

  cursor.balanceNanoUsd -= charged;
  cursor.ledgerSeq += 1n;
  const transactionId = crypto.randomUUID();
  await tx.insert(ledgerEntries).values([
    {
      transactionId,
      kind: 'charge',
      amountNanoUsd: -charged,
      balanceAfterNanoUsd: cursor.balanceNanoUsd,
      walletId: params.walletId,
      usageRecordId: usageRow.id,
      idempotencyKey: `seed:charge:${params.userId}:${spec.stableKey}:user`,
      createdAt: spec.createdAt,
    },
    {
      transactionId,
      kind: 'charge',
      amountNanoUsd: charged,
      houseAccount: 'revenue',
      usageRecordId: usageRow.id,
      idempotencyKey: `seed:charge:${params.userId}:${spec.stableKey}:house`,
      createdAt: spec.createdAt,
    },
  ]);
  return charged;
}

/** Accumulates a fresh charge into its member's cap-preserving accrual. */
function accrueMemberSpend(
  accruals: Map<string, MemberAccrual>,
  memberBudget: NonNullable<UsageSpec['memberBudget']>,
  charged: bigint
): void {
  const accrual = accruals.get(memberBudget.memberId) ?? {
    budgetNanoUsd: memberBudget.budgetNanoUsd,
    spentNanoUsd: 0n,
  };
  accrual.spentNanoUsd += charged;
  accruals.set(memberBudget.memberId, accrual);
}

/**
 * Upserts the durable cumulative spending rows (per conversation, per member),
 * adding this batch's freshly-charged deltas. The owner-set member cap rides
 * only the insert path; a re-run adds 0 and never clobbers an existing cap.
 */
async function applyCumulativeSpendingWithinTx(
  tx: SettlementTx,
  conversationId: string,
  conversationDelta: bigint,
  memberAccruals: ReadonlyMap<string, MemberAccrual>
): Promise<void> {
  await tx
    .insert(conversationSpending)
    .values({ conversationId, spentNanoUsd: conversationDelta })
    .onConflictDoUpdate({
      target: conversationSpending.conversationId,
      set: {
        spentNanoUsd: sql`${conversationSpending.spentNanoUsd} + ${conversationDelta}`,
        updatedAt: sql`now()`,
      },
    });
  for (const [memberId, accrual] of memberAccruals) {
    await tx
      .insert(memberBudgets)
      .values({
        memberId,
        budgetNanoUsd: accrual.budgetNanoUsd,
        spentNanoUsd: accrual.spentNanoUsd,
      })
      .onConflictDoUpdate({
        target: memberBudgets.memberId,
        set: {
          spentNanoUsd: sql`${memberBudgets.spentNanoUsd} + ${accrual.spentNanoUsd}`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/**
 * Backdated usage history: one `usage_records` row (plus its `llm_completions`
 * dimension for text) and a conformant charge leg pair per record, mirroring
 * `chargeWithinTx`, then the durable cumulative `conversation_spending` and
 * `member_budgets` rows exactly as settlement accrues them. Each record's charge
 * is the marked-up base cost plus the additive storage fee; the wallet balance
 * and `ledgerSeq` advance per record (negative balances are legal). Runs in one
 * settlement transaction so the deferred zero-sum trigger validates every group
 * at commit.
 */
export async function seedUsageHistory(
  deps: SeedBillingDeps,
  params: SeedUsageHistoryParams
): Promise<SeedUsageHistoryResult> {
  const stores = createBillingStores();
  return runSettlement(deps.db, async (tx: SettlementTx) => {
    const wallet = await stores.lockWalletWithinTx(tx, params.walletId);
    const cursor: ChargeCursor = {
      balanceNanoUsd: wallet.balanceNanoUsd,
      ledgerSeq: wallet.ledgerSeq,
    };
    let created = 0;
    let totalCharged = 0n;
    let conversationDelta = 0n;
    const memberAccruals = new Map<string, MemberAccrual>();

    for (const spec of params.records) {
      const charged = await writeSeedUsageChargeWithinTx(tx, params, spec, cursor);
      if (charged === null) continue;
      created += 1;
      totalCharged += charged;
      conversationDelta += charged;
      if (spec.memberBudget !== undefined) {
        accrueMemberSpend(memberAccruals, spec.memberBudget, charged);
      }
    }

    if (created > 0) {
      await stores.updateWalletBalanceWithinTx(
        tx,
        wallet.id,
        cursor.balanceNanoUsd,
        cursor.ledgerSeq
      );
      await applyCumulativeSpendingWithinTx(
        tx,
        params.conversationId,
        conversationDelta,
        memberAccruals
      );
    }

    return {
      usageRecordsCreated: created,
      totalChargedNanoUsd: totalCharged,
      finalBalanceNanoUsd: cursor.balanceNanoUsd,
    };
  });
}
