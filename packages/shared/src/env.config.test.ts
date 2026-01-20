import { describe, it, expect } from 'vitest';
import {
  envConfig,
  backendEnvSchema,
  frontendEnvSchema,
  Dest,
  Mode,
  isSecret,
  getDestinations,
  resolveRaw,
} from './env.config.js';

describe('envConfig', () => {
  describe('DATABASE_URL', () => {
    it('has development value going to Backend + Scripts', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.Development)).toEqual([
        Dest.Backend,
        Dest.Scripts,
      ]);
    });

    it('has ciVitest/ciE2E value going to Backend only (via ref)', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.CiVitest)).toEqual([Dest.Backend]);
      expect(getDestinations(envConfig.DATABASE_URL, Mode.CiE2E)).toEqual([Dest.Backend]);
    });

    it('has production secret going to Backend only', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.Production)).toEqual([Dest.Backend]);
      const raw = resolveRaw(envConfig.DATABASE_URL, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('NODE_ENV', () => {
    it('goes to Backend only', () => {
      expect(envConfig.NODE_ENV.to).toEqual([Dest.Backend]);
    });

    it('has development value', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.Development)).toBe('development');
    });

    it('has production value', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.Production)).toBe('production');
    });

    it('refs development for CI environments', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.CiVitest)).toBe('development');
      expect(resolveRaw(envConfig.NODE_ENV, Mode.CiE2E)).toBe('development');
    });
  });

  describe('BETTER_AUTH_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.BETTER_AUTH_URL.to).toEqual([Dest.Backend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.BETTER_AUTH_URL, Mode.Development)).toBe('http://localhost:8787');
      expect(resolveRaw(envConfig.BETTER_AUTH_URL, Mode.Production)).toBe(
        'https://api.lome-chat.com'
      );
    });
  });

  describe('FRONTEND_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.FRONTEND_URL.to).toEqual([Dest.Backend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.FRONTEND_URL, Mode.Development)).toBe('http://localhost:5173');
      expect(resolveRaw(envConfig.FRONTEND_URL, Mode.Production)).toBe('https://lome-chat.com');
    });
  });

  describe('CI flag', () => {
    it('goes to Backend only', () => {
      expect(envConfig.CI.to).toEqual([Dest.Backend]);
    });

    it('is only set in CI environments', () => {
      expect(resolveRaw(envConfig.CI, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.CI, Mode.CiVitest)).toBe('true');
      expect(resolveRaw(envConfig.CI, Mode.CiE2E)).toBe('true');
      expect(resolveRaw(envConfig.CI, Mode.Production)).toBeUndefined();
    });
  });

  describe('E2E flag', () => {
    it('goes to Backend only', () => {
      expect(envConfig.E2E.to).toEqual([Dest.Backend]);
    });

    it('is only set in ciE2E environment', () => {
      expect(resolveRaw(envConfig.E2E, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.E2E, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.E2E, Mode.CiE2E)).toBe('true');
      expect(resolveRaw(envConfig.E2E, Mode.Production)).toBeUndefined();
    });
  });

  describe('BETTER_AUTH_SECRET', () => {
    it('goes to Backend only', () => {
      expect(envConfig.BETTER_AUTH_SECRET.to).toEqual([Dest.Backend]);
    });

    it('has dev value and production secret', () => {
      expect(resolveRaw(envConfig.BETTER_AUTH_SECRET, Mode.Development)).toBe(
        'dev-secret-minimum-32-characters-long'
      );
      const raw = resolveRaw(envConfig.BETTER_AUTH_SECRET, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('RESEND_API_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.RESEND_API_KEY.to).toEqual([Dest.Backend]);
    });

    it('is only set in production (not in dev or CI)', () => {
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.CiE2E)).toBeUndefined();
      const production = resolveRaw(envConfig.RESEND_API_KEY, Mode.Production);
      expect(isSecret(production)).toBe(true);
    });
  });

  describe('OPENROUTER_API_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.OPENROUTER_API_KEY.to).toEqual([Dest.Backend]);
    });

    it('is only in ciVitest and production (NOT ciE2E)', () => {
      expect(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.CiVitest)).toBeDefined();
      expect(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.CiE2E)).toBeUndefined();
      expect(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.Production)).toBeDefined();
    });
  });

  describe('HELCIM_API_TOKEN', () => {
    it('goes to Backend only', () => {
      expect(envConfig.HELCIM_API_TOKEN.to).toEqual([Dest.Backend]);
    });

    it('is only in ciE2E and production (NOT ciVitest)', () => {
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiE2E)).toBeDefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Production)).toBeDefined();
    });

    it('uses different secrets for ciE2E and production', () => {
      const ciE2E = resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiE2E);
      const production = resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Production);
      expect(isSecret(ciE2E)).toBe(true);
      expect(isSecret(production)).toBe(true);
      expect(ciE2E).not.toEqual(production);
    });
  });

  describe('HELCIM_WEBHOOK_VERIFIER', () => {
    it('goes to Backend only', () => {
      expect(envConfig.HELCIM_WEBHOOK_VERIFIER.to).toEqual([Dest.Backend]);
    });

    it('has mock value for development (for local webhook testing)', () => {
      const dev = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Development);
      expect(dev).toBeDefined();
      expect(typeof dev).toBe('string');
      expect(isSecret(dev)).toBe(false);
    });

    it('uses different secrets for ciE2E and production', () => {
      const ciE2E = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.CiE2E);
      const production = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Production);
      expect(isSecret(ciE2E)).toBe(true);
      expect(isSecret(production)).toBe(true);
      expect(ciE2E).not.toEqual(production);
    });
  });

  describe('VITE_API_URL', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_API_URL.to).toEqual([Dest.Frontend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.VITE_API_URL, Mode.Development)).toBe('http://localhost:8787');
      expect(resolveRaw(envConfig.VITE_API_URL, Mode.Production)).toBe('https://api.lome-chat.com');
    });
  });

  describe('VITE_HELCIM_JS_TOKEN', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_HELCIM_JS_TOKEN.to).toEqual([Dest.Frontend]);
    });

    it('is only in ciE2E and production', () => {
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.CiE2E)).toBeDefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.Production)).toBeDefined();
    });
  });

  describe('VITE_CI', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_CI.to).toEqual([Dest.Frontend]);
    });

    it('is only set in CI environments', () => {
      expect(resolveRaw(envConfig.VITE_CI, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_CI, Mode.CiVitest)).toBe('true');
      expect(resolveRaw(envConfig.VITE_CI, Mode.CiE2E)).toBe('true');
      expect(resolveRaw(envConfig.VITE_CI, Mode.Production)).toBeUndefined();
    });
  });

  describe('MIGRATION_DATABASE_URL', () => {
    it('goes to Scripts only', () => {
      expect(envConfig.MIGRATION_DATABASE_URL.to).toEqual([Dest.Scripts]);
    });

    it('has development value', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.Development)).toContain(
        'postgresql://'
      );
    });

    it('is available in CI environments via ref', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.CiVitest)).toBeDefined();
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.CiE2E)).toBeDefined();
    });

    it('is not set in production (scripts not deployed)', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.Production)).toBeUndefined();
    });
  });
});

