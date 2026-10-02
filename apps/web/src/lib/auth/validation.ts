import { z } from 'zod';
import { validatePhrase } from '@hushbox/crypto';
import {
  USERNAME_REGEX,
  normalizeUsername,
  isReservedUsername,
  MIN_PASSWORD_LENGTH,
} from '@hushbox/shared';

const nameSchema = z.string().min(1, 'Name is required');
const emailSchema = z.email('Please enter a valid email');
const identifierSchema = z
  .string()
  .refine(
    (val) => z.email().safeParse(val).success || USERNAME_REGEX.test(normalizeUsername(val)),
    'Please enter a valid email or username'
  );
const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`);

interface ValidationResult {
  isValid: boolean;
  error?: string | undefined;
  success?: string | undefined;
}

export function createValidator<T>(
  schema: z.ZodType<T>,
  successMessage = 'Valid'
): (value: T) => ValidationResult {
  return (value: T): ValidationResult => {
    if (
      (value as unknown) === '' ||
      (value as unknown) === null ||
      (value as unknown) === undefined
    ) {
      return { isValid: false };
    }
    const result = schema.safeParse(value);
    if (result.success) {
      return { isValid: true, success: successMessage };
    }
    return { isValid: false, error: result.error.issues[0]?.message };
  };
}

export const validateName = createValidator(nameSchema, 'Looks good!');

export function validateUsername(rawInput: string): ValidationResult {
  if (!rawInput) return { isValid: false };

  const normalized = normalizeUsername(rawInput);

  if (!USERNAME_REGEX.test(normalized)) {
    return {
      isValid: false,
      error: '3-20 chars, starts with a letter. Letters, numbers, spaces only.',
    };
  }

  if (isReservedUsername(normalized)) {
    return { isValid: false, error: 'This username is not available.' };
  }

  return { isValid: true, success: 'Looks good!' };
}
export const validateEmail = createValidator(emailSchema, 'Valid email');
export const validateIdentifier = createValidator(identifierSchema, 'Valid');
export const validatePassword = createValidator(passwordSchema, 'Password meets requirements');

export function validateConfirmPassword(
  password: string,
  confirmPassword: string
): ValidationResult {
  if (!confirmPassword) return { isValid: false };
  if (password !== confirmPassword) {
    return { isValid: false, error: 'Passwords do not match' };
  }
  return { isValid: true, success: 'Passwords match' };
}

/** A phrase that fails the BIP-39 checksum is a typo, so the copy says so. */
export const RECOVERY_PHRASE_INVALID_MESSAGE =
  'That recovery phrase is not valid. Check for a mistyped word.';

/**
 * The single answer to "the phrase did not open this account", used for a
 * wrong phrase and an unknown identifier alike. A second message here would
 * turn the reset form into an account-enumeration oracle, undoing the
 * byte-identical responses the identity slice goes to some trouble to return.
 */
export const RECOVERY_PHRASE_MISMATCH_MESSAGE = "That recovery phrase doesn't match this account.";

/**
 * The form the checksum is checked against and the seed is derived from. Both
 * must see the same string: BIP-39 hashes the phrase verbatim, so a pasted
 * newline that passed an unnormalized checksum would derive a different key.
 */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.trim().split(/\s+/).join(' ');
}

export function validateRecoveryPhrase(phrase: string): ValidationResult {
  if (!phrase.trim()) return { isValid: false };
  const normalized = normalizeRecoveryPhrase(phrase);
  if (normalized.split(' ').length !== 12) {
    return { isValid: false, error: 'Recovery phrase must be exactly 12 words' };
  }
  if (!validatePhrase(normalized)) {
    return { isValid: false, error: RECOVERY_PHRASE_INVALID_MESSAGE };
  }
  return { isValid: true, success: '12 words entered' };
}
