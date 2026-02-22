/**
 * Maps machine-readable error codes to user-facing messages.
 *
 * This is the single source of truth for all user-facing error messages.
 * Backend returns `{ code: string }`, frontend calls `friendlyErrorMessage(code)`
 * to get the human-readable string displayed to users.
 */

// ============================================================================
// Branded type for user-facing messages
// ============================================================================

declare const __brand: unique symbol;

/**
 * A string that has been validated as a user-facing message.
 *
 * Produced by `friendlyErrorMessage()` (from an error code) or
 * `customUserMessage()` (from a hand-written string).
 *
 * `createChatError()` requires this type, preventing raw strings
 * from being passed without explicit mapping.
 */
export type UserFacingMessage = string & { readonly [__brand]: 'UserFacingMessage' };

// ============================================================================
// Error code → message map
// ============================================================================

const ERROR_MESSAGES = {
  // General codes
  UNAUTHORIZED: 'You are not logged in. Please log in and try again.',
  NOT_FOUND: "The item you're looking for doesn't exist.",
  VALIDATION: 'Invalid input. Please check your data and try again.',
  INSUFFICIENT_BALANCE: 'Insufficient balance.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  INTERNAL: 'Something went wrong. Please try again later.',
  FORBIDDEN: "You don't have permission to do this.",
  PAYMENT_REQUIRED: 'Payment is required for this action.',
  CONFLICT: 'This action conflicts with the current state. Please refresh and try again.',
  EXPIRED: 'This item has expired.',
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable. Please try again later.',
  BILLING_MISMATCH: 'Billing state has changed. Please retry.',
  CSRF_REJECTED: 'Request rejected for security reasons. Please refresh and try again.',

  // Auth codes
  AUTH_FAILED: 'Invalid credentials.',
  LOGIN_FAILED: 'Login failed. Please check your credentials and try again.',
  LOGIN_INIT_FAILED: 'Login failed. Please try again.',
  REGISTRATION_FAILED: 'Registration failed. Please try again.',
  USER_CREATION_FAILED: 'Account creation failed. Please try again.',
  ENCRYPTION_NOT_SETUP: 'Your account encryption is not configured. Please contact support.',
  EMAIL_NOT_VERIFIED:
    'Please verify your email address. Check your inbox for the verification link.',
  NOT_AUTHENTICATED: 'Your session has expired. Please log in again.',
  SESSION_REVOKED: 'Your session has been revoked. Please log in again.',
  PASSWORD_CHANGED: 'Your password was changed. Please log in again.', // eslint-disable-line sonarjs/no-hardcoded-passwords
  NO_PENDING_LOGIN: 'Your login session expired. Please try again.',
  NO_PENDING_REGISTRATION: 'Your registration session expired. Please start over.',
  NO_PENDING_CHANGE: 'Your password change session expired. Please start over.',
  NO_PENDING_RECOVERY: 'Your recovery session expired. Please start over.',
  /* eslint-disable sonarjs/no-hardcoded-passwords -- error message keys, not credentials */
  INCORRECT_PASSWORD: 'Incorrect password.',
  CHANGE_PASSWORD_FAILED: 'Password change failed. Please try again.',
  CHANGE_PASSWORD_INIT_FAILED: 'Password change failed. Please try again.',
  CHANGE_PASSWORD_REG_FAILED: 'Password change failed. Please try again.',
  /* eslint-enable sonarjs/no-hardcoded-passwords */
  ACCOUNT_KEY_NOT_AVAILABLE: 'Your encryption key is unavailable. Please log out and log back in.',
  VERIFICATION_FAILED: 'Email verification failed. Please try again or request a new link.',
  INVALID_OR_EXPIRED_TOKEN: 'This link has expired. Please request a new verification email.',

  // 2FA codes
  '2FA_VERIFICATION_FAILED': 'Two-factor verification failed. Please try again.',
  '2FA_REQUIRED': 'Two-factor authentication is required.',
  '2FA_EXPIRED': 'Your two-factor session expired. Please log in again.',
  INVALID_TOTP_CODE: 'Invalid verification code. Please try again.',
  TOTP_NOT_CONFIGURED: 'Two-factor authentication is not configured. Please contact support.',
  TOTP_NOT_ENABLED: 'Two-factor authentication is not enabled on this account.',
  TOTP_ALREADY_ENABLED: 'Two-factor authentication is already enabled.',
  NO_PENDING_2FA: 'Your two-factor session expired. Please log in again.',
  NO_PENDING_2FA_SETUP: 'Your two-factor setup session expired. Please start over.',
  NO_PENDING_DISABLE: 'Your two-factor disable session expired. Please start over.',
  DISABLE_2FA_INIT_FAILED: 'Failed to start two-factor disable. Please try again.',

  // Infrastructure codes
  USER_NOT_FOUND: 'Account not found.',
  SERVER_MISCONFIGURED: 'Something went wrong on our end. Please try again later.',
  INVALID_BASE64: 'Something went wrong with your request. Please try again.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Your account has been temporarily locked.',

  // Domain codes
  CONVERSATION_NOT_FOUND: 'Conversation not found.',
  MODEL_NOT_FOUND: 'Model not found.',
  LAST_MESSAGE_NOT_USER: 'Last message must be from you.',
  BALANCE_RESERVED: 'Please wait for your current messages to finish before starting more.',
  DAILY_LIMIT_EXCEEDED: 'Daily message limit exceeded.',
  CONTEXT_LENGTH_EXCEEDED:
    'This conversation is too long for the selected model. Try a model with a larger context window.',
  PHRASE_REQUIRED: 'Recovery phrase required before making payments.',
  PAYMENT_NOT_FOUND: 'Payment not found.',
  PAYMENT_ALREADY_PROCESSED: 'Payment already processed.',
  PAYMENT_EXPIRED: 'Payment expired.',
  PAYMENT_DECLINED: 'Payment declined.',
  PAYMENT_CREATE_FAILED: 'Failed to create payment.',
  PAYMENT_MISSING_TRANSACTION_ID: 'Payment approved but missing transaction ID.',
  INVALID_SIGNATURE: 'Something went wrong with your request. Please try again.',
  INVALID_JSON: 'Something went wrong with your request. Please try again.',
  WEBHOOK_VERIFIER_MISSING: 'Webhook processing unavailable.',
  PREMIUM_REQUIRES_BALANCE: 'Premium models require a positive balance.',
  PREMIUM_REQUIRES_ACCOUNT: 'Premium models require a free account.',
  TRIAL_MESSAGE_TOO_EXPENSIVE: 'This message exceeds trial limits. Sign up for more capacity.',
  AUTHENTICATED_ON_TRIAL: 'Authenticated users should use the main chat.',
  MEMBER_LIMIT_REACHED: 'Conversation has reached the maximum of 100 members.',
  PRIVILEGE_INSUFFICIENT: 'Insufficient privilege for this action.',
  MEMBER_NOT_FOUND: 'Member not found.',
  CANNOT_REMOVE_OWNER: 'Cannot remove the conversation owner.',
  ALREADY_MEMBER: 'User is already an active member.',
  CANNOT_REMOVE_SELF: 'Use the leave button to leave a conversation.',
  CANNOT_CHANGE_OWN_PRIVILEGE: 'Cannot change your own privilege.',
  LINK_NOT_FOUND: 'Link not found or already revoked.',
  EPOCH_NOT_FOUND: 'Current epoch not found.',
  MESSAGE_NOT_FOUND: 'Message not found.',
  SHARE_NOT_FOUND: 'Shared message not found.',
  WRAP_SET_MISMATCH: 'Member wrap set does not match active members.',
  ROTATION_REQUIRED: 'Epoch rotation is required for this operation.',
} as const satisfies Record<string, string>;

/** Known error code — union of all keys in the error message map. */
export type ErrorCode = keyof typeof ERROR_MESSAGES;

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Maps a machine-readable error code to a branded user-facing message.
 *
 * Accepts `ErrorCode` (for autocomplete) or any string (for network-parsed codes).
 * Unknown codes return the generic fallback.
 */
// eslint-disable-next-line sonarjs/no-useless-intersection -- preserves IDE autocomplete for ErrorCode while accepting arbitrary strings
export function friendlyErrorMessage(code: ErrorCode | (string & {})): UserFacingMessage {
  const message = (ERROR_MESSAGES as Record<string, string>)[code] ?? FALLBACK_MESSAGE;
  return message as UserFacingMessage;
}

/**
 * Wraps a hand-written string as a `UserFacingMessage`.
 *
 * Use when the message is not from the error code map — e.g., custom
 * markdown messages with signup links in the trial chat.
 */
export function customUserMessage(message: string): UserFacingMessage {
  return message as UserFacingMessage;
}
