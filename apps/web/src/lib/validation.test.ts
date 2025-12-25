import { describe, it, expect } from 'vitest';
import {
  validateName,
  validateEmail,
  validatePassword,
  validateConfirmPassword,
} from './validation';

describe('validateName', () => {
  it('returns not valid with no message for empty string', () => {
    const result = validateName('');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns success for non-empty name', () => {
    const result = validateName('John');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Looks good!');
    expect(result.error).toBeUndefined();
  });
});

describe('validateEmail', () => {
  it('returns not valid with no message for empty string', () => {
    const result = validateEmail('');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns error for invalid email', () => {
    const result = validateEmail('notanemail');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter a valid email');
    expect(result.success).toBeUndefined();
  });

  it('returns success for valid email', () => {
    const result = validateEmail('test@example.com');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid email');
    expect(result.error).toBeUndefined();
  });
});

describe('validatePassword', () => {
  it('returns not valid with no message for empty string', () => {
    const result = validatePassword('');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns error for password shorter than 8 characters', () => {
    const result = validatePassword('short');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Password must be at least 8 characters');
    expect(result.success).toBeUndefined();
  });

  it('returns success for password with 8+ characters', () => {
    const result = validatePassword('password123');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Password meets requirements');
    expect(result.error).toBeUndefined();
  });
});

describe('validateConfirmPassword', () => {
  it('returns not valid with no message for empty confirm password', () => {
    const result = validateConfirmPassword('password123', '');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns error when passwords do not match', () => {
    const result = validateConfirmPassword('password123', 'different');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Passwords do not match');
    expect(result.success).toBeUndefined();
  });

  it('returns success when passwords match', () => {
    const result = validateConfirmPassword('password123', 'password123');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Passwords match');
    expect(result.error).toBeUndefined();
  });
});
