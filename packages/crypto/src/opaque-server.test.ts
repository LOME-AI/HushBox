import { describe, it, expect } from 'vitest';
import { RegistrationRecord, KE1 } from '@cloudflare/opaque-ts';
import {
  OpaqueServerConfig,
  deriveServerCredentials,
  createOpaqueServer,
  OPAQUE_SERVER_IDENTIFIER,
  createFakeRegistrationRecord,
  createOpaqueServerFromEnv,
  OpaqueRegistrationRecord,
  OpaqueKE1,
} from './opaque-server.js';
import { createOpaqueClient, startLogin } from './opaque-client.js';

describe('opaque-server', () => {
  const testMasterSecret = new TextEncoder().encode(
    'test-master-secret-at-least-32-bytes-long-for-security'
  );

  describe('OpaqueServerConfig', () => {
    it('exports the OPAQUE P256 configuration', () => {
      expect(OpaqueServerConfig).toBeDefined();
    });
  });

  describe('deriveServerCredentials', () => {
    it('derives OPRF seed and AKE keypair from master secret', async () => {
      const credentials = await deriveServerCredentials(testMasterSecret);

      expect(credentials).toHaveProperty('oprfSeed');
      expect(credentials).toHaveProperty('akeKeyPair');
      expect(Array.isArray(credentials.oprfSeed)).toBe(true);
      expect(credentials.oprfSeed.length).toBe(32);
    });

    it('returns AKE keypair with private and public keys', async () => {
      const credentials = await deriveServerCredentials(testMasterSecret);

      expect(credentials.akeKeyPair).toHaveProperty('private_key');
      expect(credentials.akeKeyPair).toHaveProperty('public_key');
      expect(Array.isArray(credentials.akeKeyPair.private_key)).toBe(true);
      expect(Array.isArray(credentials.akeKeyPair.public_key)).toBe(true);
      expect(credentials.akeKeyPair.private_key.length).toBeGreaterThan(0);
      expect(credentials.akeKeyPair.public_key.length).toBeGreaterThan(0);
    });

    it('produces deterministic output for same master secret', async () => {
      const credentials1 = await deriveServerCredentials(testMasterSecret);
      const credentials2 = await deriveServerCredentials(testMasterSecret);

      expect(credentials1.oprfSeed).toEqual(credentials2.oprfSeed);
      expect(credentials1.akeKeyPair.private_key).toEqual(credentials2.akeKeyPair.private_key);
      expect(credentials1.akeKeyPair.public_key).toEqual(credentials2.akeKeyPair.public_key);
    });

    it('produces different output for different master secrets', async () => {
      const otherSecret = new TextEncoder().encode(
        'different-master-secret-also-at-least-32-bytes'
      );

      const credentials1 = await deriveServerCredentials(testMasterSecret);
      const credentials2 = await deriveServerCredentials(otherSecret);

      expect(credentials1.oprfSeed).not.toEqual(credentials2.oprfSeed);
      expect(credentials1.akeKeyPair.private_key).not.toEqual(credentials2.akeKeyPair.private_key);
    });
  });

  describe('createOpaqueServer', () => {
    it('creates an OPAQUE server instance', async () => {
      const server = await createOpaqueServer(testMasterSecret, OPAQUE_SERVER_IDENTIFIER);

      expect(server).toBeDefined();
      expect(server.config).toBe(OpaqueServerConfig);
    });

    it('creates servers with consistent configuration for same inputs', async () => {
      const server1 = await createOpaqueServer(testMasterSecret, OPAQUE_SERVER_IDENTIFIER);
      const server2 = await createOpaqueServer(testMasterSecret, OPAQUE_SERVER_IDENTIFIER);

      expect(server1.config).toBe(server2.config);
    });
  });

  describe('createOpaqueServerFromEnv', () => {
    it('creates an OPAQUE server from string master secret', async () => {
      const server = await createOpaqueServerFromEnv(
        'test-master-secret-at-least-32-bytes-long-for-security'
      );

      expect(server).toBeDefined();
      expect(server.config).toBe(OpaqueServerConfig);
    });
  });

  describe('createFakeRegistrationRecord', () => {
    it('returns a registration record and fake salt', async () => {
      const result = await createFakeRegistrationRecord(testMasterSecret);

      expect(result).toHaveProperty('registrationRecord');
      expect(result).toHaveProperty('fakeSalt');
      expect(result.registrationRecord).toBeInstanceOf(RegistrationRecord);
      expect(result.fakeSalt).toBeInstanceOf(Uint8Array);
      expect(result.fakeSalt.length).toBe(16);
    });

    it('produces deterministic output for same inputs', async () => {
      const result1 = await createFakeRegistrationRecord(testMasterSecret);
      const result2 = await createFakeRegistrationRecord(testMasterSecret);

      expect(result1.registrationRecord.serialize()).toEqual(
        result2.registrationRecord.serialize()
      );
      expect(result1.fakeSalt).toEqual(result2.fakeSalt);
    });

    it('produces different output for different master secrets', async () => {
      const otherSecret = new TextEncoder().encode(
        'different-master-secret-also-at-least-32-bytes'
      );

      const result1 = await createFakeRegistrationRecord(testMasterSecret);
      const result2 = await createFakeRegistrationRecord(otherSecret);

      expect(result1.registrationRecord.serialize()).not.toEqual(
        result2.registrationRecord.serialize()
      );
    });

    it('can be used in authInit (produces valid KE2)', async () => {
      const { registrationRecord } = await createFakeRegistrationRecord(testMasterSecret);
      const server = await createOpaqueServer(testMasterSecret, OPAQUE_SERVER_IDENTIFIER);

      const client = createOpaqueClient();
      const { ke1: ke1Serialized } = await startLogin(client, 'some-password');

      const ke1 = KE1.deserialize(OpaqueServerConfig, ke1Serialized);

      const result = await server.authInit(ke1, registrationRecord, 'fake@example.com');
      expect(result).not.toBeInstanceOf(Error);
      expect(result).toHaveProperty('ke2');
      expect(result).toHaveProperty('expected');
    });

    it('caches the result after first call', async () => {
      const result1 = await createFakeRegistrationRecord(testMasterSecret);
      const result2 = await createFakeRegistrationRecord(testMasterSecret);

      expect(result1.registrationRecord).toBe(result2.registrationRecord);
      expect(result1.fakeSalt).toBe(result2.fakeSalt);
    });
  });

  describe('OPAQUE_SERVER_IDENTIFIER', () => {
    it('exports a fixed server identifier string', () => {
      expect(OPAQUE_SERVER_IDENTIFIER).toBe('opaque-server-v1');
    });
  });

  describe('re-exported OPAQUE value types', () => {
    it('exports OpaqueRegistrationRecord as a class with deserialize', () => {
      expect(OpaqueRegistrationRecord).toBeDefined();
      expect(typeof OpaqueRegistrationRecord.deserialize).toBe('function');
    });

    it('exports OpaqueKE1 as a class with deserialize', () => {
      expect(OpaqueKE1).toBeDefined();
      expect(typeof OpaqueKE1.deserialize).toBe('function');
    });
  });
});
