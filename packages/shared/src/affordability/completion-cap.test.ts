import { describe, expect, it } from 'vitest';

import { callOutputCeilingTokens, effectiveCompletionCap } from './completion-cap.ts';

describe('effectiveCompletionCap', () => {
  it('falls back to the context length when the model declares no provider cap', () => {
    expect(effectiveCompletionCap({ contextLength: 128_000 })).toBe(128_000);
  });

  it('is the provider cap when the provider cap is the tighter bound', () => {
    expect(effectiveCompletionCap({ contextLength: 128_000, providerCap: 8192 })).toBe(8192);
  });

  it('stays at the context length when the declared provider cap exceeds it', () => {
    expect(effectiveCompletionCap({ contextLength: 8192, providerCap: 128_000 })).toBe(8192);
  });

  it('reads a zero provider cap as declared rather than absent', () => {
    expect(effectiveCompletionCap({ contextLength: 128_000, providerCap: 0 })).toBe(0);
  });

  it('reads an explicitly undefined provider cap as absent', () => {
    expect(effectiveCompletionCap({ contextLength: 4096, providerCap: undefined })).toBe(4096);
  });
});

describe('callOutputCeilingTokens', () => {
  const MODEL = { limits: { contextLength: 10_000, maxOutputTokens: 4000 } };

  it('takes a declared ceiling below the completion cap', () => {
    expect(callOutputCeilingTokens({ maxOutputTokens: 1200 }, MODEL)).toBe(1200);
  });

  it('bounds a declared ceiling above the completion cap by the cap', () => {
    expect(callOutputCeilingTokens({ maxOutputTokens: 9000 }, MODEL)).toBe(4000);
  });

  it('falls back to the completion cap when the call declares no ceiling', () => {
    expect(callOutputCeilingTokens({}, MODEL)).toBe(4000);
  });

  it('falls back to the context window when the model declares no provider cap', () => {
    expect(callOutputCeilingTokens({}, { limits: { contextLength: 10_000 } })).toBe(10_000);
  });

  it.each([0, -5, 1.5, Number.NaN, '1200'])(
    'falls back to the cap rather than under-reserving on the declaration %s',
    (declared) => {
      expect(callOutputCeilingTokens({ maxOutputTokens: declared }, MODEL)).toBe(4000);
    }
  );

  it('refuses a model that declares no context length', () => {
    expect(() => callOutputCeilingTokens({ maxOutputTokens: 100 }, { limits: {} })).toThrow(
      RangeError
    );
  });
});
