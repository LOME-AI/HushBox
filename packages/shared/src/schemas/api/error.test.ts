import { describe, it, expect } from 'vitest';
import {
  errorResponseSchema,
  type ErrorResponse,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_INTERNAL,
} from './error.js';

describe('errorResponseSchema', () => {
  it('accepts minimal error response with just error message', () => {
    const input = { error: 'Something went wrong' };
    const result = errorResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe('Something went wrong');
      expect(result.data.code).toBeUndefined();
      expect(result.data.details).toBeUndefined();
    }
  });

  it('accepts error response with code', () => {
    const input = { error: 'Unauthorized', code: 'UNAUTHORIZED' };
    const result = errorResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('UNAUTHORIZED');
    }
  });

  it('accepts error response with details', () => {
    const input = {
      error: 'Validation failed',
      code: 'VALIDATION',
      details: { field: 'email', message: 'Invalid email format' },
    };
    const result = errorResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.details).toEqual({ field: 'email', message: 'Invalid email format' });
    }
  });

  it('rejects response without error message', () => {
    const input = { code: 'UNAUTHORIZED' };
    const result = errorResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('error codes', () => {
  it('exports UNAUTHORIZED code', () => {
    expect(ERROR_CODE_UNAUTHORIZED).toBe('UNAUTHORIZED');
  });

  it('exports NOT_FOUND code', () => {
    expect(ERROR_CODE_NOT_FOUND).toBe('NOT_FOUND');
  });

  it('exports VALIDATION code', () => {
    expect(ERROR_CODE_VALIDATION).toBe('VALIDATION');
  });

  it('exports INSUFFICIENT_BALANCE code', () => {
    expect(ERROR_CODE_INSUFFICIENT_BALANCE).toBe('INSUFFICIENT_BALANCE');
  });

  it('exports RATE_LIMITED code', () => {
    expect(ERROR_CODE_RATE_LIMITED).toBe('RATE_LIMITED');
  });

  it('exports INTERNAL code', () => {
    expect(ERROR_CODE_INTERNAL).toBe('INTERNAL');
  });
});

describe('ErrorResponse type', () => {
  it('can be used as a type annotation', () => {
    const response: ErrorResponse = {
      error: 'Test error',
      code: 'TEST',
      details: { foo: 'bar' },
    };
    expect(response.error).toBe('Test error');
  });
});
