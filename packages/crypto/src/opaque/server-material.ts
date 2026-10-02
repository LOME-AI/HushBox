import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { textEncoder } from '@hushbox/shared';
import { InvalidParameterError, MalformedBlobError, UnknownKeyVersionError } from '../errors.js';
import { constantTimeCompare } from '../primitives/constant-time.js';
import { FINGERPRINT_BYTES, fingerprintOf } from '../primitives/fingerprint.js';
import { utf8Field } from '../primitives/format.js';
import { hkdfSha256 } from '../primitives/hash.js';
import { asOpaqueKek } from '../primitives/keys.js';
import { sealWithKey, openSealed } from '../wrap/seal.js';
import { DERIVE_LABELS, SEAL_LABELS } from '../wrap/labels.js';
import { OpaqueServerConfig } from './config.js';
import type { AKEExportKeyPair } from '@cloudflare/opaque-ts';
import type { OpaqueKek } from '../primitives/keys.js';
import type { SealedSecret } from '../wrap/seal.js';

/**
 * One user's OPAQUE server side: the OPRF seed and AKE keypair every stored
 * registration record for that user is bound to. Minted once per registration,
 * never changed by a key swap — only re-sealed.
 */
export interface ServerMaterial {
  oprfSeed: number[];
  akeKeyPair: AKEExportKeyPair;
}

const OPRF_SEED_BYTES = OpaqueServerConfig.hash.Nh;
const AKE_SEED_BYTES = OpaqueServerConfig.constants.Nseed;
const AKE_PRIVATE_BYTES = OpaqueServerConfig.ake.Nsk;
const AKE_PUBLIC_BYTES = OpaqueServerConfig.ake.Npk;
const MATERIAL_BYTES = OPRF_SEED_BYTES + AKE_PRIVATE_BYTES + AKE_PUBLIC_BYTES;

/**
 * HKDF salts, not info labels — each is the domain separator every derivation
 * below already shipped with. Moving one into the info slot re-derives the
 * value and invalidates every decoy record and seeded persona.
 */
const OPRF_SEED_HKDF_SALT = textEncoder.encode(DERIVE_LABELS.opaqueOprfSeed);
const AKE_SEED_HKDF_SALT = textEncoder.encode(DERIVE_LABELS.opaqueAkeSeed);

export async function mintServerMaterial(): Promise<ServerMaterial> {
  return {
    oprfSeed: [...randomBytes(OPRF_SEED_BYTES)],
    akeKeyPair: await OpaqueServerConfig.ake.generateAuthKeyPair(),
  };
}

/**
 * Deterministic material from a secret, for the places that must reproduce it
 * without a row: the enumeration decoy and the seeded development personas.
 * A real account's material is minted, never derived.
 */
export async function deriveServerMaterial(secret: Uint8Array): Promise<ServerMaterial> {
  const oprfSeed = hkdfSha256({
    ikm: secret,
    salt: OPRF_SEED_HKDF_SALT,
    info: undefined,
    length: OPRF_SEED_BYTES,
  });
  const akeSeed = hkdfSha256({
    ikm: secret,
    salt: AKE_SEED_HKDF_SALT,
    info: undefined,
    length: AKE_SEED_BYTES,
  });
  const akeKeyPair = await OpaqueServerConfig.ake.deriveAuthKeyPair(akeSeed);

  return {
    oprfSeed: [...oprfSeed],
    akeKeyPair: {
      private_key: [...akeKeyPair.private_key],
      public_key: [...akeKeyPair.public_key],
    },
  };
}

export function deriveOpaqueKek(secret: Uint8Array): OpaqueKek {
  return asOpaqueKek(
    hkdfSha256({
      ikm: secret,
      salt: undefined,
      info: textEncoder.encode(DERIVE_LABELS.opaqueKek),
      length: 32,
    })
  );
}

export function opaqueKekFingerprint(kek: OpaqueKek): Uint8Array {
  return fingerprintOf(kek, DERIVE_LABELS.opaqueKekFingerprint);
}

/**
 * Length-prefixed userId then the fixed-width fingerprint: both fields are
 * self-delimiting, so no two (userId, fingerprint) pairs share AAD bytes.
 */
function materialAad(userId: string, fingerprint: Uint8Array): Uint8Array {
  return concatBytes(utf8Field(userId), fingerprint);
}

/** Fixed-width fields in a fixed order, so the plaintext needs no framing. */
function encodeMaterial(material: ServerMaterial): Uint8Array {
  const widths: [string, number[], number][] = [
    ['oprfSeed', material.oprfSeed, OPRF_SEED_BYTES],
    ['akeKeyPair.private_key', material.akeKeyPair.private_key, AKE_PRIVATE_BYTES],
    ['akeKeyPair.public_key', material.akeKeyPair.public_key, AKE_PUBLIC_BYTES],
  ];
  for (const [name, field, width] of widths) {
    if (field.length !== width) {
      throw new InvalidParameterError(
        `Server material ${name} must be ${String(width)} bytes, got ${String(field.length)}`
      );
    }
  }
  return Uint8Array.from([
    ...material.oprfSeed,
    ...material.akeKeyPair.private_key,
    ...material.akeKeyPair.public_key,
  ]);
}

function decodeMaterial(plaintext: Uint8Array): ServerMaterial {
  if (plaintext.length !== MATERIAL_BYTES) {
    throw new MalformedBlobError(
      `Server material must be ${String(MATERIAL_BYTES)} bytes, got ${String(plaintext.length)}`
    );
  }
  const privateKeyStart = OPRF_SEED_BYTES;
  const publicKeyStart = privateKeyStart + AKE_PRIVATE_BYTES;
  return {
    oprfSeed: [...plaintext.subarray(0, privateKeyStart)],
    akeKeyPair: {
      private_key: [...plaintext.subarray(privateKeyStart, publicKeyStart)],
      public_key: [...plaintext.subarray(publicKeyStart)],
    },
  };
}

/**
 * `fingerprint ‖ sealed`. The fingerprint rides both in the clear, so a reader
 * can tell which key sealed the row without trying it, and in the AAD, so a
 * substituted fingerprint fails authentication instead of selecting a key.
 */
export function sealServerMaterial(
  kek: OpaqueKek,
  userId: string,
  material: ServerMaterial
): Uint8Array {
  const fingerprint = opaqueKekFingerprint(kek);
  const sealed = sealWithKey(
    kek,
    encodeMaterial(material),
    SEAL_LABELS.opaqueServerMaterial,
    materialAad(userId, fingerprint)
  );
  return concatBytes(fingerprint, sealed);
}

export function openServerMaterial(
  kek: OpaqueKek,
  userId: string,
  blob: Uint8Array
): ServerMaterial {
  if (blob.length < FINGERPRINT_BYTES) {
    throw new MalformedBlobError(
      `Server material blob too short: ${String(blob.length)} bytes, missing the key fingerprint`
    );
  }
  const fingerprint = blob.subarray(0, FINGERPRINT_BYTES);
  if (!constantTimeCompare(fingerprint, opaqueKekFingerprint(kek))) {
    throw new UnknownKeyVersionError(fingerprint);
  }
  const plaintext = openSealed(
    kek,
    blob.subarray(FINGERPRINT_BYTES) as SealedSecret,
    SEAL_LABELS.opaqueServerMaterial,
    materialAad(userId, fingerprint)
  );
  return decodeMaterial(plaintext);
}
