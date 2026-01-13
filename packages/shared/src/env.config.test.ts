import { describe, it, expect } from 'vitest';
import {
  envConfig,
  workerEnvSchema,
  frontendEnvSchema,
  isEmptySecret,
  getDevKeys,
  getCiProdSecretKeys,
  isSecretRef,
  isDuplicateRef,
  getDuplicateKey,
} from './env.config.js';

describe('envConfig', () => {
  describe('worker section', () => {
    it('has NODE_ENV with dev and prod values', () => {
      expect(envConfig.worker.NODE_ENV.development).toBe('development');
      expect(envConfig.worker.NODE_ENV.production).toBe('production');
    });

    it('has BETTER_AUTH_URL with dev and prod values', () => {
      expect(envConfig.worker.BETTER_AUTH_URL.development).toBe('http://localhost:8787');
      expect(envConfig.worker.BETTER_AUTH_URL.production).toBe('https://api.lome-chat.com');
    });

    it('has FRONTEND_URL with dev and prod values', () => {
      expect(envConfig.worker.FRONTEND_URL.development).toBe('http://localhost:5173');
      expect(envConfig.worker.FRONTEND_URL.production).toBe('https://lome-chat.com');
    });

    it('has CI flag only in CI environments', () => {
      expect('development' in envConfig.worker.CI).toBe(false);
      expect(envConfig.worker.CI.ciVitest).toBe('true');
      expect(envConfig.worker.CI.ciE2E).toBe('duplicate_ciVitest');
      expect('production' in envConfig.worker.CI).toBe(false);
    });

    it('has E2E flag only in ciE2E environment', () => {
      expect('development' in envConfig.worker.E2E).toBe(false);
      expect('ciVitest' in envConfig.worker.E2E).toBe(false);
      expect(envConfig.worker.E2E.ciE2E).toBe('true');
      expect('production' in envConfig.worker.E2E).toBe(false);
    });
  });

  describe('workerSecrets section', () => {
    it('has DATABASE_URL with dev and production values', () => {
      expect(envConfig.workerSecrets.DATABASE_URL.development).toContain('postgres://');
      expect(envConfig.workerSecrets.DATABASE_URL.production).toBe('$DATABASE_URL');
    });

    it('has BETTER_AUTH_SECRET with dev and production values', () => {
      expect(envConfig.workerSecrets.BETTER_AUTH_SECRET.development).toBeTruthy();
      expect(envConfig.workerSecrets.BETTER_AUTH_SECRET.production).toBe('$BETTER_AUTH_SECRET');
    });

    it('has RESEND_API_KEY only in CI environments and production', () => {
      expect('development' in envConfig.workerSecrets.RESEND_API_KEY).toBe(false);
      expect(envConfig.workerSecrets.RESEND_API_KEY.ciVitest).toBe('$RESEND_API_KEY');
      expect(envConfig.workerSecrets.RESEND_API_KEY.ciE2E).toBe('duplicate_ciVitest');
    });

    it('has OPENROUTER_API_KEY only in ciVitest and production (not ciE2E)', () => {
      expect('development' in envConfig.workerSecrets.OPENROUTER_API_KEY).toBe(false);
      expect(envConfig.workerSecrets.OPENROUTER_API_KEY.ciVitest).toBe('$OPENROUTER_API_KEY');
      expect('ciE2E' in envConfig.workerSecrets.OPENROUTER_API_KEY).toBe(false);
      expect(envConfig.workerSecrets.OPENROUTER_API_KEY.production).toBe('duplicate_ciVitest');
    });

    it('has HELCIM secrets only in ciE2E and production (not ciVitest)', () => {
      expect('development' in envConfig.workerSecrets.HELCIM_API_TOKEN).toBe(false);
      expect('ciVitest' in envConfig.workerSecrets.HELCIM_API_TOKEN).toBe(false);
      expect(envConfig.workerSecrets.HELCIM_API_TOKEN.ciE2E).toBe('$HELCIM_API_TOKEN_SANDBOX');
      expect(envConfig.workerSecrets.HELCIM_API_TOKEN.production).toBe(
        '$HELCIM_API_TOKEN_PRODUCTION'
      );

      expect('development' in envConfig.workerSecrets.HELCIM_WEBHOOK_VERIFIER).toBe(false);
      expect('ciVitest' in envConfig.workerSecrets.HELCIM_WEBHOOK_VERIFIER).toBe(false);
      expect(envConfig.workerSecrets.HELCIM_WEBHOOK_VERIFIER.ciE2E).toBe(
        '$HELCIM_WEBHOOK_VERIFIER_SANDBOX'
      );
    });
  });

  describe('frontend section', () => {
    it('has VITE_API_URL with dev and prod values', () => {
      expect(envConfig.frontend.VITE_API_URL.development).toBe('http://localhost:8787');
      expect(envConfig.frontend.VITE_API_URL.production).toBe('https://api.lome-chat.com');
    });

    it('has VITE_HELCIM_JS_TOKEN only in ciE2E and production', () => {
      expect('development' in envConfig.frontend.VITE_HELCIM_JS_TOKEN).toBe(false);
      expect('ciVitest' in envConfig.frontend.VITE_HELCIM_JS_TOKEN).toBe(false);
      expect(envConfig.frontend.VITE_HELCIM_JS_TOKEN.ciE2E).toBe('$VITE_HELCIM_JS_TOKEN_SANDBOX');
      expect(envConfig.frontend.VITE_HELCIM_JS_TOKEN.production).toBe(
        '$VITE_HELCIM_JS_TOKEN_PRODUCTION'
      );
    });

    it('has VITE_CI only in CI environments', () => {
      expect('development' in envConfig.frontend.VITE_CI).toBe(false);
      expect(envConfig.frontend.VITE_CI.ciVitest).toBe('true');
      expect(envConfig.frontend.VITE_CI.ciE2E).toBe('duplicate_ciVitest');
      expect('production' in envConfig.frontend.VITE_CI).toBe(false);
    });
  });

  describe('local section', () => {
    it('has MIGRATION_DATABASE_URL with dev value only', () => {
      expect(envConfig.local.MIGRATION_DATABASE_URL.development).toContain('postgresql://');
      expect('production' in envConfig.local.MIGRATION_DATABASE_URL).toBe(false);
    });
  });
});

