import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { testUuidV7 } from '@hushbox/shared/test-time';
import {
  LINK_AUTH_TOKEN_BYTES,
  createSharedLink,
  deriveKeysFromLinkSecret,
  deriveLinkAuthToken,
  hashLinkAuthToken,
} from './link.js';
import { DERIVE_LABELS } from '../wrap/labels.js';
import { generateKeyPair } from '../primitives/keys.js';
import { createFirstEpoch, openEpochWrap } from './epoch-lifecycle.js';

const CONVERSATION_ID = testUuidV7(5);
const OTHER_CONVERSATION_ID = testUuidV7(6);
const EPOCH_NUMBER = 3;
const LOCATION = { conversationId: CONVERSATION_ID, epochNumber: EPOCH_NUMBER };

function existingEpoch(): ReturnType<typeof createFirstEpoch> {
  return createFirstEpoch([generateKeyPair().publicKey], CONVERSATION_ID, EPOCH_NUMBER);
}

function commitmentOf(epoch: ReturnType<typeof createFirstEpoch>): {
  conversationId: string;
  epochNumber: number;
  epochPublicKey: Uint8Array;
  confirmationHash: Uint8Array;
} {
  return {
    ...LOCATION,
    epochPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
  };
}

describe('link', () => {
  it('uses link-keypair-v1 as HKDF info string', () => {
    expect(DERIVE_LABELS.linkKeyPair).toBe('link-keypair-v1');
  });

  it('uses hushbox/link-auth as the auth token HKDF info string', () => {
    expect(DERIVE_LABELS.linkAuth).toBe('hushbox/link-auth');
  });

  describe('createSharedLink', () => {
    it('returns linkSecret, linkPublicKey, and linkWrap', () => {
      const epoch = existingEpoch();

      const result = createSharedLink(epoch.epochPrivateKey, LOCATION);

      expect(result.linkSecret).toBeInstanceOf(Uint8Array);
      expect(result.linkSecret.length).toBe(32);
      expect(result.linkPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.linkPublicKey.length).toBe(32);
      expect(result.linkWrap).toBeInstanceOf(Uint8Array);
    });

    it('generates unique secrets per call', () => {
      const epoch = existingEpoch();

      const result1 = createSharedLink(epoch.epochPrivateKey, LOCATION);
      const result2 = createSharedLink(epoch.epochPrivateKey, LOCATION);

      expect(result1.linkSecret).not.toEqual(result2.linkSecret);
      expect(result1.linkPublicKey).not.toEqual(result2.linkPublicKey);
    });

    it('linkPublicKey corresponds to key derived from linkSecret', () => {
      const epoch = existingEpoch();

      const result = createSharedLink(epoch.epochPrivateKey, LOCATION);
      const derivedKeyPair = deriveKeysFromLinkSecret(result.linkSecret);

      expect(derivedKeyPair.publicKey).toEqual(result.linkPublicKey);
    });

    it('returns the hash of the auth token its secret derives', () => {
      const epoch = existingEpoch();

      const result = createSharedLink(epoch.epochPrivateKey, LOCATION);

      expect(result.linkAuthHash).toEqual(
        hashLinkAuthToken(deriveLinkAuthToken(result.linkSecret))
      );
    });
  });

  describe('deriveLinkAuthToken', () => {
    it('returns a token of LINK_AUTH_TOKEN_BYTES bytes', () => {
      const token = deriveLinkAuthToken(randomBytes(32));

      expect(token).toBeInstanceOf(Uint8Array);
      expect(token.length).toBe(LINK_AUTH_TOKEN_BYTES);
    });

    it('produces the same token for the same secret', () => {
      const secret = randomBytes(32);

      expect(deriveLinkAuthToken(secret)).toEqual(deriveLinkAuthToken(secret));
    });

    it('produces different tokens for different secrets', () => {
      expect(deriveLinkAuthToken(randomBytes(32))).not.toEqual(
        deriveLinkAuthToken(randomBytes(32))
      );
    });

    it('differs from the secret it derives from', () => {
      const secret = randomBytes(32);

      expect(deriveLinkAuthToken(secret)).not.toEqual(secret);
    });

    it('differs from the public key the same secret derives', () => {
      const secret = randomBytes(32);

      expect(deriveLinkAuthToken(secret)).not.toEqual(deriveKeysFromLinkSecret(secret).publicKey);
    });
  });

  describe('hashLinkAuthToken', () => {
    it('returns a 32-byte hash', () => {
      const hash = hashLinkAuthToken(deriveLinkAuthToken(randomBytes(32)));

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });

    it('produces the same hash for the same token', () => {
      const token = deriveLinkAuthToken(randomBytes(32));

      expect(hashLinkAuthToken(token)).toEqual(hashLinkAuthToken(token));
    });

    it('differs from the token it hashes', () => {
      const token = deriveLinkAuthToken(randomBytes(32));

      expect(hashLinkAuthToken(token)).not.toEqual(token);
    });

    it('produces different hashes for different tokens', () => {
      expect(hashLinkAuthToken(deriveLinkAuthToken(randomBytes(32)))).not.toEqual(
        hashLinkAuthToken(deriveLinkAuthToken(randomBytes(32)))
      );
    });
  });

  describe('deriveKeysFromLinkSecret', () => {
    it('returns a key pair with 32-byte keys', () => {
      const secret = randomBytes(32);

      const { publicKey, privateKey } = deriveKeysFromLinkSecret(secret);

      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBe(32);
      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(privateKey.length).toBe(32);
    });

    it('produces deterministic output for same secret', () => {
      const secret = randomBytes(32);

      const kp1 = deriveKeysFromLinkSecret(secret);
      const kp2 = deriveKeysFromLinkSecret(secret);

      expect(kp1.publicKey).toEqual(kp2.publicKey);
      expect(kp1.privateKey).toEqual(kp2.privateKey);
    });

    it('produces different output for different secrets', () => {
      const kp1 = deriveKeysFromLinkSecret(randomBytes(32));
      const kp2 = deriveKeysFromLinkSecret(randomBytes(32));

      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    });
  });

  describe('end-to-end link flow', () => {
    it('link secret holder can open the link wrap to the epoch key', () => {
      const epoch = existingEpoch();

      const link = createSharedLink(epoch.epochPrivateKey, LOCATION);

      const linkKeyPair = deriveKeysFromLinkSecret(link.linkSecret);
      expect(openEpochWrap(linkKeyPair.privateKey, link.linkWrap, commitmentOf(epoch))).toEqual({
        ok: true,
        key: epoch.epochPrivateKey,
      });
    });

    it('wrong secret cannot open the link wrap', () => {
      const epoch = existingEpoch();

      const link = createSharedLink(epoch.epochPrivateKey, LOCATION);

      const wrongKeyPair = deriveKeysFromLinkSecret(randomBytes(32));
      expect(openEpochWrap(wrongKeyPair.privateKey, link.linkWrap, commitmentOf(epoch))).toEqual({
        ok: false,
        reason: 'unwrap-failed',
      });
    });

    it.each([
      ['conversation', { conversationId: OTHER_CONVERSATION_ID }],
      ['epoch number', { epochNumber: EPOCH_NUMBER + 1 }],
      ['epoch public key', { epochPublicKey: generateKeyPair().publicKey }],
    ])('binds the link wrap to its %s', (_field, override) => {
      const epoch = existingEpoch();

      const link = createSharedLink(epoch.epochPrivateKey, LOCATION);

      const linkKeyPair = deriveKeysFromLinkSecret(link.linkSecret);
      expect(
        openEpochWrap(linkKeyPair.privateKey, link.linkWrap, {
          ...commitmentOf(epoch),
          ...override,
        })
      ).toEqual({ ok: false, reason: 'unwrap-failed' });
    });
  });
});
