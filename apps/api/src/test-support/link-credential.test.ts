import { describe, expect, it } from 'vitest';
import { deriveKeysFromLinkSecret, deriveLinkAuthToken, hashLinkAuthToken } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { mintLinkCredential } from './link-credential.js';

describe('mintLinkCredential', () => {
  it('presents the token the link secret derives', () => {
    const minted = mintLinkCredential();
    expect(fromBase64(minted.token)).toEqual(deriveLinkAuthToken(minted.linkSecret));
  });

  it('stores the hash of the token it presents', () => {
    const minted = mintLinkCredential();
    expect(minted.linkAuthHash).toEqual(hashLinkAuthToken(fromBase64(minted.token)));
  });

  it('seats the public key the link secret derives', () => {
    const minted = mintLinkCredential();
    expect(minted.linkPublicKey).toEqual(deriveKeysFromLinkSecret(minted.linkSecret).publicKey);
  });

  it('mints a fresh secret on every call', () => {
    expect(mintLinkCredential().linkSecret).not.toEqual(mintLinkCredential().linkSecret);
  });
});
