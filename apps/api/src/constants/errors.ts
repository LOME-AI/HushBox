/**
 * Centralized error message constants for consistent error responses across the API.
 * These constants ensure type-safe, consistent error messaging.
 */

// Authentication/Authorization errors
export const ERROR_UNAUTHORIZED = 'Unauthorized';

// Resource errors
export const ERROR_CONVERSATION_NOT_FOUND = 'Conversation not found';
export const ERROR_MODEL_NOT_FOUND = 'Model not found';

// Validation errors
export const ERROR_LAST_MESSAGE_NOT_USER = 'Last message must be from user';

// Billing errors
export const ERROR_INSUFFICIENT_BALANCE = 'Insufficient balance';

// Rate limiting errors
export const ERROR_DAILY_LIMIT_EXCEEDED = 'Daily message limit exceeded';

// Payment errors
export const ERROR_PAYMENT_NOT_FOUND = 'Payment not found';
export const ERROR_PAYMENT_ALREADY_PROCESSED = 'Payment already processed';
export const ERROR_PAYMENT_EXPIRED = 'Payment expired';
export const ERROR_PAYMENT_DECLINED = 'Payment declined';
export const ERROR_PAYMENT_CREATE_FAILED = 'Failed to create payment';

// Validation errors (additional)
export const ERROR_INVALID_SIGNATURE = 'Invalid signature';
export const ERROR_INVALID_JSON = 'Invalid JSON';

// Configuration errors
export const ERROR_WEBHOOK_VERIFIER_MISSING =
  'Webhook verifier not configured - payment webhooks cannot be processed';

// Internal errors
export const ERROR_UPDATE_FAILED = 'Failed to update conversation';
export const ERROR_CREATE_MESSAGE_FAILED = 'Failed to create message';

// Premium/Balance errors
export const ERROR_PREMIUM_REQUIRES_BALANCE = 'Premium models require a positive balance';
export const ERROR_PREMIUM_REQUIRES_ACCOUNT = 'Premium models require a free account';

// Guest endpoint errors
export const ERROR_AUTHENTICATED_USER_ON_GUEST_ENDPOINT =
  'Authenticated users should use /chat/stream';
export const ERROR_GUEST_MESSAGE_TOO_EXPENSIVE =
  'This message exceeds guest limits. Sign up for more capacity.';
