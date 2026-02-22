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
export const PAYMENT_STATUSES = [
  'pending',
  'awaiting_webhook',
  'completed',
  'failed',
  'refunded',
] as const;

/** Zod schema for payment status validation */
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/** TypeScript type for payment status */
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

// ============================================================================
// Ledger Entry Type
// ============================================================================

/** Valid types for ledger entries */
export const LEDGER_ENTRY_TYPES = [
  'deposit',
  'usage_charge',
  'refund',
  'adjustment',
  'renewal',
  'welcome_credit',
] as const;

/** Zod schema for ledger entry type validation */
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);

/** TypeScript type for ledger entry type */
export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>;

// ============================================================================
// Deduction Source (for balance transactions)
// ============================================================================

/** Valid sources for deduction on usage transactions */
export const DEDUCTION_SOURCES = ['balance', 'freeAllowance'] as const;

/** Zod schema for deduction source validation */
export const deductionSourceSchema = z.enum(DEDUCTION_SOURCES);

/** TypeScript type for deduction source */
export type StoredDeductionSource = z.infer<typeof deductionSourceSchema>;

// ============================================================================
// Member Privilege
// ============================================================================

/** Valid privilege levels for conversation members, ordered lowest to highest */
export const MEMBER_PRIVILEGES = ['read', 'write', 'admin', 'owner'] as const;

/** Zod schema for member privilege validation */
export const memberPrivilegeSchema = z.enum(MEMBER_PRIVILEGES);

/** TypeScript type for member privilege */
export type MemberPrivilege = z.infer<typeof memberPrivilegeSchema>;
