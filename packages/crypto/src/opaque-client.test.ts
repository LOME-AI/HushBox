import { describe, it, expect } from 'vitest';
import {
  createOpaqueClient,
  OpaqueClientConfig,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
} from './opaque-client.js';

describe('opaque-client', () => {
  describe('createOpaqueClient', () => {
    it('creates an OPAQUE client instance', () => {
      const client = createOpaqueClient();

      expect(client).toBeDefined();
    });
  });

  describe('OpaqueClientConfig', () => {
    it('exports the OPAQUE configuration', () => {
      expect(OpaqueClientConfig).toBeDefined();
    });
  });

  describe('startRegistration', () => {
    it('returns a registration request with serialized array', async () => {
      const client = createOpaqueClient();

      const result = await startRegistration(client, 'test-password');

      expect(result).toHaveProperty('serialized');
      expect(Array.isArray(result.serialized)).toBe(true);
      expect(result.serialized.length).toBeGreaterThan(0);
    });

    it('returns different results for different passwords', async () => {
      const client1 = createOpaqueClient();
      const client2 = createOpaqueClient();

      const result1 = await startRegistration(client1, 'password1');
      const result2 = await startRegistration(client2, 'password2');

      // Requests should be different due to random blinding
      expect(result1.serialized).not.toEqual(result2.serialized);
    });

    it('throws when client is reused', async () => {
      const client = createOpaqueClient();

      await startRegistration(client, 'test-password');

      // Second call should throw because client is in REG_STARTED state
      await expect(startRegistration(client, 'test-password')).rejects.toThrow();
    });
  });

  describe('finishRegistration', () => {
    it('throws for invalid server response', async () => {
      const client = createOpaqueClient();
      await startRegistration(client, 'test-password');

      // Invalid server response should throw
      const invalidResponse = [1, 2, 3]; // Too short to be valid

      await expect(finishRegistration(client, invalidResponse)).rejects.toThrow();
    });
  });

  describe('startLogin', () => {
    it('returns a login request with ke1 array', async () => {
      const client = createOpaqueClient();

      const result = await startLogin(client, 'test-password');

      expect(result).toHaveProperty('ke1');
      expect(Array.isArray(result.ke1)).toBe(true);
      expect(result.ke1.length).toBeGreaterThan(0);
    });

    it('returns different results for different passwords', async () => {
      const client1 = createOpaqueClient();
      const client2 = createOpaqueClient();

      const result1 = await startLogin(client1, 'password1');
      const result2 = await startLogin(client2, 'password2');

      // ke1 should be different due to random ephemeral key
      expect(result1.ke1).not.toEqual(result2.ke1);
    });

    it('throws when client is reused', async () => {
      const client = createOpaqueClient();

      await startLogin(client, 'test-password');

      // Second call should throw because client is in AUTH_STARTED state
      await expect(startLogin(client, 'test-password')).rejects.toThrow();
    });
  });

  describe('finishLogin', () => {
    it('throws for invalid server response', async () => {
      const client = createOpaqueClient();
      await startLogin(client, 'test-password');

      // Invalid ke2 should throw
      const invalidKe2 = [1, 2, 3]; // Too short to be valid

      await expect(finishLogin(client, invalidKe2)).rejects.toThrow();
    });
  });
});
