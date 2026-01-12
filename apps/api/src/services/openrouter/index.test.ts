import { describe, it, expect } from 'vitest';
import { getOpenRouterClient } from './index.js';

describe('getOpenRouterClient', () => {
  describe('in local development', () => {
    it('returns mock client when NODE_ENV is development', () => {
      const client = getOpenRouterClient({ NODE_ENV: 'development' });
      expect(client.isMock).toBe(true);
    });

    it('returns mock client when NODE_ENV is undefined', () => {
      const client = getOpenRouterClient({});
      expect(client.isMock).toBe(true);
    });

    it('returns mock client even if credentials are provided in local dev', () => {
      const client = getOpenRouterClient({
        NODE_ENV: 'development',
        OPENROUTER_API_KEY: 'sk-test-key',
      });
      expect(client.isMock).toBe(true);
    });
  });

  describe('in CI', () => {
    it('throws if OPENROUTER_API_KEY is missing', () => {
      expect(() =>
        getOpenRouterClient({
          NODE_ENV: 'development',
          CI: 'true',
        })
      ).toThrow('OPENROUTER_API_KEY required in CI/production');
    });

    it('returns real client when credentials are provided', () => {
      const client = getOpenRouterClient({
        NODE_ENV: 'development',
        CI: 'true',
        OPENROUTER_API_KEY: 'sk-test-key',
      });
      expect(client.isMock).toBe(false);
    });
  });

  describe('in production', () => {
    it('throws if OPENROUTER_API_KEY is missing', () => {
      expect(() =>
        getOpenRouterClient({
          NODE_ENV: 'production',
        })
      ).toThrow('OPENROUTER_API_KEY required in CI/production');
    });

    it('returns real client when credentials are provided', () => {
      const client = getOpenRouterClient({
        NODE_ENV: 'production',
        OPENROUTER_API_KEY: 'sk-test-key',
      });
      expect(client.isMock).toBe(false);
    });
  });

  describe('in CI E2E mode', () => {
    it('returns mock client even when credentials are provided', () => {
      // E2E tests use mocks - they test UI flows, not OpenRouter integration
      const client = getOpenRouterClient({
        NODE_ENV: 'development',
        CI: 'true',
        E2E: 'true',
        OPENROUTER_API_KEY: 'sk-test-key',
      });
      expect(client.isMock).toBe(true);
    });

    it('returns mock client without throwing even if credentials missing', () => {
      // E2E mode doesn't need real credentials
      const client = getOpenRouterClient({
        NODE_ENV: 'development',
        CI: 'true',
        E2E: 'true',
      });
      expect(client.isMock).toBe(true);
    });
  });
});
