import { z } from 'zod';

/**
 * Single source of truth for all enum values used across the application.
 * Database schemas, API schemas, and frontend code should all import from here.
 */

// ============================================================================
// Message Role
// ============================================================================

/** Valid roles for chat messages */
export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;

/** Zod schema for message role validation */
export const messageRoleSchema = z.enum(MESSAGE_ROLES);

/** TypeScript type for message role */
export type MessageRole = z.infer<typeof messageRoleSchema>;

// ============================================================================
// Payment Status
// ============================================================================

/** Valid statuses for payments */
export const PAYMENT_STATUSES = ['pending', 'awaiting_webhook', 'confirmed', 'failed'] as const;

/** Zod schema for payment status validation */
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/** TypeScript type for payment status */
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

// ============================================================================
// Balance Transaction Type
// ============================================================================

/** Valid types for balance transactions */
export const BALANCE_TRANSACTION_TYPES = ['deposit', 'usage', 'adjustment'] as const;

/** Zod schema for balance transaction type validation */
export const balanceTransactionTypeSchema = z.enum(BALANCE_TRANSACTION_TYPES);

/** TypeScript type for balance transaction type */
export type BalanceTransactionType = z.infer<typeof balanceTransactionTypeSchema>;

// ============================================================================
// Deduction Source (for balance transactions)
// ============================================================================

/** Valid sources for deduction on usage transactions */
export const DEDUCTION_SOURCES = ['balance', 'freeAllowance'] as const;

/** Zod schema for deduction source validation */
export const deductionSourceSchema = z.enum(DEDUCTION_SOURCES);

/** TypeScript type for deduction source */
export type StoredDeductionSource = z.infer<typeof deductionSourceSchema>;
