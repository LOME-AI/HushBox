import { z } from 'zod';

// ============================================================
// Error Codes — General
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

/** Service unavailable - required infrastructure not available */
export const ERROR_CODE_SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

/** Billing mismatch - frontend and backend disagree on funding source */
export const ERROR_CODE_BILLING_MISMATCH = 'BILLING_MISMATCH';

/** CSRF rejected - cross-site request forgery protection triggered */
export const ERROR_CODE_CSRF_REJECTED = 'CSRF_REJECTED';

// ============================================================
// Error Codes — Auth
// ============================================================

/** Authentication failed - invalid credentials */
export const ERROR_CODE_AUTH_FAILED = 'AUTH_FAILED';

/** Login failed - generic client-side login error */
export const ERROR_CODE_LOGIN_FAILED = 'LOGIN_FAILED';

/** Login init failed - OPAQUE init step failed */
export const ERROR_CODE_LOGIN_INIT_FAILED = 'LOGIN_INIT_FAILED';

/** Registration failed - generic client-side registration error */
export const ERROR_CODE_REGISTRATION_FAILED = 'REGISTRATION_FAILED';

/** User creation failed - server-side user insert error */
export const ERROR_CODE_USER_CREATION_FAILED = 'USER_CREATION_FAILED';

/** Encryption not setup - missing password-wrapped private key */
export const ERROR_CODE_ENCRYPTION_NOT_SETUP = 'ENCRYPTION_NOT_SETUP';

/** Email not verified - user must verify before proceeding */
export const ERROR_CODE_EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

/** Not authenticated - session expired or missing */
export const ERROR_CODE_NOT_AUTHENTICATED = 'NOT_AUTHENTICATED';

/** Session revoked - session invalidated (e.g. logged out from another device) */
export const ERROR_CODE_SESSION_REVOKED = 'SESSION_REVOKED';

/** Password changed - session predates a password change */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_PASSWORD_CHANGED = 'PASSWORD_CHANGED';

/** No pending login - OPAQUE login state expired in Redis */
export const ERROR_CODE_NO_PENDING_LOGIN = 'NO_PENDING_LOGIN';

/** No pending registration - OPAQUE registration state expired in Redis */
export const ERROR_CODE_NO_PENDING_REGISTRATION = 'NO_PENDING_REGISTRATION';

/** No pending password change - change-password state expired in Redis */
export const ERROR_CODE_NO_PENDING_CHANGE = 'NO_PENDING_CHANGE';

/** No pending recovery - recovery state expired in Redis */
export const ERROR_CODE_NO_PENDING_RECOVERY = 'NO_PENDING_RECOVERY';

/** Incorrect password - current password verification failed */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_INCORRECT_PASSWORD = 'INCORRECT_PASSWORD';

/** Change password failed - generic client-side error */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_CHANGE_PASSWORD_FAILED = 'CHANGE_PASSWORD_FAILED';

/** Change password init failed - OPAQUE init step failed */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_CHANGE_PASSWORD_INIT_FAILED = 'CHANGE_PASSWORD_INIT_FAILED';

/** Change password registration failed - OPAQUE reg step failed */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_CHANGE_PASSWORD_REG_FAILED = 'CHANGE_PASSWORD_REG_FAILED';

/** Account key not available - private key not in memory */
export const ERROR_CODE_ACCOUNT_KEY_NOT_AVAILABLE = 'ACCOUNT_KEY_NOT_AVAILABLE';

/** Email verification failed - generic client-side error */
export const ERROR_CODE_VERIFICATION_FAILED = 'VERIFICATION_FAILED';

/** Invalid or expired verification token */
export const ERROR_CODE_INVALID_OR_EXPIRED_TOKEN = 'INVALID_OR_EXPIRED_TOKEN';

// ============================================================
// Error Codes — 2FA
// ============================================================

/** 2FA verification failed - generic client-side error */
export const ERROR_CODE_2FA_VERIFICATION_FAILED = '2FA_VERIFICATION_FAILED';

/** 2FA required - login needs TOTP verification */
export const ERROR_CODE_2FA_REQUIRED = '2FA_REQUIRED';

/** 2FA expired - pending 2FA state expired in Redis */
export const ERROR_CODE_2FA_EXPIRED = '2FA_EXPIRED';

/** Invalid TOTP code */
export const ERROR_CODE_INVALID_TOTP_CODE = 'INVALID_TOTP_CODE';

/** TOTP not configured - secret missing from DB */
export const ERROR_CODE_TOTP_NOT_CONFIGURED = 'TOTP_NOT_CONFIGURED';

/** TOTP not enabled - user hasn't enabled 2FA */
export const ERROR_CODE_TOTP_NOT_ENABLED = 'TOTP_NOT_ENABLED';

/** TOTP already enabled - can't enable twice */
export const ERROR_CODE_TOTP_ALREADY_ENABLED = 'TOTP_ALREADY_ENABLED';

/** No pending 2FA - login 2FA state expired */
export const ERROR_CODE_NO_PENDING_2FA = 'NO_PENDING_2FA';

/** No pending 2FA setup - TOTP setup state expired */
export const ERROR_CODE_NO_PENDING_2FA_SETUP = 'NO_PENDING_2FA_SETUP';

/** No pending disable - 2FA disable state expired */
export const ERROR_CODE_NO_PENDING_DISABLE = 'NO_PENDING_DISABLE';

/** Disable 2FA init failed */
export const ERROR_CODE_DISABLE_2FA_INIT_FAILED = 'DISABLE_2FA_INIT_FAILED';

