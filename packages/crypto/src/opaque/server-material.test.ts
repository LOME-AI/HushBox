import { describe, it, expect } from 'vitest';
import { concatBytes, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import {
  DecryptionFailedError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownKeyVersionError,
} from '../errors.js';
import { FINGERPRINT_BYTES, fingerprintOf } from '../primitives/fingerprint.js';
import { BLOB_FORMAT_VERSION, NONCE_BYTES, TAG_BYTES, utf8Field } from '../primitives/format.js';
import { bytesToHex } from '../primitives/hash.js';
import { asOpaqueKek, generateContentKey } from '../primitives/keys.js';
import { sealWithKey } from '../wrap/seal.js';
import { DERIVE_LABELS, SEAL_LABELS } from '../wrap/labels.js';
import { OpaqueServerConfig } from './config.js';
import {
  deriveOpaqueKek,
  deriveServerMaterial,
  mintServerMaterial,
  opaqueKekFingerprint,
  openServerMaterial,
  sealServerMaterial,
} from './server-material.js';
import type { ServerMaterial } from './server-material.js';

const KEK_SECRET = new TextEncoder().encode('test-opaque-kek-secret-at-least-32-bytes-long!!');
const OTHER_KEK_SECRET = new TextEncoder().encode(
  'other-opaque-kek-secret-at-least-32-bytes-long!'
);
const DECOY_SECRET = new TextEncoder().encode(
  'test-master-secret-at-least-32-bytes-long-for-security'
);
const USER_ID = testUuidV7(0x4e_e4);
const OTHER_USER_ID = testUuidV7(0x4e_e5);

const OPRF_SEED_BYTES = OpaqueServerConfig.hash.Nh;
const AKE_PRIVATE_BYTES = OpaqueServerConfig.ake.Nsk;
const AKE_PUBLIC_BYTES = OpaqueServerConfig.ake.Npk;
const MATERIAL_BYTES = OPRF_SEED_BYTES + AKE_PRIVATE_BYTES + AKE_PUBLIC_BYTES;

function encodeMaterial(material: ServerMaterial): Uint8Array {
  return Uint8Array.from([
    ...material.oprfSeed,
    ...material.akeKeyPair.private_key,
    ...material.akeKeyPair.public_key,
  ]);
}

describe('mintServerMaterial', () => {
  it('mints an OPRF seed of the configured hash width', async () => {
    const material = await mintServerMaterial();

    expect(material.oprfSeed).toHaveLength(OPRF_SEED_BYTES);
  });

  it('mints an AKE keypair of the configured widths', async () => {
    const material = await mintServerMaterial();

    expect(material.akeKeyPair.private_key).toHaveLength(AKE_PRIVATE_BYTES);
    expect(material.akeKeyPair.public_key).toHaveLength(AKE_PUBLIC_BYTES);
  });

  it('mints an AKE public key that belongs to its private key', async () => {
    const material = await mintServerMaterial();

    const recovered = OpaqueServerConfig.ake.recoverPublicKey(
      new Uint8Array(material.akeKeyPair.private_key)
    );

    expect([...recovered.public_key]).toEqual(material.akeKeyPair.public_key);
  });

  it('mints fresh material on every call', async () => {
    const first = await mintServerMaterial();
    const second = await mintServerMaterial();

    expect(first.oprfSeed).not.toEqual(second.oprfSeed);
    expect(first.akeKeyPair.private_key).not.toEqual(second.akeKeyPair.private_key);
  });
});

describe('deriveServerMaterial', () => {
  it('is deterministic for one secret', async () => {
    const first = await deriveServerMaterial(DECOY_SECRET);
    const second = await deriveServerMaterial(DECOY_SECRET);

    expect(first).toEqual(second);
  });

  it('differs across secrets', async () => {
    const first = await deriveServerMaterial(DECOY_SECRET);
    const second = await deriveServerMaterial(OTHER_KEK_SECRET);

    expect(first.oprfSeed).not.toEqual(second.oprfSeed);
    expect(first.akeKeyPair.private_key).not.toEqual(second.akeKeyPair.private_key);
  });

  it('reproduces the pinned vectors, so decoy records and seeded personas stay stable', async () => {
    const material = await deriveServerMaterial(DECOY_SECRET);

    expect(bytesToHex(new Uint8Array(material.oprfSeed))).toBe(
      '0fcdeffdfe67513b8055b8343bc9e3c21306b5808fca307177f81fe0e4ee8194'
    );
    expect(bytesToHex(new Uint8Array(material.akeKeyPair.private_key))).toBe(
      '46dc4de87ed30b345f10fe96fee11b84e1c6275b066a82f5a29a3e5c1641f785'
    );
    expect(bytesToHex(new Uint8Array(material.akeKeyPair.public_key))).toBe(
      '03787684e3727128cf0b06a6a698a6f9036a03ad5938f57b731631d22827f44fe8'
    );
  });
});

describe('deriveOpaqueKek', () => {
  it('derives a 32-byte key', () => {
    expect(deriveOpaqueKek(KEK_SECRET)).toHaveLength(32);
  });

  it('is deterministic for one secret', () => {
    expect(deriveOpaqueKek(KEK_SECRET)).toEqual(deriveOpaqueKek(KEK_SECRET));
  });

  it('differs across secrets', () => {
    expect(deriveOpaqueKek(KEK_SECRET)).not.toEqual(deriveOpaqueKek(OTHER_KEK_SECRET));
  });
});

describe('opaqueKekFingerprint', () => {
  it('is the fingerprint of the key under the KEK label', () => {
    const kek = deriveOpaqueKek(KEK_SECRET);

    expect(opaqueKekFingerprint(kek)).toEqual(
      fingerprintOf(kek, DERIVE_LABELS.opaqueKekFingerprint)
    );
    expect(opaqueKekFingerprint(kek)).toHaveLength(FINGERPRINT_BYTES);
  });
});

describe('sealServerMaterial / openServerMaterial', () => {
  it('round-trips material through seal and open', async () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const material = await mintServerMaterial();

    const opened = openServerMaterial(kek, USER_ID, sealServerMaterial(kek, USER_ID, material));

    expect(opened).toEqual(material);
  });

  it('lays the blob out as the KEK fingerprint followed by the sealed material', async () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const material = await mintServerMaterial();

    const blob = sealServerMaterial(kek, USER_ID, material);

    expect(blob.subarray(0, FINGERPRINT_BYTES)).toEqual(opaqueKekFingerprint(kek));
    expect(blob.at(FINGERPRINT_BYTES)).toBe(BLOB_FORMAT_VERSION);
    expect(blob).toHaveLength(FINGERPRINT_BYTES + 1 + NONCE_BYTES + MATERIAL_BYTES + TAG_BYTES);
  });

  it('is randomized: sealing the same material twice differs', async () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const material = await mintServerMaterial();

    expect(sealServerMaterial(kek, USER_ID, material)).not.toEqual(
      sealServerMaterial(kek, USER_ID, material)
    );
  });

  it('refuses to seal material of the wrong width', () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const material: ServerMaterial = {
      oprfSeed: [...randomBytes(OPRF_SEED_BYTES - 1)],
      akeKeyPair: {
        private_key: [...randomBytes(AKE_PRIVATE_BYTES)],
        public_key: [...randomBytes(AKE_PUBLIC_BYTES)],
      },
    };

    expect(() => sealServerMaterial(kek, USER_ID, material)).toThrow(InvalidParameterError);
  });

  it('throws UnknownKeyVersionError, carrying the blob fingerprint, under another KEK', async () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const otherKek = deriveOpaqueKek(OTHER_KEK_SECRET);
    const blob = sealServerMaterial(kek, USER_ID, await mintServerMaterial());

    let thrown: unknown;
    try {
      openServerMaterial(otherKek, USER_ID, blob);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnknownKeyVersionError);
    expect((thrown as UnknownKeyVersionError).fingerprint).toEqual(opaqueKekFingerprint(kek));
  });

  it('refuses a blob whose fingerprint was substituted, before touching the ciphertext', async () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const blob = new Uint8Array(sealServerMaterial(kek, USER_ID, await mintServerMaterial()));
    blob[0] = (blob[0] ?? 0) ^ 0x01;

    expect(() => openServerMaterial(kek, USER_ID, blob)).toThrow(UnknownKeyVersionError);
  });

  it('refuses a blob sealed for another user, under the same KEK', async () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const blob = sealServerMaterial(kek, USER_ID, await mintServerMaterial());

    expect(() => openServerMaterial(kek, OTHER_USER_ID, blob)).toThrow(DecryptionFailedError);
  });

  it('refuses a blob shorter than a fingerprint', () => {
    const kek = deriveOpaqueKek(KEK_SECRET);

    expect(() => openServerMaterial(kek, USER_ID, randomBytes(FINGERPRINT_BYTES - 1))).toThrow(
      MalformedBlobError
    );
  });

  it('refuses an authentic seal whose plaintext is not material-shaped', () => {
    const kek = deriveOpaqueKek(KEK_SECRET);
    const fingerprint = opaqueKekFingerprint(kek);
    const sealed = sealWithKey(
      kek,
      randomBytes(MATERIAL_BYTES - 1),
      SEAL_LABELS.opaqueServerMaterial,
      concatBytes(utf8Field(USER_ID), fingerprint)
    );

    expect(() => openServerMaterial(kek, USER_ID, concatBytes(fingerprint, sealed))).toThrow(
      MalformedBlobError
    );
  });

  /**
   * Pins the plaintext and AAD encodings themselves. The positive half fixes
   * the plaintext as `oprfSeed ‖ akePrivateKey ‖ akePublicKey` and the AAD as
   * `utf8Field(userId) ‖ fingerprint`; the negative half proves the fingerprint
   * is authenticated rather than merely read, so a substituted fingerprint can
   * never select a different key.
   */
  describe('encoding binding', () => {
    it('opens a blob sealed under the pinned plaintext and AAD encodings', async () => {
      const kek = deriveOpaqueKek(KEK_SECRET);
      const material = await mintServerMaterial();
      const fingerprint = opaqueKekFingerprint(kek);
      const sealed = sealWithKey(
        kek,
        encodeMaterial(material),
        SEAL_LABELS.opaqueServerMaterial,
        concatBytes(utf8Field(USER_ID), fingerprint)
      );

      expect(openServerMaterial(kek, USER_ID, concatBytes(fingerprint, sealed))).toEqual(material);
    });

    it('refuses a blob whose AAD names a different fingerprint', async () => {
      const kek = deriveOpaqueKek(KEK_SECRET);
      const fingerprint = opaqueKekFingerprint(kek);
      const sealed = sealWithKey(
        kek,
        encodeMaterial(await mintServerMaterial()),
        SEAL_LABELS.opaqueServerMaterial,
        concatBytes(utf8Field(USER_ID), opaqueKekFingerprint(deriveOpaqueKek(OTHER_KEK_SECRET)))
      );

      expect(() => openServerMaterial(kek, USER_ID, concatBytes(fingerprint, sealed))).toThrow(
        DecryptionFailedError
      );
    });
  });

  /**
   * Type test: the @ts-expect-error line asserts the marked call DOES NOT
   * compile. If another symmetric key class ever became assignable to
   * `OpaqueKek`, the directive would be flagged unused and `pnpm typecheck`
   * would fail.
   */
  it('rejects a content key where the KEK is expected (compile-time)', () => {
    const contentKeyAsKek = async (): Promise<Uint8Array> =>
      // @ts-expect-error — ContentKey is not assignable to OpaqueKek
      sealServerMaterial(generateContentKey(), USER_ID, await mintServerMaterial());
    expectCompileTimeProof(contentKeyAsKek);
  });

  it('accepts any 32 bytes branded as a KEK, not only a derived one', async () => {
    const kek = asOpaqueKek(
      hexToBytes('c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0')
    );
    const material = await mintServerMaterial();

    expect(openServerMaterial(kek, USER_ID, sealServerMaterial(kek, USER_ID, material))).toEqual(
      material
    );
  });
});
