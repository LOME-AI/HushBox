import { z } from 'zod';

export const nameSchema = z.string().min(1, 'Name is required');
export const emailSchema = z.email('Please enter a valid email');
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters');

export interface ValidationResult {
  isValid: boolean;
  error?: string | undefined;
  success?: string | undefined;
}

export function validateName(value: string): ValidationResult {
  if (!value) return { isValid: false };
  const result = nameSchema.safeParse(value);
  if (result.success) return { isValid: true, success: 'Looks good!' };
  return { isValid: false, error: result.error.issues[0]?.message };
}

export function validateEmail(value: string): ValidationResult {
  if (!value) return { isValid: false };
  const result = emailSchema.safeParse(value);
  if (result.success) return { isValid: true, success: 'Valid email' };
  return { isValid: false, error: result.error.issues[0]?.message };
}

export function validatePassword(value: string): ValidationResult {
  if (!value) return { isValid: false };
  const result = passwordSchema.safeParse(value);
  if (result.success) return { isValid: true, success: 'Password meets requirements' };
  return { isValid: false, error: result.error.issues[0]?.message };
}

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