describe('helper functions', () => {
  describe('isEmptySecret', () => {
    it('returns true for empty object', () => {
      expect(isEmptySecret({})).toBe(true);
    });

    it('returns false for object with development value', () => {
      expect(isEmptySecret({ development: 'value' })).toBe(false);
    });

    it('returns true for object with CI values but no development value', () => {
      expect(isEmptySecret({ ciE2E: '$SECRET_SANDBOX' })).toBe(true);
      expect(isEmptySecret({ ciVitest: '$SECRET', production: '$SECRET' })).toBe(true);
    });
  });

  describe('getDevKeys', () => {
    it('returns keys with development values', () => {
      const keys = getDevKeys(envConfig.workerSecrets);
      expect(keys).toContain('DATABASE_URL');
      expect(keys).toContain('BETTER_AUTH_SECRET');
      expect(keys).not.toContain('RESEND_API_KEY');
    });

    it('returns all keys from worker section', () => {
      const keys = getDevKeys(envConfig.worker);
      expect(keys).toContain('NODE_ENV');
      expect(keys).toContain('BETTER_AUTH_URL');
      expect(keys).toContain('FRONTEND_URL');
    });
  });

  describe('getCiProdSecretKeys', () => {
    it('returns keys that are empty objects', () => {
      const keys = getCiProdSecretKeys(envConfig.workerSecrets);
      expect(keys).toContain('RESEND_API_KEY');
      expect(keys).toContain('OPENROUTER_API_KEY');
      expect(keys).toContain('HELCIM_API_TOKEN');
      expect(keys).toContain('HELCIM_WEBHOOK_VERIFIER');
      expect(keys).not.toContain('DATABASE_URL');
    });

    it('returns frontend CI/prod secrets', () => {
      const keys = getCiProdSecretKeys(envConfig.frontend);
      expect(keys).toContain('VITE_HELCIM_JS_TOKEN');
      expect(keys).not.toContain('VITE_API_URL');
    });
  });

  describe('isSecretRef', () => {
    it('returns true for strings starting with $', () => {
      expect(isSecretRef('$HELCIM_API_TOKEN_SANDBOX')).toBe(true);
      expect(isSecretRef('$DATABASE_URL')).toBe(true);
    });

    it('returns false for literal strings', () => {
      expect(isSecretRef('development')).toBe(false);
      expect(isSecretRef('http://localhost:8787')).toBe(false);
    });

    it('returns false for duplicate references', () => {
      expect(isSecretRef('duplicate_development')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isSecretRef('')).toBe(false);
    });
  });

  describe('isDuplicateRef', () => {
    it('returns true for strings starting with duplicate_', () => {
      expect(isDuplicateRef('duplicate_development')).toBe(true);
      expect(isDuplicateRef('duplicate_ciVitest')).toBe(true);
    });

    it('returns false for literal strings', () => {
      expect(isDuplicateRef('development')).toBe(false);
      expect(isDuplicateRef('production')).toBe(false);
    });

    it('returns false for secret references', () => {
      expect(isDuplicateRef('$SECRET_NAME')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isDuplicateRef('')).toBe(false);
    });
  });

  describe('getDuplicateKey', () => {
    it('extracts the key from duplicate reference', () => {
      expect(getDuplicateKey('duplicate_development')).toBe('development');
      expect(getDuplicateKey('duplicate_ciVitest')).toBe('ciVitest');
      expect(getDuplicateKey('duplicate_ciE2E')).toBe('ciE2E');
      expect(getDuplicateKey('duplicate_production')).toBe('production');
    });

    it('returns original string if not a duplicate reference', () => {
      expect(getDuplicateKey('development')).toBe('development');
    });
  });
});

describe('workerEnvSchema', () => {
  it('validates correct development environment', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = workerEnvSchema.safeParse(validEnv);
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

    const result = workerEnvSchema.safeParse(validEnv);
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

    const result = workerEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects missing DATABASE_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-32-characters-long',
      FRONTEND_URL: 'http://localhost:5173',
    };

    const result = workerEnvSchema.safeParse(invalidEnv);
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

    const result = workerEnvSchema.safeParse(invalidEnv);
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

    const result = workerEnvSchema.safeParse(invalidEnv);
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

    const result = workerEnvSchema.safeParse(validEnv);
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
