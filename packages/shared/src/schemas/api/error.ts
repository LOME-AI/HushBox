import { z } from 'zod';

// ============================================================
// Error Codes
// ============================================================

/** Unauthorized - authentication required or invalid */
export const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED';

/** Resource not found */
export const ERROR_CODE_NOT_FOUND = 'NOT_FOUND';

/** Validation error - invalid input */
export const ERROR_CODE_VALIDATION = 'VALIDATION';

/** Insufficient balance to perform operation */
export const ERROR_CODE_INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE';

/** Rate limit exceeded */
export const ERROR_CODE_RATE_LIMITED = 'RATE_LIMITED';

/** Internal server error */
export const ERROR_CODE_INTERNAL = 'INTERNAL';

/** Forbidden - authenticated but not authorized */
export const ERROR_CODE_FORBIDDEN = 'FORBIDDEN';

/** Payment required - operation needs funds */
export const ERROR_CODE_PAYMENT_REQUIRED = 'PAYMENT_REQUIRED';

/** Conflict - resource already in conflicting state */
export const ERROR_CODE_CONFLICT = 'CONFLICT';

/** Expired - resource or token has expired */
export const ERROR_CODE_EXPIRED = 'EXPIRED';

// ============================================================
// Error Response Schema
// ============================================================

/**
 * Standard error response schema.
 *
 * All API error responses follow this format:
 * - `error`: Human-readable error message (required)
 * - `code`: Machine-readable error code for programmatic handling (optional)
 * - `details`: Additional context about the error (optional)
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
