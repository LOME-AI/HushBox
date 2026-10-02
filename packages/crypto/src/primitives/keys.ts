import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { InvalidKeyError } from '../errors.js';
import type { DeriveLabel } from '../wrap/labels.js';

/**
 * Branded key classes. Each class carries a distinct compile-time brand so a
 * key can never be passed where a different class is expected (argument
 * transposition is a type error, not a runtime surprise). Validators check
 * length before branding; raw `Uint8Array`s are never accepted by these APIs.
 */
export const KEY_BYTES = 32;

export type AccountPrivateKey = Uint8Array & { readonly __brand: 'crypto.AccountPrivateKey' };
export type AccountPublicKey = Uint8Array & { readonly __brand: 'crypto.AccountPublicKey' };
export type WrappingPrivateKey = Uint8Array & { readonly __brand: 'crypto.WrappingPrivateKey' };
export type WrappingPublicKey = Uint8Array & { readonly __brand: 'crypto.WrappingPublicKey' };
export type EpochPrivateKey = Uint8Array & { readonly __brand: 'crypto.EpochPrivateKey' };
export type EpochPublicKey = Uint8Array & { readonly __brand: 'crypto.EpochPublicKey' };
export type ContentKey = Uint8Array & { readonly __brand: 'crypto.ContentKey' };
export type ShareSecret = Uint8Array & { readonly __brand: 'crypto.ShareSecret' };
export type TotpEncryptionKey = Uint8Array & { readonly __brand: 'crypto.TotpEncryptionKey' };
export type OpaqueKek = Uint8Array & { readonly __brand: 'crypto.OpaqueKek' };

/** Any key class usable as a wrap recipient (X25519 public key). */
export type PublicKey = AccountPublicKey | WrappingPublicKey | EpochPublicKey;
/** Any key class usable to open a wrap (X25519 private key). */
export type PrivateKey = AccountPrivateKey | WrappingPrivateKey | EpochPrivateKey;
/** Any key class usable as a seal key (32 bytes of symmetric key material). */
export type SymmetricKey = ContentKey | ShareSecret | TotpEncryptionKey | OpaqueKek;

function assertKeyLength(keyClass: string, bytes: Uint8Array): void {
  if (bytes.length !== KEY_BYTES) {
    throw new InvalidKeyError(
      `${keyClass} must be ${String(KEY_BYTES)} bytes, got ${String(bytes.length)}`
    );
  }
}

/**
 * An all-zero or empty buffer is never key material anyone chose; it is a
 * buffer that was wiped, or never filled, and read anyway. Encrypting one
 * succeeds and produces a blob that opens to nothing usable, so for an account
 * key it costs the user every message they own, permanently, with a success
 * response. Nothing downstream can catch it — a server holding only ciphertext
 * cannot tell an encryption of zeros from any other — so the crypto seam is the
 * last place the class is visible, and it refuses rather than warns.
 *
 * Deliberately not constant-time: this compares against a fixed constant to
 * find a defect, not against a secret, so there is nothing for a timing
 * observer to learn.
 */
export function assertNotZeroed(role: string, bytes: Uint8Array): void {
  if (bytes.every((byte) => byte === 0)) {
    throw new InvalidKeyError(
      `Refusing to use ${role}: empty or all zero bytes is always a defect and never legal key material`
    );
  }
}

export function asAccountPrivateKey(bytes: Uint8Array): AccountPrivateKey {
  assertKeyLength('AccountPrivateKey', bytes);
  return bytes as AccountPrivateKey;
}

export function asAccountPublicKey(bytes: Uint8Array): AccountPublicKey {
  assertKeyLength('AccountPublicKey', bytes);
  return bytes as AccountPublicKey;
}

export function asWrappingPrivateKey(bytes: Uint8Array): WrappingPrivateKey {
  assertKeyLength('WrappingPrivateKey', bytes);
  return bytes as WrappingPrivateKey;
}

export function asWrappingPublicKey(bytes: Uint8Array): WrappingPublicKey {
  assertKeyLength('WrappingPublicKey', bytes);
  return bytes as WrappingPublicKey;
}

export function asEpochPrivateKey(bytes: Uint8Array): EpochPrivateKey {
  assertKeyLength('EpochPrivateKey', bytes);
  return bytes as EpochPrivateKey;
}

export function asEpochPublicKey(bytes: Uint8Array): EpochPublicKey {
  assertKeyLength('EpochPublicKey', bytes);
  return bytes as EpochPublicKey;
}

export function asContentKey(bytes: Uint8Array): ContentKey {
  assertKeyLength('ContentKey', bytes);
  return bytes as ContentKey;
}

export function asShareSecret(bytes: Uint8Array): ShareSecret {
  assertKeyLength('ShareSecret', bytes);
  return bytes as ShareSecret;
}

export function asTotpEncryptionKey(bytes: Uint8Array): TotpEncryptionKey {
  assertKeyLength('TotpEncryptionKey', bytes);
  return bytes as TotpEncryptionKey;
}

export function asOpaqueKek(bytes: Uint8Array): OpaqueKek {
  assertKeyLength('OpaqueKek', bytes);
  return bytes as OpaqueKek;
}

interface AccountKeyPair {
  publicKey: AccountPublicKey;
  privateKey: AccountPrivateKey;
}

interface EpochKeyPair {
  publicKey: EpochPublicKey;
  privateKey: EpochPrivateKey;
}

export function generateAccountKeyPair(): AccountKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    publicKey: asAccountPublicKey(publicKey),
    privateKey: asAccountPrivateKey(secretKey),
  };
}

export function generateEpochKeyPair(): EpochKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    publicKey: asEpochPublicKey(publicKey),
    privateKey: asEpochPrivateKey(secretKey),
  };
}

export function generateContentKey(): ContentKey {
  return asContentKey(randomBytes(KEY_BYTES));
}

/**
 * An X25519 keypair not yet committed to a key class. Account, epoch and link
 * keypairs are all this shape; the branded `as*` validators are what commit a
 * pair to one purpose, so the generic generators below stay unbranded rather
 * than claiming a class they cannot know.
 */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

const deriveEncoder = new TextEncoder();

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { publicKey, privateKey: secretKey };
}

export function deriveKeyPairFromSeed(seed: Uint8Array, info: DeriveLabel): KeyPair {
  const privateKey = hkdf(sha256, seed, undefined, deriveEncoder.encode(info), KEY_BYTES);
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

export function getPublicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}
