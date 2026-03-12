import { describe, it, expect } from 'vitest';
import { fireAndForget } from './fire-and-forget.js';

describe('fireAndForget', () => {
  it('does not throw when promise resolves', () => {
    const promise = Promise.resolve('success');
    expect(() => {
      fireAndForget(promise, 'test operation');
    }).not.toThrow();
  });

  it('silently swallows rejected promises', async () => {
    const promise = Promise.reject(new Error('Test error'));

    expect(() => {
      fireAndForget(promise, 'test operation');
    }).not.toThrow();

    // Wait for promise to settle — should not throw
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('silently swallows non-Error rejection values', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error rejection handling
    const promise = Promise.reject('string error');

    expect(() => {
      fireAndForget(promise, 'update balance');
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('returns void (no return value)', () => {
    const promise = Promise.resolve('value');
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- testing return type
    const result = fireAndForget(promise, 'test');
    expect(result).toBeUndefined();
  });
});
