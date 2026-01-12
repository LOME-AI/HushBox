import { describe, it, expect } from 'vitest';
import {
  envConfig,
  workerEnvSchema,
  frontendEnvSchema,
  isEmptySecret,
  getDevKeys,
  getCiProdSecretKeys,
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
  });

  describe('workerSecrets section', () => {
    it('has DATABASE_URL with dev value only', () => {
      expect(envConfig.workerSecrets.DATABASE_URL.development).toContain('postgres://');
      expect('production' in envConfig.workerSecrets.DATABASE_URL).toBe(false);
    });

    it('has BETTER_AUTH_SECRET with dev value only', () => {
      expect(envConfig.workerSecrets.BETTER_AUTH_SECRET.development).toBeTruthy();
      expect('production' in envConfig.workerSecrets.BETTER_AUTH_SECRET).toBe(false);
    });

    it('has CI/prod secrets without development values', () => {
      expect(Object.keys(envConfig.workerSecrets.RESEND_API_KEY)).toHaveLength(0);
      expect(Object.keys(envConfig.workerSecrets.OPENROUTER_API_KEY)).toHaveLength(0);
      // Helcim secrets have CI secret name mappings but no development values
      expect('development' in envConfig.workerSecrets.HELCIM_API_TOKEN).toBe(false);
      expect(envConfig.workerSecrets.HELCIM_API_TOKEN.ciSecretNameSandbox).toBe(
        'HELCIM_API_TOKEN_SANDBOX'
      );
      expect('development' in envConfig.workerSecrets.HELCIM_WEBHOOK_VERIFIER).toBe(false);
      expect(envConfig.workerSecrets.HELCIM_WEBHOOK_VERIFIER.ciSecretNameSandbox).toBe(
        'HELCIM_WEBHOOK_VERIFIER_SANDBOX'
      );
    });
  });

  describe('frontend section', () => {
    it('has VITE_API_URL with dev and prod values', () => {
      expect(envConfig.frontend.VITE_API_URL.development).toBe('http://localhost:8787');
      expect(envConfig.frontend.VITE_API_URL.production).toBe('https://api.lome-chat.com');
    });

    it('has VITE_HELCIM_JS_TOKEN as CI/prod secret with name mappings', () => {
      expect('development' in envConfig.frontend.VITE_HELCIM_JS_TOKEN).toBe(false);
      expect(envConfig.frontend.VITE_HELCIM_JS_TOKEN.ciSecretNameSandbox).toBe(
        'VITE_HELCIM_JS_TOKEN_SANDBOX'
      );
      expect(envConfig.frontend.VITE_HELCIM_JS_TOKEN.ciSecretNameProduction).toBe(
        'VITE_HELCIM_JS_TOKEN_PRODUCTION'
      );
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

    it('returns true for object with CI secret names but no development value', () => {
      expect(isEmptySecret({ ciSecretNameSandbox: 'SECRET_SANDBOX' })).toBe(true);
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
