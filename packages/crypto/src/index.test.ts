import { describe, it, expect } from 'vitest';

describe('index barrel exports', () => {
  it('exports all expected functions and constants', async () => {
    const module_ = await import('./index.js');

    // Errors
    expect(typeof module_.CryptoError).toBe('function');
    expect(typeof module_.DecryptionError).toBe('function');
    expect(typeof module_.InvalidBlobError).toBe('function');
    expect(typeof module_.KeyDerivationError).toBe('function');

    // Account lifecycle
    expect(typeof module_.createAccount).toBe('function');
    expect(typeof module_.unwrapAccountKeyWithPassword).toBe('function');
    expect(typeof module_.recoverAccountFromMnemonic).toBe('function');
    expect(typeof module_.rewrapAccountKeyForPasswordChange).toBe('function');
    expect(typeof module_.regenerateRecoveryPhrase).toBe('function');

    // Epoch management
    expect(typeof module_.createFirstEpoch).toBe('function');
    expect(typeof module_.performEpochRotation).toBe('function');
    expect(typeof module_.unwrapEpochKey).toBe('function');
    expect(typeof module_.traverseChainLink).toBe('function');
    expect(typeof module_.verifyEpochKeyConfirmation).toBe('function');

    // Message encryption
    expect(typeof module_.encryptMessageForStorage).toBe('function');
    expect(typeof module_.decryptMessage).toBe('function');

    // Member management
    expect(typeof module_.wrapEpochKeyForNewMember).toBe('function');

    // Shared links
    expect(typeof module_.createSharedLink).toBe('function');
    expect(typeof module_.deriveKeysFromLinkSecret).toBe('function');

    // Message sharing
    expect(typeof module_.createMessageShare).toBe('function');
    expect(typeof module_.decryptMessageShare).toBe('function');

    // TOTP
    expect(typeof module_.deriveTotpEncryptionKey).toBe('function');
    expect(typeof module_.encryptTotpSecret).toBe('function');
    expect(typeof module_.decryptTotpSecret).toBe('function');
    expect(typeof module_.generateTotpSecret).toBe('function');
    expect(typeof module_.generateTotpUri).toBe('function');
    expect(typeof module_.verifyTotpCode).toBe('function');
    expect(typeof module_.generateTotpCodeSync).toBe('function');

    // Key pairs
    expect(typeof module_.generateKeyPair).toBe('function');
    expect(typeof module_.getPublicKeyFromPrivate).toBe('function');

    // Recovery phrases
    expect(typeof module_.generateRecoveryPhrase).toBe('function');
    expect(typeof module_.validatePhrase).toBe('function');
    expect(typeof module_.phraseToSeed).toBe('function');

    // OPAQUE client
    expect(typeof module_.createOpaqueClient).toBe('function');
    expect(typeof module_.startRegistration).toBe('function');
    expect(typeof module_.finishRegistration).toBe('function');
    expect(typeof module_.startLogin).toBe('function');
    expect(typeof module_.finishLogin).toBe('function');
    expect(module_.OpaqueClientConfig).toBeDefined();
    expect(module_.OpaqueRegistrationRequest).toBeDefined();

    // OPAQUE server
    expect(typeof module_.createOpaqueServer).toBe('function');
    expect(typeof module_.createOpaqueServerFromEnv).toBe('function');
    expect(typeof module_.deriveServerCredentials).toBe('function');
    expect(typeof module_.createFakeRegistrationRecord).toBe('function');
    expect(typeof module_.getServerIdentifier).toBe('function');
    expect(module_.OpaqueServerConfig).toBeDefined();
    expect(module_.OpaqueRegistrationRecord).toBeDefined();
    expect(module_.OpaqueServerRegistrationRequest).toBeDefined();
    expect(module_.OpaqueKE1).toBeDefined();
    expect(module_.OpaqueKE3).toBeDefined();
    expect(module_.OpaqueExpectedAuthResult).toBeDefined();

    // Webhook verification
    expect(typeof module_.verifyHmacSha256Webhook).toBe('function');
    expect(typeof module_.signHmacSha256Webhook).toBe('function');
  });

  it('does NOT export raw primitives or removed functions', async () => {
    const module_ = await import('./index.js');

    // Raw hash/crypto primitives (internal only)
    expect('hkdfSha256' in module_).toBe(false);
    expect('sha256Hash' in module_).toBe(false);
    expect('bytesToHex' in module_).toBe(false);
    expect('symmetricEncrypt' in module_).toBe(false);
    expect('symmetricDecrypt' in module_).toBe(false);
    expect('eciesEncrypt' in module_).toBe(false);
    expect('eciesDecrypt' in module_).toBe(false);
    expect('constantTimeCompare' in module_).toBe(false);

    // Internal key derivation
    expect('generateSalt' in module_).toBe(false);
    expect('KDF_PARAMS' in module_).toBe(false);
    expect('deriveWrappingKeyPair' in module_).toBe(false);
    expect('deriveRecoveryKeyPair' in module_).toBe(false);
    expect('deriveKeyPairFromSeed' in module_).toBe(false);

    // Internal compression/codec
    expect('compress' in module_).toBe(false);
    expect('decompress' in module_).toBe(false);
    expect('compressIfSmaller' in module_).toBe(false);
    expect('encodeForEncryption' in module_).toBe(false);
    expect('decodeFromDecryption' in module_).toBe(false);

    // Internal constants
    expect('MNEMONIC_STRENGTH' in module_).toBe(false);

    // Encoding utilities (moved to @hushbox/shared)
    expect('toBase64' in module_).toBe(false);
    expect('fromBase64' in module_).toBe(false);

    // Old removed functions
    expect('derivePasswordKEK' in module_).toBe(false);
    expect('deriveRecoveryKEK' in module_).toBe(false);
    expect('deriveConversationKey' in module_).toBe(false);
    expect('deriveMessageKey' in module_).toBe(false);
    expect('computePhraseVerifier' in module_).toBe(false);
    expect('verifyPhraseVerifier' in module_).toBe(false);
    expect('encrypt' in module_).toBe(false);
    expect('decrypt' in module_).toBe(false);
    expect('generateKey' in module_).toBe(false);
    expect('generateIV' in module_).toBe(false);
    expect('wrapKey' in module_).toBe(false);
    expect('unwrapKey' in module_).toBe(false);
    expect('EciesEncryptResult' in module_).toBe(false);
  });
});
