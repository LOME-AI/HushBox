import { describe, expect, it } from 'vitest';
import { requireFrontendUrl } from './frontend-url.js';

describe('requireFrontendUrl', () => {
  it('returns the configured frontend URL', () => {
    expect(
      requireFrontendUrl({ NODE_ENV: 'development', FRONTEND_URL: 'http://localhost:5173' })
    ).toBe('http://localhost:5173');
  });

  it('throws when FRONTEND_URL is absent', () => {
    expect(() => requireFrontendUrl({ NODE_ENV: 'development' })).toThrow(
      'FRONTEND_URL is required to build email links'
    );
  });

  it('throws when FRONTEND_URL is empty', () => {
    expect(() => requireFrontendUrl({ NODE_ENV: 'development', FRONTEND_URL: '' })).toThrow(
      'FRONTEND_URL is required to build email links'
    );
  });
});
