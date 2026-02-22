import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage, customUserMessage } from './error-messages.js';

describe('friendlyErrorMessage', () => {
  // ------------------------------------------------------------------
  // General codes
  // ------------------------------------------------------------------
  it('maps UNAUTHORIZED to user-facing message', () => {
    expect(friendlyErrorMessage('UNAUTHORIZED')).toBe(
      'You are not logged in. Please log in and try again.'
    );
  });

  it('maps NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('NOT_FOUND')).toBe("The item you're looking for doesn't exist.");
  });

  it('maps VALIDATION to user-facing message', () => {
    expect(friendlyErrorMessage('VALIDATION')).toBe(
      'Invalid input. Please check your data and try again.'
    );
  });

  it('maps INSUFFICIENT_BALANCE to user-facing message', () => {
    expect(friendlyErrorMessage('INSUFFICIENT_BALANCE')).toBe('Insufficient balance.');
  });

  it('maps RATE_LIMITED to user-facing message', () => {
    expect(friendlyErrorMessage('RATE_LIMITED')).toBe(
      'Too many requests. Please wait a moment and try again.'
    );
  });

  it('maps INTERNAL to user-facing message', () => {
    expect(friendlyErrorMessage('INTERNAL')).toBe('Something went wrong. Please try again later.');
  });

  it('maps FORBIDDEN to user-facing message', () => {
    expect(friendlyErrorMessage('FORBIDDEN')).toBe("You don't have permission to do this.");
  });

  it('maps PAYMENT_REQUIRED to user-facing message', () => {
    expect(friendlyErrorMessage('PAYMENT_REQUIRED')).toBe('Payment is required for this action.');
  });

  it('maps CONFLICT to user-facing message', () => {
    expect(friendlyErrorMessage('CONFLICT')).toBe(
      'This action conflicts with the current state. Please refresh and try again.'
    );
  });

  it('maps EXPIRED to user-facing message', () => {
    expect(friendlyErrorMessage('EXPIRED')).toBe('This item has expired.');
  });

  it('maps SERVICE_UNAVAILABLE to user-facing message', () => {
    expect(friendlyErrorMessage('SERVICE_UNAVAILABLE')).toBe(
      'This service is temporarily unavailable. Please try again later.'
    );
  });

  it('maps BILLING_MISMATCH to user-facing message', () => {
    expect(friendlyErrorMessage('BILLING_MISMATCH')).toBe(
      'Billing state has changed. Please retry.'
    );
  });

  it('maps CSRF_REJECTED to user-facing message', () => {
    expect(friendlyErrorMessage('CSRF_REJECTED')).toBe(
      'Request rejected for security reasons. Please refresh and try again.'
    );
  });

  it('maps SESSION_REVOKED to user-facing message', () => {
    expect(friendlyErrorMessage('SESSION_REVOKED')).toBe(
      'Your session has been revoked. Please log in again.'
    );
  });

  it('maps PASSWORD_CHANGED to user-facing message', () => {
    expect(friendlyErrorMessage('PASSWORD_CHANGED')).toBe(
      'Your password was changed. Please log in again.'
    );
  });

  // ------------------------------------------------------------------
  // Auth codes
  // ------------------------------------------------------------------
  it('maps AUTH_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('AUTH_FAILED')).toBe('Invalid credentials.');
  });

  it('maps LOGIN_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('LOGIN_FAILED')).toBe(
      'Login failed. Please check your credentials and try again.'
    );
  });

  it('maps LOGIN_INIT_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('LOGIN_INIT_FAILED')).toBe('Login failed. Please try again.');
  });

  it('maps REGISTRATION_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('REGISTRATION_FAILED')).toBe(
      'Registration failed. Please try again.'
    );
  });

  it('maps USER_CREATION_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('USER_CREATION_FAILED')).toBe(
      'Account creation failed. Please try again.'
    );
  });

  it('maps ENCRYPTION_NOT_SETUP to user-facing message', () => {
    expect(friendlyErrorMessage('ENCRYPTION_NOT_SETUP')).toBe(
      'Your account encryption is not configured. Please contact support.'
    );
  });

  it('maps EMAIL_NOT_VERIFIED to user-facing message', () => {
    expect(friendlyErrorMessage('EMAIL_NOT_VERIFIED')).toBe(
      'Please verify your email address. Check your inbox for the verification link.'
    );
  });

  it('maps NOT_AUTHENTICATED to user-facing message', () => {
    expect(friendlyErrorMessage('NOT_AUTHENTICATED')).toBe(
      'Your session has expired. Please log in again.'
    );
  });

  it('maps NO_PENDING_LOGIN to user-facing message', () => {
    expect(friendlyErrorMessage('NO_PENDING_LOGIN')).toBe(
      'Your login session expired. Please try again.'
    );
  });

  it('maps NO_PENDING_REGISTRATION to user-facing message', () => {
    expect(friendlyErrorMessage('NO_PENDING_REGISTRATION')).toBe(
      'Your registration session expired. Please start over.'
    );
  });

  it('maps NO_PENDING_CHANGE to user-facing message', () => {
    expect(friendlyErrorMessage('NO_PENDING_CHANGE')).toBe(
      'Your password change session expired. Please start over.'
    );
  });

  it('maps NO_PENDING_RECOVERY to user-facing message', () => {
    expect(friendlyErrorMessage('NO_PENDING_RECOVERY')).toBe(
      'Your recovery session expired. Please start over.'
    );
  });

  it('maps INCORRECT_PASSWORD to user-facing message', () => {
    expect(friendlyErrorMessage('INCORRECT_PASSWORD')).toBe('Incorrect password.');
  });

  it('maps CHANGE_PASSWORD_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('CHANGE_PASSWORD_FAILED')).toBe(
      'Password change failed. Please try again.'
    );
  });

  it('maps CHANGE_PASSWORD_INIT_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('CHANGE_PASSWORD_INIT_FAILED')).toBe(
      'Password change failed. Please try again.'
    );
  });

  it('maps CHANGE_PASSWORD_REG_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('CHANGE_PASSWORD_REG_FAILED')).toBe(
      'Password change failed. Please try again.'
    );
  });

  it('maps ACCOUNT_KEY_NOT_AVAILABLE to user-facing message', () => {
    expect(friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE')).toBe(
      'Your encryption key is unavailable. Please log out and log back in.'
    );
  });

  it('maps VERIFICATION_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('VERIFICATION_FAILED')).toBe(
      'Email verification failed. Please try again or request a new link.'
    );
  });

  it('maps INVALID_OR_EXPIRED_TOKEN to user-facing message', () => {
    expect(friendlyErrorMessage('INVALID_OR_EXPIRED_TOKEN')).toBe(
      'This link has expired. Please request a new verification email.'
    );
  });

  // ------------------------------------------------------------------
  // 2FA codes
  // ------------------------------------------------------------------
  it('maps 2FA_VERIFICATION_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('2FA_VERIFICATION_FAILED')).toBe(
      'Two-factor verification failed. Please try again.'
    );
  });

  it('maps 2FA_REQUIRED to user-facing message', () => {
    expect(friendlyErrorMessage('2FA_REQUIRED')).toBe('Two-factor authentication is required.');
  });

  it('maps 2FA_EXPIRED to user-facing message', () => {
    expect(friendlyErrorMessage('2FA_EXPIRED')).toBe(
      'Your two-factor session expired. Please log in again.'
    );
  });

  it('maps INVALID_TOTP_CODE to user-facing message', () => {
    expect(friendlyErrorMessage('INVALID_TOTP_CODE')).toBe(
      'Invalid verification code. Please try again.'
    );
  });

  it('maps TOTP_NOT_CONFIGURED to user-facing message', () => {
    expect(friendlyErrorMessage('TOTP_NOT_CONFIGURED')).toBe(
      'Two-factor authentication is not configured. Please contact support.'
    );
  });

  it('maps TOTP_NOT_ENABLED to user-facing message', () => {
    expect(friendlyErrorMessage('TOTP_NOT_ENABLED')).toBe(
      'Two-factor authentication is not enabled on this account.'
    );
  });

  it('maps TOTP_ALREADY_ENABLED to user-facing message', () => {
    expect(friendlyErrorMessage('TOTP_ALREADY_ENABLED')).toBe(
      'Two-factor authentication is already enabled.'
    );
  });

  it('maps NO_PENDING_2FA to user-facing message', () => {
    expect(friendlyErrorMessage('NO_PENDING_2FA')).toBe(
      'Your two-factor session expired. Please log in again.'
    );
  });

  it('maps NO_PENDING_2FA_SETUP to user-facing message', () => {
    expect(friendlyErrorMessage('NO_PENDING_2FA_SETUP')).toBe(
      'Your two-factor setup session expired. Please start over.'
    );
  });

  it('maps NO_PENDING_DISABLE to user-facing message', () => {
    expect(friendlyErrorMessage('NO_PENDING_DISABLE')).toBe(
      'Your two-factor disable session expired. Please start over.'
    );
  });

  it('maps DISABLE_2FA_INIT_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('DISABLE_2FA_INIT_FAILED')).toBe(
      'Failed to start two-factor disable. Please try again.'
    );
  });

  // ------------------------------------------------------------------
  // Infrastructure codes
  // ------------------------------------------------------------------
  it('maps USER_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('USER_NOT_FOUND')).toBe('Account not found.');
  });

  it('maps SERVER_MISCONFIGURED to user-facing message', () => {
    expect(friendlyErrorMessage('SERVER_MISCONFIGURED')).toBe(
      'Something went wrong on our end. Please try again later.'
    );
  });

  it('maps INVALID_BASE64 to user-facing message', () => {
    expect(friendlyErrorMessage('INVALID_BASE64')).toBe(
      'Something went wrong with your request. Please try again.'
    );
  });

  it('maps TOO_MANY_ATTEMPTS to user-facing message', () => {
    expect(friendlyErrorMessage('TOO_MANY_ATTEMPTS')).toBe(
      'Too many attempts. Your account has been temporarily locked.'
    );
  });

  // ------------------------------------------------------------------
  // Domain codes
  // ------------------------------------------------------------------
  it('maps CONVERSATION_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('CONVERSATION_NOT_FOUND')).toBe('Conversation not found.');
  });

  it('maps MODEL_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('MODEL_NOT_FOUND')).toBe('Model not found.');
  });

  it('maps LAST_MESSAGE_NOT_USER to user-facing message', () => {
    expect(friendlyErrorMessage('LAST_MESSAGE_NOT_USER')).toBe('Last message must be from you.');
  });

  it('maps BALANCE_RESERVED to user-facing message', () => {
    expect(friendlyErrorMessage('BALANCE_RESERVED')).toBe(
      'Please wait for your current messages to finish before starting more.'
    );
  });

  it('maps DAILY_LIMIT_EXCEEDED to user-facing message', () => {
    expect(friendlyErrorMessage('DAILY_LIMIT_EXCEEDED')).toBe('Daily message limit exceeded.');
  });

  it('maps PHRASE_REQUIRED to user-facing message', () => {
    expect(friendlyErrorMessage('PHRASE_REQUIRED')).toBe(
      'Recovery phrase required before making payments.'
    );
  });

  it('maps PAYMENT_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('PAYMENT_NOT_FOUND')).toBe('Payment not found.');
  });

  it('maps PAYMENT_ALREADY_PROCESSED to user-facing message', () => {
    expect(friendlyErrorMessage('PAYMENT_ALREADY_PROCESSED')).toBe('Payment already processed.');
  });

  it('maps PAYMENT_EXPIRED to user-facing message', () => {
    expect(friendlyErrorMessage('PAYMENT_EXPIRED')).toBe('Payment expired.');
  });

  it('maps PAYMENT_DECLINED to user-facing message', () => {
    expect(friendlyErrorMessage('PAYMENT_DECLINED')).toBe('Payment declined.');
  });

  it('maps PAYMENT_CREATE_FAILED to user-facing message', () => {
    expect(friendlyErrorMessage('PAYMENT_CREATE_FAILED')).toBe('Failed to create payment.');
  });

  it('maps PAYMENT_MISSING_TRANSACTION_ID to user-facing message', () => {
    expect(friendlyErrorMessage('PAYMENT_MISSING_TRANSACTION_ID')).toBe(
      'Payment approved but missing transaction ID.'
    );
  });

  it('maps INVALID_SIGNATURE to user-facing message', () => {
    expect(friendlyErrorMessage('INVALID_SIGNATURE')).toBe(
      'Something went wrong with your request. Please try again.'
    );
  });

  it('maps INVALID_JSON to user-facing message', () => {
    expect(friendlyErrorMessage('INVALID_JSON')).toBe(
      'Something went wrong with your request. Please try again.'
    );
  });

  it('maps WEBHOOK_VERIFIER_MISSING to user-facing message', () => {
    expect(friendlyErrorMessage('WEBHOOK_VERIFIER_MISSING')).toBe(
      'Webhook processing unavailable.'
    );
  });

  it('maps PREMIUM_REQUIRES_BALANCE to user-facing message', () => {
    expect(friendlyErrorMessage('PREMIUM_REQUIRES_BALANCE')).toBe(
      'Premium models require a positive balance.'
    );
  });

  it('maps PREMIUM_REQUIRES_ACCOUNT to user-facing message', () => {
    expect(friendlyErrorMessage('PREMIUM_REQUIRES_ACCOUNT')).toBe(
      'Premium models require a free account.'
    );
  });

  it('maps TRIAL_MESSAGE_TOO_EXPENSIVE to user-facing message', () => {
    expect(friendlyErrorMessage('TRIAL_MESSAGE_TOO_EXPENSIVE')).toBe(
      'This message exceeds trial limits. Sign up for more capacity.'
    );
  });

  it('maps AUTHENTICATED_ON_TRIAL to user-facing message', () => {
    expect(friendlyErrorMessage('AUTHENTICATED_ON_TRIAL')).toBe(
      'Authenticated users should use the main chat.'
    );
  });

  it('maps MEMBER_LIMIT_REACHED to user-facing message', () => {
    expect(friendlyErrorMessage('MEMBER_LIMIT_REACHED')).toBe(
      'Conversation has reached the maximum of 100 members.'
    );
  });

  it('maps PRIVILEGE_INSUFFICIENT to user-facing message', () => {
    expect(friendlyErrorMessage('PRIVILEGE_INSUFFICIENT')).toBe(
      'Insufficient privilege for this action.'
    );
  });

  it('maps MEMBER_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('MEMBER_NOT_FOUND')).toBe('Member not found.');
  });

  it('maps CANNOT_REMOVE_OWNER to user-facing message', () => {
    expect(friendlyErrorMessage('CANNOT_REMOVE_OWNER')).toBe(
      'Cannot remove the conversation owner.'
    );
  });

  it('maps ALREADY_MEMBER to user-facing message', () => {
    expect(friendlyErrorMessage('ALREADY_MEMBER')).toBe('User is already an active member.');
  });

  it('maps CANNOT_REMOVE_SELF to user-facing message', () => {
    expect(friendlyErrorMessage('CANNOT_REMOVE_SELF')).toBe(
      'Use the leave button to leave a conversation.'
    );
  });

  it('maps CANNOT_CHANGE_OWN_PRIVILEGE to user-facing message', () => {
    expect(friendlyErrorMessage('CANNOT_CHANGE_OWN_PRIVILEGE')).toBe(
      'Cannot change your own privilege.'
    );
  });

  it('maps LINK_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('LINK_NOT_FOUND')).toBe('Link not found or already revoked.');
  });

  it('maps EPOCH_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('EPOCH_NOT_FOUND')).toBe('Current epoch not found.');
  });

  it('maps MESSAGE_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('MESSAGE_NOT_FOUND')).toBe('Message not found.');
  });

  it('maps SHARE_NOT_FOUND to user-facing message', () => {
    expect(friendlyErrorMessage('SHARE_NOT_FOUND')).toBe('Shared message not found.');
  });

  it('maps WRAP_SET_MISMATCH to user-facing message', () => {
    expect(friendlyErrorMessage('WRAP_SET_MISMATCH')).toBe(
      'Member wrap set does not match active members.'
    );
  });

  it('maps ROTATION_REQUIRED to user-facing message', () => {
    expect(friendlyErrorMessage('ROTATION_REQUIRED')).toBe(
      'Epoch rotation is required for this operation.'
    );
  });

  it('maps CONTEXT_LENGTH_EXCEEDED to user-facing message', () => {
    expect(friendlyErrorMessage('CONTEXT_LENGTH_EXCEEDED')).toBe(
      'This conversation is too long for the selected model. Try a model with a larger context window.'
    );
  });

  // ------------------------------------------------------------------
  // Unknown code fallback
  // ------------------------------------------------------------------
  it('returns generic fallback for unknown codes', () => {
    expect(friendlyErrorMessage('TOTALLY_UNKNOWN_CODE')).toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('returns generic fallback for empty string', () => {
    expect(friendlyErrorMessage('')).toBe('Something went wrong. Please try again.');
  });
});

describe('customUserMessage', () => {
  it('returns the input string unchanged', () => {
    const result = customUserMessage('Custom error message for the user.');
    expect(result).toBe('Custom error message for the user.');
  });

  it('preserves markdown in custom messages', () => {
    const result = customUserMessage('Please [sign up](/signup) to continue.');
    expect(result).toBe('Please [sign up](/signup) to continue.');
  });
});
