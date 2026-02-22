import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireAndForget } from './fire-and-forget.js';

describe('fireAndForget', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when promise resolves', () => {
    const promise = Promise.resolve('success');
    expect(() => {
      fireAndForget(promise, 'test operation');
    }).not.toThrow();
  });

  it('logs error when promise rejects', async () => {
    const error = new Error('Test error');
    const promise = Promise.reject(error);

    fireAndForget(promise, 'test operation');

    // Wait for promise to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(console.error).toHaveBeenCalledWith('Failed to test operation:', error);
  });

  it('includes error context in log message', async () => {
    const error = new Error('Database failure');
    const promise = Promise.reject(error);

    fireAndForget(promise, 'reset trial usage');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(console.error).toHaveBeenCalledWith('Failed to reset trial usage:', error);
  });

  it('handles non-Error rejection values', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error rejection handling
    const promise = Promise.reject('string error');

    fireAndForget(promise, 'update balance');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(console.error).toHaveBeenCalledWith('Failed to update balance:', 'string error');
  });

  it('returns void (no return value)', () => {
    const promise = Promise.resolve('value');
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- testing return type
    const result = fireAndForget(promise, 'test');
    expect(result).toBeUndefined();
  });
});
