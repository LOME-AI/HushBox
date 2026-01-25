import { z } from 'zod';

export const nameSchema = z.string().min(1, 'Name is required');
export const emailSchema = z.email('Please enter a valid email');
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
export const validateEmail = createValidator(emailSchema, 'Valid email');
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