describe('backendEnvSchema', () => {
  it('validates correct development environment', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('validates correct production environment', () => {
    const validEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://neon.tech:5432/prod',
      BETTER_AUTH_URL: 'https://api.lome-chat.com',
      BETTER_AUTH_SECRET: 'a-production-secret-at-least-32-chars-long!!',
      FRONTEND_URL: 'https://lome-chat.com',
      RESEND_API_KEY: 're_123456789',
      OPENROUTER_API_KEY: 'sk-or-123',
      HELCIM_API_TOKEN: 'helcim-token',
      HELCIM_WEBHOOK_VERIFIER: 'webhook-verifier',
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('rejects invalid NODE_ENV', () => {
    const invalidEnv = {
      NODE_ENV: 'invalid',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects missing DATABASE_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects BETTER_AUTH_SECRET shorter than 32 characters', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'too-short',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL for BETTER_AUTH_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'not-a-url',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('allows CI/prod secrets to be optional', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });
});

describe('frontendEnvSchema', () => {
  it('validates VITE_API_URL', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_API_URL).toBe('http://localhost:8787');
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

  it('allows VITE_HELCIM_JS_TOKEN to be optional', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
    });

    expect(result.success).toBe(true);
  });

  it('accepts VITE_HELCIM_JS_TOKEN when provided', () => {
    const result = frontendEnvSchema.safeParse({
      VITE_API_URL: 'http://localhost:8787',
      VITE_HELCIM_JS_TOKEN: 'some-token',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_HELCIM_JS_TOKEN).toBe('some-token');
    }
  });
});
