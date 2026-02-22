import { describe, it, expect, vi } from 'vitest';

// Mock import.meta.env before importing the module
vi.mock('@hushbox/shared', () => ({
  frontendEnvSchema: {
    parse: () => ({ VITE_API_URL: 'http://localhost:8787' }),
  },
}));

import { ApiError, getApiUrl } from './api';

describe('getApiUrl', () => {
  it('returns the API URL from environment', () => {
    expect(getApiUrl()).toBe('http://localhost:8787');
  });
});

describe('ApiError', () => {
  it('creates an error with message, status, and data', () => {
    const error = new ApiError('Not found', 404, { detail: 'missing' });
    expect(error.message).toBe('Not found');
    expect(error.status).toBe(404);
    expect(error.data).toEqual({ detail: 'missing' });
    expect(error.name).toBe('ApiError');
  });

  it('extends Error', () => {
    const error = new ApiError('fail', 500);
    expect(error).toBeInstanceOf(Error);
  });
});
