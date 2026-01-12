import { describe, it, expect } from 'vitest';
import { createEnvUtils } from './env.js';

describe('createEnvUtils', () => {
  describe('isDev', () => {
    it('returns true when NODE_ENV is development', () => {
      const env = createEnvUtils({ NODE_ENV: 'development' });
      expect(env.isDev).toBe(true);
    });

    it('returns true when NODE_ENV is test', () => {
      const env = createEnvUtils({ NODE_ENV: 'test' });
      expect(env.isDev).toBe(true);
    });

    it('returns true when NODE_ENV is undefined (defaults to dev)', () => {
      const env = createEnvUtils({});
      expect(env.isDev).toBe(true);
    });

    it('returns false when NODE_ENV is production', () => {
      const env = createEnvUtils({ NODE_ENV: 'production' });
      expect(env.isDev).toBe(false);
    });

    it('returns true in CI with development NODE_ENV', () => {
      const env = createEnvUtils({ NODE_ENV: 'development', CI: 'true' });
      expect(env.isDev).toBe(true);
    });

    it('returns true in CI with test NODE_ENV', () => {
      const env = createEnvUtils({ NODE_ENV: 'test', CI: 'true' });
      expect(env.isDev).toBe(true);
    });
  });

  describe('isLocalDev', () => {
    it('returns true when NODE_ENV is development and CI is not set', () => {
      const env = createEnvUtils({ NODE_ENV: 'development' });
      expect(env.isLocalDev).toBe(true);
    });

    it('returns true when NODE_ENV is test and CI is not set', () => {
      const env = createEnvUtils({ NODE_ENV: 'test' });
      expect(env.isLocalDev).toBe(true);
    });

    it('returns true when NODE_ENV is undefined and CI is not set', () => {
      const env = createEnvUtils({});
      expect(env.isLocalDev).toBe(true);
    });

    it('returns false when NODE_ENV is development but CI is set', () => {
      const env = createEnvUtils({ NODE_ENV: 'development', CI: 'true' });
      expect(env.isLocalDev).toBe(false);
    });

    it('returns false when NODE_ENV is test but CI is set', () => {
      const env = createEnvUtils({ NODE_ENV: 'test', CI: 'true' });
      expect(env.isLocalDev).toBe(false);
    });

    it('returns false when NODE_ENV is production', () => {
      const env = createEnvUtils({ NODE_ENV: 'production' });
      expect(env.isLocalDev).toBe(false);
    });

    it('returns false when CI is any truthy string', () => {
      const env = createEnvUtils({ NODE_ENV: 'development', CI: '1' });
      expect(env.isLocalDev).toBe(false);
    });
  });

  describe('isProduction', () => {
    it('returns true when NODE_ENV is production', () => {
      const env = createEnvUtils({ NODE_ENV: 'production' });
      expect(env.isProduction).toBe(true);
    });

    it('returns false when NODE_ENV is development', () => {
      const env = createEnvUtils({ NODE_ENV: 'development' });
      expect(env.isProduction).toBe(false);
    });

    it('returns false when NODE_ENV is undefined', () => {
      const env = createEnvUtils({});
      expect(env.isProduction).toBe(false);
    });
  });

  describe('isCI', () => {
    it('returns true when CI is set', () => {
      const env = createEnvUtils({ CI: 'true' });
      expect(env.isCI).toBe(true);
    });

    it('returns true when CI is any truthy string', () => {
      const env = createEnvUtils({ CI: '1' });
      expect(env.isCI).toBe(true);
    });

    it('returns false when CI is not set', () => {
      const env = createEnvUtils({});
      expect(env.isCI).toBe(false);
    });

    it('returns false when CI is empty string', () => {
      const env = createEnvUtils({ CI: '' });
      expect(env.isCI).toBe(false);
    });
  });

  describe('requiresRealServices', () => {
    it('returns true in production', () => {
      const env = createEnvUtils({ NODE_ENV: 'production' });
      expect(env.requiresRealServices).toBe(true);
    });

    it('returns true in CI (even with development NODE_ENV)', () => {
      const env = createEnvUtils({ NODE_ENV: 'development', CI: 'true' });
      expect(env.requiresRealServices).toBe(true);
    });

    it('returns false in local development', () => {
      const env = createEnvUtils({ NODE_ENV: 'development' });
      expect(env.requiresRealServices).toBe(false);
    });

    it('returns false when NODE_ENV is undefined and CI is not set', () => {
      const env = createEnvUtils({});
      expect(env.requiresRealServices).toBe(false);
    });
  });

  describe('isE2E', () => {
    it('returns true when E2E is set', () => {
      const env = createEnvUtils({ E2E: 'true' });
      expect(env.isE2E).toBe(true);
    });

    it('returns true when E2E is any truthy string', () => {
      const env = createEnvUtils({ E2E: '1' });
      expect(env.isE2E).toBe(true);
    });

    it('returns false when E2E is not set', () => {
      const env = createEnvUtils({});
      expect(env.isE2E).toBe(false);
    });

    it('returns false when E2E is empty string', () => {
      const env = createEnvUtils({ E2E: '' });
      expect(env.isE2E).toBe(false);
    });

    it('returns true in CI E2E mode', () => {
      const env = createEnvUtils({ CI: 'true', E2E: 'true' });
      expect(env.isE2E).toBe(true);
      expect(env.isCI).toBe(true);
    });
  });
});
