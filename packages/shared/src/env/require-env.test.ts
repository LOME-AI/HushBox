import { describe, it, expect } from 'vitest';

import { requireEnv } from './require-env.ts';

describe('requireEnv', () => {
  it('returns the value it is handed', () => {
    expect(requireEnv('VITE_API_URL', 'https://api.example.test')).toBe('https://api.example.test');
  });

  it('throws naming the variable when the value is absent', () => {
    expect(() => requireEnv('VITE_API_URL', undefined as unknown)).toThrow(
      'VITE_API_URL is required. Check envConfig and run pnpm generate:env.'
    );
  });

  it('throws naming the variable when the value is empty', () => {
    expect(() => requireEnv('VITE_SANDBOX_ORIGIN_URL', '')).toThrow(
      'VITE_SANDBOX_ORIGIN_URL is required. Check envConfig and run pnpm generate:env.'
    );
  });

  it('throws when the value is not a string at all', () => {
    expect(() => requireEnv('VITE_API_URL', 42)).toThrow('VITE_API_URL is required');
  });

  it('names whichever variable it is handed', () => {
    expect(() => requireEnv('VITE_CRAWLER_VIEW_URL', undefined as unknown)).toThrow(
      'VITE_CRAWLER_VIEW_URL is required'
    );
  });
});
