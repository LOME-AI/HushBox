import {
  OpaqueServer,
  OpaqueClient,
  RegistrationRecord,
  getOpaqueConfig,
  OpaqueID,
  type AKEExportKeyPair,
} from '@cloudflare/opaque-ts';
import { hkdfSha256, sha256Hash, bytesToHex } from './hash.js';
import { textEncoder } from '@hushbox/shared';

export const OpaqueServerConfig = getOpaqueConfig(OpaqueID.OPAQUE_P256);

/**
 * Derives deterministic OPAQUE server credentials from master secret.
 * The master secret should be at least 32 bytes of high-entropy randomness.
 */
export async function deriveServerCredentials(
  masterSecret: Uint8Array
): Promise<{ oprfSeed: number[]; akeKeyPair: AKEExportKeyPair }> {
  const oprfSeed = hkdfSha256(
    masterSecret,
    textEncoder.encode('opaque-oprf-seed-v1'),
    undefined,
    32
  );

  const akeSeed = hkdfSha256(masterSecret, textEncoder.encode('opaque-ake-seed-v1'), undefined, 32);

  const akeKeyPair = await OpaqueServerConfig.ake.deriveAuthKeyPair(akeSeed);

  return {
    oprfSeed: [...oprfSeed],
    akeKeyPair: {
      private_key: [...akeKeyPair.private_key],
      public_key: [...akeKeyPair.public_key],
    },
  };
}

/**
 * Creates an OPAQUE server instance for authentication.
 */
export async function createOpaqueServer(
  masterSecret: Uint8Array,
  serverIdentifier: string
): Promise<OpaqueServer> {
  const { oprfSeed, akeKeyPair } = await deriveServerCredentials(masterSecret);

  return new OpaqueServer(OpaqueServerConfig, oprfSeed, akeKeyPair, serverIdentifier);
}

/**
 * Extracts the server identifier (hostname) from a URL.
 */
export function getServerIdentifier(frontendUrl: string): string {
  const url = new URL(frontendUrl);
  return url.host;
}

interface FakeRegistration {
  registrationRecord: RegistrationRecord;
  fakeSalt: Uint8Array;
}

let cachedFakeRegistration: FakeRegistration | null = null;
let cachedFakeKey: string | null = null;

/**
 * Creates an OPAQUE server instance from environment configuration.
 * Convenience wrapper that handles encoding and identifier extraction.
 */
export async function createOpaqueServerFromEnv(
  masterSecret: string,
  frontendUrl: string
): Promise<OpaqueServer> {
  const masterSecretBytes = textEncoder.encode(masterSecret);
  const serverIdentifier = getServerIdentifier(frontendUrl);
  return createOpaqueServer(masterSecretBytes, serverIdentifier);
}

/**
 * Creates a fake OPAQUE registration record for timing-safe responses
 * to non-existent users. Results are cached for performance.
 *
 * NOTE: Module-level mutable cache (server-only state).
 */
export async function createFakeRegistrationRecord(
  masterSecret: Uint8Array,
  serverIdentifier: string
): Promise<FakeRegistration> {
  const cacheKey = bytesToHex(
    sha256Hash(new Uint8Array([...masterSecret, ...textEncoder.encode(serverIdentifier)]))
  );
  if (cachedFakeRegistration && cachedFakeKey === cacheKey) {
    return cachedFakeRegistration;
  }

  const fakePassword = hkdfSha256(
    masterSecret,
    textEncoder.encode('opaque-fake-password-v1'),
    undefined,
    32
  );
  const fakeSalt = new Uint8Array(
    hkdfSha256(masterSecret, textEncoder.encode('opaque-fake-salt-v1'), undefined, 16)
  );

  const client = new OpaqueClient(OpaqueServerConfig);
  const server = await createOpaqueServer(masterSecret, serverIdentifier);

  const regInit = await client.registerInit(String.fromCodePoint(...fakePassword));
  if (regInit instanceof Error) throw regInit;

  const regResponse = await server.registerInit(regInit, 'fake-credential-id');
  if (regResponse instanceof Error) throw regResponse;

  const regFinish = await client.registerFinish(regResponse, serverIdentifier);
  if (regFinish instanceof Error) throw regFinish;

  cachedFakeRegistration = {
    registrationRecord: regFinish.record,
    fakeSalt,
  };
  cachedFakeKey = cacheKey;

  return cachedFakeRegistration;
}

// Re-export OPAQUE value types needed for server-side deserialization
export {
  RegistrationRecord as OpaqueRegistrationRecord,
  RegistrationRequest as OpaqueServerRegistrationRequest,
  KE1 as OpaqueKE1,
  KE3 as OpaqueKE3,
  ExpectedAuthResult as OpaqueExpectedAuthResult,
} from '@cloudflare/opaque-ts';
