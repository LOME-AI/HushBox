import { describe, it, expect } from 'vitest';
import { parseErrorMessage } from './auth';

describe('parseErrorMessage for a rate-limit refusal', () => {
  it('names the wait an attempt lockout carries', () => {
    expect(
      parseErrorMessage({ code: 'TOO_MANY_ATTEMPTS', details: { retryAfterSeconds: 120 } })
    ).toBe('Too many attempts. Try again in 2 minutes.');
  });

  it('names the wait a rate limit carries', () => {
    expect(parseErrorMessage({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 3 } })).toBe(
      'Too many attempts. Try again in 3 seconds.'
    );
  });

  it('says "in a moment" when the refusal carries no wait', () => {
    expect(parseErrorMessage({ code: 'TOO_MANY_ATTEMPTS' })).toBe(
      'Too many attempts. Try again in a moment.'
    );
  });

  it('keeps the code sentence for a refusal that is not a rate limit, whatever it carries', () => {
    expect(parseErrorMessage({ code: 'AUTH_FAILED', details: { retryAfterSeconds: 120 } })).toBe(
      'Incorrect username, email, or password. Please try again.'
    );
  });
});
