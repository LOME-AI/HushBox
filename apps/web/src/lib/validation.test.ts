import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  createValidator,
  validateName,
  validateEmail,
  validateIdentifier,
  validatePassword,
  validateConfirmPassword,
  validateRecoveryPhrase,
  validateUsername,
} from './validation';

describe('createValidator', () => {
  const testSchema = z.string().min(3, 'Must be at least 3 characters');

  it('returns not valid with no message for empty string', () => {
    const validate = createValidator(testSchema, 'Test value');
    const result = validate('');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns error when validation fails', () => {
    const validate = createValidator(testSchema, 'Test value');
    const result = validate('ab');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Must be at least 3 characters');
    expect(result.success).toBeUndefined();
  });

  it('returns success with custom message when validation passes', () => {
    const validate = createValidator(testSchema, 'Valid test');
    const result = validate('abc');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid test');
    expect(result.error).toBeUndefined();
  });

  it('uses default success message when none provided', () => {
    const validate = createValidator(testSchema);
    const result = validate('abc');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
    expect(result.error).toBeUndefined();
  });
});

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

describe('validateIdentifier', () => {
  it('returns not valid with no message for empty string', () => {
    const result = validateIdentifier('');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns success for valid email', () => {
    const result = validateIdentifier('user@example.com');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns success for valid username', () => {
    const result = validateIdentifier('testalice');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns success for username with underscores and numbers', () => {
    const result = validateIdentifier('alice_smith42');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns success for minimum length username', () => {
    const result = validateIdentifier('abc');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns error for string that is neither email nor username', () => {
    const result = validateIdentifier('!!invalid!!');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter a valid email or username');
  });

  it('returns error for username too short', () => {
    const result = validateIdentifier('ab');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter a valid email or username');
  });

  it('returns error for username starting with number', () => {
    const result = validateIdentifier('1alice');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter a valid email or username');
  });

  it('returns success for username with uppercase (normalized before validation)', () => {
    const result = validateIdentifier('Alice');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns success for space-separated username', () => {
    const result = validateIdentifier('John Smith');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns success for mixed-case multi-word username', () => {
    const result = validateIdentifier('John James Smith');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns error for invalid email format', () => {
    const result = validateIdentifier('user@');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter a valid email or username');
  });

  it('returns success for maximum length username (20 chars)', () => {
    const result = validateIdentifier('abcdefghijklmnopqrst');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Valid');
  });

  it('returns error for username exceeding max length', () => {
    const result = validateIdentifier('abcdefghijklmnopqrstu');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter a valid email or username');
  });
});

describe('validateUsername', () => {
  it('returns not valid for empty string', () => {
    const result = validateUsername('');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns success for valid title-case input with spaces', () => {
    const result = validateUsername('John Smith');
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('Looks good!');
  });

  it('returns success for already-normalized input', () => {
    const result = validateUsername('john_smith');
    expect(result.isValid).toBe(true);
  });

  it('returns success for single word', () => {
    const result = validateUsername('Alice');
    expect(result.isValid).toBe(true);
  });

  it('returns success for input with multiple spaces', () => {
    const result = validateUsername('John   Smith');
    expect(result.isValid).toBe(true);
  });

  it('returns error for input that normalizes too short', () => {
    const result = validateUsername('Ab');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for input starting with number', () => {
    const result = validateUsername('1 Bad Name');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for reserved username', () => {
    const result = validateUsername('Admin');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('This username is not available.');
  });

  it('returns error for reserved username regardless of casing', () => {
    const result = validateUsername('ADMIN');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('This username is not available.');
  });

  it('returns error for input normalizing to more than 20 chars', () => {
    const result = validateUsername('Abcdefghijklmnopqrstu');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  describe('rejects special characters', () => {
    it.each([
      ['john@smith', '@'],
      ['john#smith', '#'],
      ['john-smith', '-'],
      ['john.smith', '.'],
      ['john$smith', '$'],
      ['john!smith', '!'],
      ['john&smith', '&'],
      ['john*smith', '*'],
    ])('rejects "%s" (contains %s)', (input) => {
      const result = validateUsername(input);
      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });
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

describe('validateRecoveryPhrase', () => {
  it('returns not valid with no message for empty string', () => {
    const result = validateRecoveryPhrase('');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns not valid with no message for whitespace-only string', () => {
    const result = validateRecoveryPhrase('   \t  ');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeUndefined();
  });

  it('returns error for fewer than 12 words', () => {
    const result = validateRecoveryPhrase('one two three four five');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Recovery phrase must be exactly 12 words');
    expect(result.success).toBeUndefined();
  });

  it('returns success for exactly 12 words', () => {
    const result = validateRecoveryPhrase(
      'abandon ability able about above absent absorb abstract absurd abuse access accident'
    );
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('12 words entered');
    expect(result.error).toBeUndefined();
  });

  it('returns error for more than 12 words', () => {
    const result = validateRecoveryPhrase(
      'abandon ability able about above absent absorb abstract absurd abuse access accident extra'
    );
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Recovery phrase must be exactly 12 words');
    expect(result.success).toBeUndefined();
  });

  it('counts words correctly with extra whitespace between words', () => {
    const result = validateRecoveryPhrase(
      '  abandon  ability\table   about above  absent absorb abstract  absurd abuse  access  accident  '
    );
    expect(result.isValid).toBe(true);
    expect(result.success).toBe('12 words entered');
    expect(result.error).toBeUndefined();
  });
});
