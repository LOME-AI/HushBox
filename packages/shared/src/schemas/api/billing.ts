import { z } from 'zod';

import { LEDGER_ENTRY_KINDS, PAYMENT_STATUSES } from '../../enums/billing-enums.ts';
import type { OwnerFundingLimit, UserTier } from '../../affordability/index.ts';

/**
 * Payment lifecycle statuses on the wire. Derives from the single shared
 * `PAYMENT_STATUSES` const, which also feeds the `payment_status` pgEnum
 * (`packages/db`) — the Pattern-D pre-claim lifecycle. Shared cannot import the
 * pgEnum (db depends on shared), so the const is the single source both sides
 * derive from.
 */
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/** TypeScript type for payment status */
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * Ledger-entry kinds on the wire. Derives from the single shared
 * `LEDGER_ENTRY_KINDS` const, which also feeds the `ledger_entry_kind` pgEnum
 * (`packages/db`) — the double-entry vocabulary. Shared cannot import the pgEnum
 * (db depends on shared), so the const is the single source both sides derive
 * from.
 */
export const ledgerEntryKindSchema = z.enum(LEDGER_ENTRY_KINDS);

/** TypeScript type for a ledger-entry kind */
export type LedgerEntryKind = z.infer<typeof ledgerEntryKindSchema>;

/**
 * Query schema for listing balance transactions.
 */
export const listTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  type: ledgerEntryKindSchema.optional(),
});

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

/**
 * Schema for the `GET /billing/balance` response. Money crosses the wire as
 * canonical NanoUSD strings (never floats). `purchased` is the paid,
 * negative-capable wallet that funds turns and gates admission; `free` is the
 * (always non-negative) free wallet; `allowance` is the free-tier daily
 * allowance for the current UTC day. The frontend derives display and gate
 * values through the NanoUSD helpers — it never coerces these strings to floats.
 */
export const getBalanceResponseSchema = z.object({
  purchased: z.object({ balanceNanoUsd: z.string() }),
  free: z.object({ balanceNanoUsd: z.string() }),
  allowance: z.object({
    day: z.string(),
    limitNanoUsd: z.string(),
    spentNanoUsd: z.string(),
    remainingNanoUsd: z.string(),
  }),
});

export type GetBalanceResponse = z.infer<typeof getBalanceResponseSchema>;

/**
 * The tier vocabulary on the wire, keyed by the shared `UserTier` union: the
 * `satisfies Record<UserTier, UserTier>` makes the object exhaustive at
 * compile time, so a new tier in the union fails typecheck here instead of
 * silently narrowing the wire.
 */
const USER_TIER_VALUES = {
  trial: 'trial',
  guest: 'guest',
  free: 'free',
  paid: 'paid',
} as const satisfies Record<UserTier, UserTier>;

/** Tier on the wire. Derived from the shared union, never a parallel list. */
export const userTierSchema = z.enum(USER_TIER_VALUES);

/**
 * The group dimensions on the wire, keyed by the shared `OwnerFundingLimit`
 * union so a dimension added there fails typecheck here.
 */
const OWNER_FUNDING_LIMIT_VALUES = {
  owner_balance: 'owner_balance',
  member_allocation: 'member_allocation',
  conversation_budget: 'conversation_budget',
} as const satisfies Record<OwnerFundingLimit, OwnerFundingLimit>;

/** Which dimension bounds an owner-funded turn. */
export const ownerFundingLimitSchema = z.enum(OWNER_FUNDING_LIMIT_VALUES);

/**
 * Query for `GET /billing/spendable`. The conversation is the context that
 * NAMES THE PAYER (BILLING §Group Funding 1): an owner-funded turn is priced
 * from the owner's funds at the owner's tier, so the composer must ask for the
 * numbers of the wallet that will actually pay. Absent for a solo composer,
 * whose payer is always the caller.
 */
export const getSpendableQuerySchema = z.object({
  conversationId: z.uuid().optional(),
});

export type GetSpendableQuery = z.infer<typeof getSpendableQuerySchema>;

/**
 * Schema for the payer's funding snapshot (BILLING §Affordability 1, §Data
 * Structures `FundingSnapshot`), served by `GET /billing/spendable` to a caller
 * who holds a wallet and by the conversation's guest funding read to a link
 * guest, who holds none. Two doors, one shape, one producer — a guest never
 * composes a funding figure from a second response.
 * `spendableNanoUsd` is hold-aware and complete for every tier — the number
 * admission would gate with when the payer is the caller, which is the
 * purchased wallet's spendable funds at the paid tier and the day's remaining
 * free allowance below it, so no surface has to compose a funding figure from a
 * second endpoint (it may be negative once holds exceed the funds behind it);
 * `heldNanoUsd` is what active holds subtracted, so `spendable + held`
 * reconstructs the hold-blind effective balance the picker greys on. `payerTier`
 * and `payer` identify WHOSE money those figures are: an owner-funded group turn
 * serves the owner's hold-aware group remaining at the owner's tier, not the
 * sender's — with the owner dimension priced as that wallet's spendable funds,
 * cushion included, exactly as every other dimension of every other tier is
 * (BILLING §Affordability 8). The owner wallet's own holds are not applied, so
 * an owner-funded figure may still exceed what admission admits and admission
 * then refuses outright (BILLING §Group Funding 7(b)). Money
 * crosses the wire as canonical NanoUSD strings, never floats. The per-wallet
 * concurrent-run cap is deliberately NOT served — it is enforced solely at
 * admission with its typed refusal. `ownerFundingLimit` names the dimension
 * the owner-funded figure comes from, and is `null` exactly when the caller pays.
 */
export const getSpendableResponseSchema = z
  .object({
    spendableNanoUsd: z.string(),
    heldNanoUsd: z.string(),
    payerTier: userTierSchema,
    payer: z.enum(['self', 'owner']),
    ownerFundingLimit: ownerFundingLimitSchema.nullable(),
  })
  .refine((snapshot) => (snapshot.payer === 'owner') === (snapshot.ownerFundingLimit !== null), {
    message: 'an owner payer names its binding limit, and a self payer names none',
    path: ['ownerFundingLimit'],
  });

export type GetSpendableResponse = z.infer<typeof getSpendableResponseSchema>;

/**
 * Schema for a balance transaction entity in API responses.
 * Usage (`charge`) transactions include model and character counts.
 * Deposit/clawback transactions have these fields as null.
 */
export const balanceTransactionResponseSchema = z.object({
  id: z.string(),
  amount: z.string(), // Signed decimal string
  balanceAfter: z.string(),
  type: ledgerEntryKindSchema,
  paymentId: z.string().nullable().optional(),
  // Usage transaction fields (null for deposit/clawback)
  model: z.string().nullable().optional(),
  inputCharacters: z.number().nullable().optional(),
  outputCharacters: z.number().nullable().optional(),
  createdAt: z.string(),
});

export type BalanceTransactionResponse = z.infer<typeof balanceTransactionResponseSchema>;

/**
 * Response schema for GET /billing/transactions.
 */
export const listTransactionsResponseSchema = z.object({
  transactions: z.array(balanceTransactionResponseSchema),
  nextCursor: z.string().nullable().optional(),
});

export type ListTransactionsResponse = z.infer<typeof listTransactionsResponseSchema>;
