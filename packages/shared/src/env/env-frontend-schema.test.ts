import { describe, it, expect } from 'vitest';

import { frontendEnvSchema } from './env-frontend-schema.ts';

describe('frontendEnvSchema', () => {
  it('validates VITE_API_URL', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_API_URL).toBe('http://localhost:8787');
    }
  });

  it('parses the exact three-key object the web app passes without VITE_WEB_URL', () => {
    // Pins apps/web/src/lib/api/api.ts's frontendEnvSchema.parse call, which
    // supplies only these three keys. A required VITE_WEB_URL would throw at
    // web-app module load; VITE_WEB_URL must stay optional (like VITE_ADMIN_URL).
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(true);
  });

  it('accepts VITE_WEB_URL when provided', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
      VITE_WEB_URL: 'https://hushbox.ai',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_WEB_URL).toBe('https://hushbox.ai');
    }
  });

  it('rejects invalid URL', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'not-a-url',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing VITE_API_URL', () => {
    const result = frontendEnvSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it('rejects missing VITE_PLATFORM', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing VITE_APP_VERSION', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
    });

    expect(result.success).toBe(false);
  });

  it('accepts explicit VITE_PLATFORM and VITE_APP_VERSION', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'ios',
      VITE_APP_VERSION: '1.2.3',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_PLATFORM).toBe('ios');
      expect(result.data.VITE_APP_VERSION).toBe('1.2.3');
    }
  });

  it('allows VITE_HELCIM_JS_TOKEN to be optional', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(true);
  });

  it('accepts VITE_HELCIM_JS_TOKEN when provided', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
      VITE_HELCIM_JS_TOKEN: 'some-token',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_HELCIM_JS_TOKEN).toBe('some-token');
    }
  });

  it('accepts VITE_DRIZZLE_STUDIO_URL when provided', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
      VITE_DRIZZLE_STUDIO_URL: 'http://localhost:4983',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_DRIZZLE_STUDIO_URL).toBe('http://localhost:4983');
    }
  });

  it('allows VITE_DRIZZLE_STUDIO_URL to be optional', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_PLATFORM: 'web',
      VITE_APP_VERSION: 'dev-local',
    });

    expect(result.success).toBe(true);
  });
});