// ============================================================
// Error Codes — Infrastructure
// ============================================================

/** User not found in database */
export const ERROR_CODE_USER_NOT_FOUND = 'USER_NOT_FOUND';

/** Server misconfigured - missing OPAQUE setup or other config */
export const ERROR_CODE_SERVER_MISCONFIGURED = 'SERVER_MISCONFIGURED';

/** Invalid base64 encoding in request */
export const ERROR_CODE_INVALID_BASE64 = 'INVALID_BASE64';

/** Too many attempts - account temporarily locked */
export const ERROR_CODE_TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS';

// ============================================================
// Error Codes — Domain
// ============================================================

/** Conversation not found */
export const ERROR_CODE_CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND';

/** Model not found */
export const ERROR_CODE_MODEL_NOT_FOUND = 'MODEL_NOT_FOUND';

/** Last message in conversation is not from user */
export const ERROR_CODE_LAST_MESSAGE_NOT_USER = 'LAST_MESSAGE_NOT_USER';

/** Balance currently reserved by in-flight messages */
export const ERROR_CODE_BALANCE_RESERVED = 'BALANCE_RESERVED';

/** Daily message limit exceeded */
export const ERROR_CODE_DAILY_LIMIT_EXCEEDED = 'DAILY_LIMIT_EXCEEDED';

/** Recovery phrase required before payment */
export const ERROR_CODE_PHRASE_REQUIRED = 'PHRASE_REQUIRED';

/** Payment not found */
export const ERROR_CODE_PAYMENT_NOT_FOUND = 'PAYMENT_NOT_FOUND';

/** Payment already processed */
export const ERROR_CODE_PAYMENT_ALREADY_PROCESSED = 'PAYMENT_ALREADY_PROCESSED';

/** Payment expired */
export const ERROR_CODE_PAYMENT_EXPIRED = 'PAYMENT_EXPIRED';

/** Payment declined by processor */
export const ERROR_CODE_PAYMENT_DECLINED = 'PAYMENT_DECLINED';

/** Failed to create payment */
export const ERROR_CODE_PAYMENT_CREATE_FAILED = 'PAYMENT_CREATE_FAILED';

/** Payment approved but missing transaction ID */
export const ERROR_CODE_PAYMENT_MISSING_TRANSACTION_ID = 'PAYMENT_MISSING_TRANSACTION_ID';

/** Invalid signature on request */
export const ERROR_CODE_INVALID_SIGNATURE = 'INVALID_SIGNATURE';

/** Invalid JSON in request body */
export const ERROR_CODE_INVALID_JSON = 'INVALID_JSON';

/** Webhook verifier not configured */
export const ERROR_CODE_WEBHOOK_VERIFIER_MISSING = 'WEBHOOK_VERIFIER_MISSING';

/** Premium model requires positive balance */
export const ERROR_CODE_PREMIUM_REQUIRES_BALANCE = 'PREMIUM_REQUIRES_BALANCE';

/** Premium model requires a free account */
export const ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT = 'PREMIUM_REQUIRES_ACCOUNT';

/** Trial message exceeds cost limits */
export const ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE = 'TRIAL_MESSAGE_TOO_EXPENSIVE';

/** Authenticated user on trial endpoint */
export const ERROR_CODE_AUTHENTICATED_ON_TRIAL = 'AUTHENTICATED_ON_TRIAL';

/** Conversation member limit reached */
export const ERROR_CODE_MEMBER_LIMIT_REACHED = 'MEMBER_LIMIT_REACHED';

/** Insufficient privilege for action */
export const ERROR_CODE_PRIVILEGE_INSUFFICIENT = 'PRIVILEGE_INSUFFICIENT';

/** Member not found in conversation */
export const ERROR_CODE_MEMBER_NOT_FOUND = 'MEMBER_NOT_FOUND';

/** Cannot remove conversation owner */
export const ERROR_CODE_CANNOT_REMOVE_OWNER = 'CANNOT_REMOVE_OWNER';

/** User is already an active member */
export const ERROR_CODE_ALREADY_MEMBER = 'ALREADY_MEMBER';

/** Cannot remove self - use leave instead */
export const ERROR_CODE_CANNOT_REMOVE_SELF = 'CANNOT_REMOVE_SELF';

/** Cannot change own privilege */
export const ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE = 'CANNOT_CHANGE_OWN_PRIVILEGE';

/** Shared link not found or already revoked */
export const ERROR_CODE_LINK_NOT_FOUND = 'LINK_NOT_FOUND';

/** Current epoch not found */
export const ERROR_CODE_EPOCH_NOT_FOUND = 'EPOCH_NOT_FOUND';

/** Message not found */
export const ERROR_CODE_MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND';

/** Shared message not found */
export const ERROR_CODE_SHARE_NOT_FOUND = 'SHARE_NOT_FOUND';

/** Member wrap set does not match active members */
export const ERROR_CODE_WRAP_SET_MISMATCH = 'WRAP_SET_MISMATCH';

/** Epoch rotation required */
export const ERROR_CODE_ROTATION_REQUIRED = 'ROTATION_REQUIRED';

// ============================================================
// Error Response Schema
// ============================================================

/**
 * Standard error response schema.
 *
 * All API error responses follow this format:
 * - `code`: Machine-readable error code (required)
 * - `details`: Additional context about the error (optional)
 *
 * Frontend maps `code` → user-facing message via `friendlyErrorMessage()`.
 */
export const errorResponseSchema = z.object({
  code: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
