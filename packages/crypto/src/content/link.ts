import { randomBytes } from '@noble/hashes/utils.js';
import { epochWrapAad } from './epoch-lifecycle.js';
import { hkdfSha256, sha256Hash } from '../primitives/hash.js';
import {
  asAccountPublicKey,
  deriveKeyPairFromSeed,
  getPublicKeyFromPrivate,
  type KeyPair,
} from '../primitives/keys.js';
import { wrapSecretTo } from '../wrap/wrap.js';
import { DERIVE_LABELS, WRAP_LABELS } from '../wrap/labels.js';
import type { EpochLocation } from './epoch-lifecycle.js';

export const LINK_AUTH_TOKEN_BYTES = 32;

const encoder = new TextEncoder();

interface CreateSharedLinkResult {
  linkSecret: Uint8Array;
  linkPublicKey: Uint8Array;
  linkWrap: Uint8Array;
  linkAuthHash: Uint8Array;
}

export function createSharedLink(
  epochPrivateKey: Uint8Array,
  location: Omit<EpochLocation, 'epochPublicKey'>
): CreateSharedLinkResult {
  const linkSecret = randomBytes(32);
  const linkKeyPair = deriveKeyPairFromSeed(linkSecret, DERIVE_LABELS.linkKeyPair);
  // The link wrap is submitted as, and read back as, an ordinary member wrap
  // (a link guest is a member principal), so it carries the member label and
  // the member location binding.
  const linkWrap = wrapSecretTo(
    asAccountPublicKey(linkKeyPair.publicKey),
    epochPrivateKey,
    WRAP_LABELS.epochKeyMember,
    epochWrapAad({ ...location, epochPublicKey: getPublicKeyFromPrivate(epochPrivateKey) })
  );

  return {
    linkSecret,
    linkPublicKey: linkKeyPair.publicKey,
    linkWrap,
    linkAuthHash: hashLinkAuthToken(deriveLinkAuthToken(linkSecret)),
  };
}

export function deriveKeysFromLinkSecret(secret: Uint8Array): KeyPair {
  return deriveKeyPairFromSeed(secret, DERIVE_LABELS.linkKeyPair);
}

/**
 * The credential a link guest presents. It is derived from the link secret under
 * its own label, so it is neither the link's public key, which members can read,
 * nor the secret, which also derives the key that opens the link's epoch wraps.
 */
export function deriveLinkAuthToken(linkSecret: Uint8Array): Uint8Array {
  return hkdfSha256({
    ikm: linkSecret,
    salt: undefined,
    info: encoder.encode(DERIVE_LABELS.linkAuth),
    length: LINK_AUTH_TOKEN_BYTES,
  });
}

/**
 * The stored form of a link auth token, computed by the minting client and by the
 * server at resolution. A fast hash is sufficient because the token is a uniform
 * 256-bit value, which leaves no dictionary to search.
 */
export function hashLinkAuthToken(token: Uint8Array): Uint8Array {
  return sha256Hash(token);
}
