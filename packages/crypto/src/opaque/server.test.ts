import { describe, it, expect, vi, afterEach } from 'vitest';
import { RegistrationRecord, KE1, KE3, OpaqueClient, OpaqueServer } from '@cloudflare/opaque-ts';
import { expectExposes } from '@hushbox/shared/test-assertions';
import {
  OpaqueServerConfig,
  createOpaqueServer,
  OPAQUE_SERVER_IDENTIFIER,
  createFakeRegistrationRecord,
  OpaqueRegistrationRecord,
  OpaqueServerRegistrationRequest,
  OpaqueKE1,
} from './server.js';
import {
  createOpaqueClient,
  finishLogin,
  finishRegistration,
  startLogin,
  startRegistration,
} from './client.js';
import { deriveServerMaterial, mintServerMaterial } from './server-material.js';
import { bytesToHex } from '../primitives/hash.js';

describe('opaque-server', () => {
  const testDecoySecret = new TextEncoder().encode(
    'test-master-secret-at-least-32-bytes-long-for-security'
  );

  describe('OpaqueServerConfig', () => {
    it('exports the OPAQUE P256 configuration', () => {
      expect(OpaqueServerConfig).toBeDefined();
    });
  });

  describe('createOpaqueServer', () => {
    it('creates an OPAQUE server instance on the given material', async () => {
      const server = createOpaqueServer(await mintServerMaterial(), OPAQUE_SERVER_IDENTIFIER);

      expect(server).toBeDefined();
      expect(server.config).toBe(OpaqueServerConfig);
    });

    it('registers and then authenticates a client on minted material', async () => {
      const material = await mintServerMaterial();
      const password = 'minted-material-password';
      const credentialIdentifier = 'user@example.com';

      const regClient = createOpaqueClient();
      const { serialized } = await startRegistration(regClient, password);
      const regInit = await createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER).registerInit(
        OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized),
        credentialIdentifier
      );
      if (regInit instanceof Error) throw regInit;
      const { record } = await finishRegistration(
        regClient,
        regInit.serialize(),
        OPAQUE_SERVER_IDENTIFIER
      );

      // A fresh server on the same material bytes: what a later login builds.
      const loginServer = createOpaqueServer(structuredClone(material), OPAQUE_SERVER_IDENTIFIER);
      const loginClient = createOpaqueClient();
      const { ke1 } = await startLogin(loginClient, password);
      const authInit = await loginServer.authInit(
        OpaqueKE1.deserialize(OpaqueServerConfig, ke1),
        OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, record),
        credentialIdentifier
      );
      if (authInit instanceof Error) throw authInit;
      const { ke3 } = await finishLogin(
        loginClient,
        authInit.ke2.serialize(),
        OPAQUE_SERVER_IDENTIFIER
      );

      expect(
        loginServer.authFinish(KE3.deserialize(OpaqueServerConfig, ke3), authInit.expected)
      ).not.toBeInstanceOf(Error);
    });

    it('refuses a client registered on other material', async () => {
      const material = await mintServerMaterial();
      const password = 'other-material-password';
      const credentialIdentifier = 'user@example.com';

      const regClient = createOpaqueClient();
      const { serialized } = await startRegistration(regClient, password);
      const regInit = await createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER).registerInit(
        OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized),
        credentialIdentifier
      );
      if (regInit instanceof Error) throw regInit;
      const { record } = await finishRegistration(
        regClient,
        regInit.serialize(),
        OPAQUE_SERVER_IDENTIFIER
      );

      const otherServer = createOpaqueServer(await mintServerMaterial(), OPAQUE_SERVER_IDENTIFIER);
      const loginClient = createOpaqueClient();
      const { ke1 } = await startLogin(loginClient, password);
      const authInit = await otherServer.authInit(
        OpaqueKE1.deserialize(OpaqueServerConfig, ke1),
        OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, record),
        credentialIdentifier
      );
      if (authInit instanceof Error) throw authInit;

      // The library's own message when the envelope auth-tag MAC fails to verify.
      await expect(
        finishLogin(loginClient, authInit.ke2.serialize(), OPAQUE_SERVER_IDENTIFIER)
      ).rejects.toThrow('EnvelopeRecoveryError');
    });
  });

  describe('createFakeRegistrationRecord', () => {
    it('returns a registration record and fake salt', async () => {
      const result = await createFakeRegistrationRecord(testDecoySecret);

      expect(result).toHaveProperty('registrationRecord');
      expect(result).toHaveProperty('fakeSalt');
      expect(result.registrationRecord).toBeInstanceOf(RegistrationRecord);
      expect(result.fakeSalt).toBeInstanceOf(Uint8Array);
      expect(result.fakeSalt.length).toBe(16);
    });

    it('produces deterministic output for same inputs', async () => {
      const result1 = await createFakeRegistrationRecord(testDecoySecret);
      const result2 = await createFakeRegistrationRecord(testDecoySecret);

      expect(result1.registrationRecord.serialize()).toEqual(
        result2.registrationRecord.serialize()
      );
      expect(result1.fakeSalt).toEqual(result2.fakeSalt);
    });

    it('produces different output for different decoy secrets', async () => {
      const otherSecret = new TextEncoder().encode(
        'different-master-secret-also-at-least-32-bytes'
      );

      const result1 = await createFakeRegistrationRecord(testDecoySecret);
      const result2 = await createFakeRegistrationRecord(otherSecret);

      expect(result1.registrationRecord.serialize()).not.toEqual(
        result2.registrationRecord.serialize()
      );
    });

    it('reproduces the pinned fake salt, so timing-safe responses stay stable', async () => {
      const result = await createFakeRegistrationRecord(testDecoySecret);

      expect(bytesToHex(result.fakeSalt)).toBe('7f91131d49413059c215c4b4dcbeb8ea');
    });

    it('can be used in authInit on the decoy-derived material (produces valid KE2)', async () => {
      const { registrationRecord } = await createFakeRegistrationRecord(testDecoySecret);
      const server = createOpaqueServer(
        await deriveServerMaterial(testDecoySecret),
        OPAQUE_SERVER_IDENTIFIER
      );

      const client = createOpaqueClient();
      const { ke1: ke1Serialized } = await startLogin(client, 'some-password');

      const ke1 = KE1.deserialize(OpaqueServerConfig, ke1Serialized);

      const result = await server.authInit(ke1, registrationRecord, 'fake@example.com');
      expect(result).not.toBeInstanceOf(Error);
      expect(result).toHaveProperty('ke2');
      expect(result).toHaveProperty('expected');
    });

    it('caches the result after first call', async () => {
      const result1 = await createFakeRegistrationRecord(testDecoySecret);
      const result2 = await createFakeRegistrationRecord(testDecoySecret);

      expect(result1.registrationRecord).toBe(result2.registrationRecord);
      expect(result1.fakeSalt).toBe(result2.fakeSalt);
    });

    // The three forced-failure tests below characterize error propagation:
    // opaque-ts reports failures as returned Error values, and each internal
    // step of the fake-registration flow must surface such a failure as a
    // throw (never caching or returning a half-built record). No real input
    // can make these deterministic calls fail, so the library boundary is
    // stubbed for one call. Distinct decoy secrets bypass the module cache.
    describe('forced opaque-ts failures', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('throws when the client registerInit step fails', async () => {
        const secret = new TextEncoder().encode('forced-client-reg-init-failure-secret-32-bytes!!');
        vi.spyOn(OpaqueClient.prototype, 'registerInit').mockResolvedValueOnce(
          new Error('forced registerInit failure')
        );

        await expect(createFakeRegistrationRecord(secret)).rejects.toThrow(
          'forced registerInit failure'
        );
      });

      it('throws when the server registerInit step fails', async () => {
        const secret = new TextEncoder().encode('forced-server-reg-init-failure-secret-32-bytes!!');
        vi.spyOn(OpaqueServer.prototype, 'registerInit').mockResolvedValueOnce(
          new Error('forced server registerInit failure')
        );

        await expect(createFakeRegistrationRecord(secret)).rejects.toThrow(
          'forced server registerInit failure'
        );
      });

      it('throws when the client registerFinish step fails', async () => {
        const secret = new TextEncoder().encode('forced-client-reg-finish-failure-secret-32bytes!');
        vi.spyOn(OpaqueClient.prototype, 'registerFinish').mockResolvedValueOnce(
          new Error('forced registerFinish failure')
        );

        await expect(createFakeRegistrationRecord(secret)).rejects.toThrow(
          'forced registerFinish failure'
        );
      });
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
      expectExposes(OpaqueRegistrationRecord, 'deserialize');
    });

    it('exports OpaqueKE1 as a class with deserialize', () => {
      expect(OpaqueKE1).toBeDefined();
      expectExposes(OpaqueKE1, 'deserialize');
    });
  });
});
