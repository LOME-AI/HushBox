import { randomBytes } from '@noble/hashes/utils.js';
import { deriveKeyPairFromSeed, type KeyPair } from './sharing.js';
import { eciesEncrypt } from './ecies.js';

export const LINK_INFO = 'link-keypair-v1';

export interface CreateSharedLinkResult {
  linkSecret: Uint8Array;
  linkPublicKey: Uint8Array;
  linkWrap: Uint8Array;
}

export function createSharedLink(epochPrivateKey: Uint8Array): CreateSharedLinkResult {
  const linkSecret = randomBytes(32);
  const linkKeyPair = deriveKeyPairFromSeed(linkSecret, LINK_INFO);
  const linkWrap = eciesEncrypt(linkKeyPair.publicKey, epochPrivateKey);

  return {
    linkSecret,
    linkPublicKey: linkKeyPair.publicKey,
    linkWrap,
  };
}

export function deriveKeysFromLinkSecret(secret: Uint8Array): KeyPair {
  return deriveKeyPairFromSeed(secret, LINK_INFO);
}
