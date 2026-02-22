import { z } from 'zod';
import { USERNAME_REGEX, normalizeUsername, isReservedUsername } from '@hushbox/shared';

export const nameSchema = z.string().min(1, 'Name is required');
export const emailSchema = z.email('Please enter a valid email');
export const identifierSchema = z
  .string()
  .refine(
    (val) => z.email().safeParse(val).success || USERNAME_REGEX.test(normalizeUsername(val)),
    'Please enter a valid email or username'
  );
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters');

export interface ValidationResult {
  isValid: boolean;
  error?: string | undefined;
  success?: string | undefined;
}

/**
 * Creates a validator function from a Zod schema.
 *
 * @param schema - The Zod schema to validate against
 * @param successMessage - Message to return on successful validation (default: 'Valid')
 * @returns A function that validates a value and returns a ValidationResult
 */
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

export function validateRecoveryPhrase(phrase: string): ValidationResult {
  if (!phrase.trim()) return { isValid: false };
  const words = phrase.trim().split(/\s+/);
  if (words.length !== 12) {
    return { isValid: false, error: 'Recovery phrase must be exactly 12 words' };
  }
  return { isValid: true, success: '12 words entered' };
}
