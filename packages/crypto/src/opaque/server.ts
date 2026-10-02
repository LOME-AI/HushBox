import { OpaqueServer, OpaqueClient, type RegistrationRecord } from '@cloudflare/opaque-ts';
import { textEncoder } from '@hushbox/shared';
import { hkdfSha256, sha256Hash, bytesToHex } from '../primitives/hash.js';
import { DERIVE_LABELS } from '../wrap/labels.js';
import { OpaqueServerConfig } from './config.js';
import { deriveServerMaterial } from './server-material.js';
import type { ServerMaterial } from './server-material.js';

export { OpaqueServerConfig } from './config.js';

/**
 * HKDF salts, not info labels — each is the domain separator every derivation
 * below already shipped with. Moving one into the info slot re-derives the
 * value and changes the fake record served for every unknown identifier.
 */
const FAKE_PASSWORD_HKDF_SALT = textEncoder.encode(DERIVE_LABELS.opaqueFakePassword);
const FAKE_SALT_HKDF_SALT = textEncoder.encode(DERIVE_LABELS.opaqueFakeSalt);

/**
 * Creates an OPAQUE server instance on one user's material. Synchronous: the
 * library constructor only copies and shape-checks the bytes.
 */
export function createOpaqueServer(
  material: ServerMaterial,
  serverIdentifier: string
): OpaqueServer {
  return new OpaqueServer(
    OpaqueServerConfig,
    material.oprfSeed,
    material.akeKeyPair,
    serverIdentifier
  );
}

/**
 * Fixed OPAQUE server identifier. URL-independent so domain changes never break auth.
 * Both client and server must use this same value.
 */
export const OPAQUE_SERVER_IDENTIFIER = 'opaque-server-v1';

interface FakeRegistration {
  registrationRecord: RegistrationRecord;
  fakeSalt: Uint8Array;
}

let cachedFakeRegistration: FakeRegistration | null = null;
let cachedFakeKey: string | null = null;

/**
 * Creates a fake OPAQUE registration record for timing-safe responses to
 * non-existent users, registered on the material the decoy secret derives.
 * Results are cached for performance.
 *
 * NOTE: Module-level mutable cache (server-only state).
 */
export async function createFakeRegistrationRecord(
  decoySecret: Uint8Array
): Promise<FakeRegistration> {
  const cacheKey = bytesToHex(
    sha256Hash(new Uint8Array([...decoySecret, ...textEncoder.encode(OPAQUE_SERVER_IDENTIFIER)]))
  );
  if (cachedFakeRegistration && cachedFakeKey === cacheKey) {
    return cachedFakeRegistration;
  }

  const fakePassword = hkdfSha256({
    ikm: decoySecret,
    salt: FAKE_PASSWORD_HKDF_SALT,
    info: undefined,
    length: 32,
  });
  const fakeSalt = new Uint8Array(
    hkdfSha256({ ikm: decoySecret, salt: FAKE_SALT_HKDF_SALT, info: undefined, length: 16 })
  );

  const client = new OpaqueClient(OpaqueServerConfig);
  const server = createOpaqueServer(
    await deriveServerMaterial(decoySecret),
    OPAQUE_SERVER_IDENTIFIER
  );

  const regInit = await client.registerInit(String.fromCodePoint(...fakePassword));
  if (regInit instanceof Error) throw regInit;

  const regResponse = await server.registerInit(regInit, 'fake-credential-id');
  if (regResponse instanceof Error) throw regResponse;

  const regFinish = await client.registerFinish(regResponse, OPAQUE_SERVER_IDENTIFIER);
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
