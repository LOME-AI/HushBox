import { describe, it, expect } from 'vitest';
import { resolveSandboxOrigin } from './sandbox-origin.ts';

describe('resolveSandboxOrigin', () => {
  it('returns a bare origin unchanged', () => {
    expect(resolveSandboxOrigin('https://sandbox.hushbox.ai')).toBe('https://sandbox.hushbox.ai');
  });

  it('strips path and query, so the emitted token is an origin rather than a URL', () => {
    expect(resolveSandboxOrigin('https://sandbox.hushbox.ai/render.html?x=1')).toBe(
      'https://sandbox.hushbox.ai'
    );
  });

  it('preserves an explicit port', () => {
    expect(resolveSandboxOrigin('http://localhost:7400')).toBe('http://localhost:7400');
  });

  it('fails fast when the value is unset rather than guessing an origin', () => {
    // Read from an empty bag rather than passing the literal: absence is what
    // both callers hand this function when the variable was never generated.
    const env: Record<string, string | undefined> = {};
    expect(() => resolveSandboxOrigin(env['SANDBOX_ORIGIN_URL'])).toThrow(/SANDBOX_ORIGIN_URL/);
  });

  it('fails fast when the value is empty rather than resolving same-origin', () => {
    expect(() => resolveSandboxOrigin('')).toThrow(/SANDBOX_ORIGIN_URL/);
  });

  it('fails fast on a value that is not a URL', () => {
    expect(() => resolveSandboxOrigin('sandbox.localhost')).toThrow(/not a valid URL/);
  });

  it('fails fast on a non-http(s) scheme, whose origin is the unusable literal null', () => {
    expect(new URL('capacitor://localhost').origin).toBe('null');
    expect(() => resolveSandboxOrigin('capacitor://localhost')).toThrow(/must use http or https/);
  });
});
