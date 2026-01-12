import { describe, it, expect } from 'vitest';
import { getHelcimClient } from './index.js';

describe('getHelcimClient', () => {
  describe('in local development', () => {
    it('returns mock client when NODE_ENV is development', () => {
      const client = getHelcimClient({ NODE_ENV: 'development' });
      expect(client.isMock).toBe(true);
    });

    it('returns mock client when NODE_ENV is undefined', () => {
      const client = getHelcimClient({});
      expect(client.isMock).toBe(true);
    });

    it('returns mock client even if credentials are provided in local dev', () => {
      const client = getHelcimClient({
        NODE_ENV: 'development',
        HELCIM_API_TOKEN: 'token',
        HELCIM_WEBHOOK_VERIFIER: 'verifier',
      });
      expect(client.isMock).toBe(true);
    });
  });

  describe('in CI', () => {
    it('throws if HELCIM_API_TOKEN is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'development',
          CI: 'true',
          HELCIM_WEBHOOK_VERIFIER: 'verifier',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('throws if HELCIM_WEBHOOK_VERIFIER is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'development',
          CI: 'true',
          HELCIM_API_TOKEN: 'token',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('returns real client when credentials are provided', () => {
      const client = getHelcimClient({
        NODE_ENV: 'development',
        CI: 'true',
        HELCIM_API_TOKEN: 'token',
        HELCIM_WEBHOOK_VERIFIER: 'verifier',
      });
      expect(client.isMock).toBe(false);
    });
  });

  describe('in production', () => {
    it('throws if HELCIM_API_TOKEN is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'production',
          HELCIM_WEBHOOK_VERIFIER: 'verifier',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('throws if HELCIM_WEBHOOK_VERIFIER is missing', () => {
      expect(() =>
        getHelcimClient({
          NODE_ENV: 'production',
          HELCIM_API_TOKEN: 'token',
        })
      ).toThrow('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
    });

    it('returns real client when credentials are provided', () => {
      const client = getHelcimClient({
        NODE_ENV: 'production',
        HELCIM_API_TOKEN: 'token',
        HELCIM_WEBHOOK_VERIFIER: 'verifier',
      });
      expect(client.isMock).toBe(false);
    });
  });
});
