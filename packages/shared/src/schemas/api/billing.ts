import { z } from 'zod';
import {
  paymentStatusSchema,
  balanceTransactionTypeSchema,
  type PaymentStatus,
  type BalanceTransactionType,
} from '../../enums.js';

// Re-export enums for API schema consumers
export { paymentStatusSchema, balanceTransactionTypeSchema };
export type { PaymentStatus, BalanceTransactionType };

// ============================================================
// Request Schemas
// ============================================================

/**
 * Request schema for creating a payment.
 * Amount must be at least $5.00 (stored as decimal string with 8 decimal places).
 */
export const createPaymentRequestSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+\.\d{8}$/, 'Amount must be a decimal with 8 decimal places (e.g., "10.00000000")')
    .refine((val) => parseFloat(val) >= 5, 'Minimum deposit is $5.00'),
});

export type CreatePaymentRequest = z.infer<typeof createPaymentRequestSchema>;

/**
 * Request schema for processing a payment with a card token.
 * customerCode is required as Helcim links card tokens to customers.
 */
export const processPaymentRequestSchema = z.object({
  cardToken: z.string().min(1, 'Card token is required'),
  customerCode: z.string().min(1, 'Customer code is required'),
});

export type ProcessPaymentRequest = z.infer<typeof processPaymentRequestSchema>;

/**
 * Query schema for listing balance transactions.
 */
export const listTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  type: balanceTransactionTypeSchema.optional(),
});

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

// ============================================================
// Response Schemas
// ============================================================

/**
 * Schema for balance response.
 * Returns user's primary balance and free daily allowance for budget calculation.
 */
export const getBalanceResponseSchema = z.object({
  /** Primary balance in USD with 8 decimal precision */
  balance: z.string(),
  /** Free daily allowance remaining in cents */
  freeAllowanceCents: z.number(),
});

export type GetBalanceResponse = z.infer<typeof getBalanceResponseSchema>;

/**
 * Schema for a payment entity in API responses.
 */
export const paymentResponseSchema = z.object({
  id: z.string(),
  amount: z.string(),
  status: paymentStatusSchema,
  cardType: z.string().nullable().optional(),
  cardLastFour: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

/**
 * Schema for a balance transaction entity in API responses.
 */
export const balanceTransactionResponseSchema = z.object({
  id: z.string(),
  amount: z.string(), // Signed decimal string
  balanceAfter: z.string(),
  type: balanceTransactionTypeSchema,
  description: z.string(),
  paymentId: z.string().nullable().optional(),
  createdAt: z.string(),
});

export type BalanceTransactionResponse = z.infer<typeof balanceTransactionResponseSchema>;

/**
 * Response schema for POST /billing/payments.
 */
export const createPaymentResponseSchema = z.object({
  paymentId: z.string(),
  amount: z.string(),
});

export type CreatePaymentResponse = z.infer<typeof createPaymentResponseSchema>;

/**
 * Response schema for POST /billing/payments/:id/process when payment is approved.
 */
export const processPaymentResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('confirmed'),
    newBalance: z.string(),
    helcimTransactionId: z.string().optional(),
  }),
  z.object({
    status: z.literal('processing'),
    helcimTransactionId: z.string(),
  }),
]);

export type ProcessPaymentResponse = z.infer<typeof processPaymentResponseSchema>;

/**
 * Response schema for GET /billing/payments/:id (polling).
 */
export const getPaymentStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('confirmed'),
    newBalance: z.string(),
  }),
  z.object({
    status: z.literal('failed'),
    errorMessage: z.string().nullable().optional(),
  }),
  z.object({
    status: z.literal('pending'),
  }),
  z.object({
    status: z.literal('awaiting_webhook'),
  }),
]);

export type GetPaymentStatusResponse = z.infer<typeof getPaymentStatusResponseSchema>;

/**
 * Response schema for GET /billing/transactions.
 */
export const listTransactionsResponseSchema = z.object({
  transactions: z.array(balanceTransactionResponseSchema),
  nextCursor: z.string().nullable().optional(),
});

export type ListTransactionsResponse = z.infer<typeof listTransactionsResponseSchema>;

// Note: errorResponseSchema is exported from ./error.ts
