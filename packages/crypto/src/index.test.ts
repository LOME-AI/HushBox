import { describe, it, expect } from 'vitest';

describe('index barrel exports', () => {
  it('does NOT export raw primitives or removed functions', async () => {
    const module_ = await import('./index.js');

    expect('hkdfSha256' in module_).toBe(false);
    expect('sha256Hash' in module_).toBe(false);
    expect('bytesToHex' in module_).toBe(false);
    expect('symmetricEncrypt' in module_).toBe(false);
    expect('symmetricDecrypt' in module_).toBe(false);
    expect('eciesEncrypt' in module_).toBe(false);
    expect('eciesDecrypt' in module_).toBe(false);
    expect('constantTimeCompare' in module_).toBe(false);

    // Domain-separation labels live in the registry, not on the barrel. The
    // registry itself is package-internal: it is a compile-time guard over the
    // package's own primitives, and exporting it would invite a caller to pass
    // a label to something outside the package that never applies a prefix.
    expect('CONTENT_KEY_WRAP_LABEL' in module_).toBe(false);
    expect('RECOVERY_DUMMY_WRAPPED_KEY_LABEL' in module_).toBe(false);
    expect('RECOVERY_DUMMY_RESET_CHALLENGE_KEY_LABEL' in module_).toBe(false);
    expect('WRAP_LABELS' in module_).toBe(false);
    expect('SEAL_LABELS' in module_).toBe(false);
    expect('DERIVE_LABELS' in module_).toBe(false);

    expect('generateSalt' in module_).toBe(false);
    expect('KDF_PARAMS' in module_).toBe(false);
    expect('deriveWrappingKeyPair' in module_).toBe(false);
    expect('deriveRecoveryKeyPair' in module_).toBe(false);
    expect('deriveKeyPairFromSeed' in module_).toBe(false);

    expect('compress' in module_).toBe(false);
    expect('decompress' in module_).toBe(false);
    expect('compressIfSmaller' in module_).toBe(false);
    expect('encodeForEncryption' in module_).toBe(false);
    expect('decodeFromDecryption' in module_).toBe(false);

    expect('MNEMONIC_STRENGTH' in module_).toBe(false);

    expect('toBase64' in module_).toBe(false);
    expect('fromBase64' in module_).toBe(false);

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

    expect('createMessageShare' in module_).toBe(false);
    expect('decryptMessageShare' in module_).toBe(false);
    expect('SHARE_INFO' in module_).toBe(false);

    expect('encodeBinary' in module_).toBe(false);
    expect('decodeBinary' in module_).toBe(false);

    expect('DecryptionError' in module_).toBe(false);
    expect('InvalidBlobError' in module_).toBe(false);
    expect('KeyDerivationError' in module_).toBe(false);

    expect('wrapContentKeyForShare' in module_).toBe(false);
    expect('unwrapContentKeyForShare' in module_).toBe(false);
    expect('CONTENT_KEY_LENGTH' in module_).toBe(false);
    expect('SHARE_WRAP_INFO' in module_).toBe(false);

    expect('encryptTextWithContentKey' in module_).toBe(false);
    expect('decryptTextWithContentKey' in module_).toBe(false);
    expect('encryptBinaryWithContentKey' in module_).toBe(false);
    expect('decryptBinaryWithContentKey' in module_).toBe(false);
    expect('beginMessageEnvelope' in module_).toBe(false);
    expect('openMessageEnvelope' in module_).toBe(false);
    expect('wrapContentKeyForEpoch' in module_).toBe(false);
    expect('unwrapContentKeyForEpoch' in module_).toBe(false);
  });

  it('withholds the labelled wrap and seal primitives', async () => {
    const module_ = await import('./index.js');

    // Every one of these takes a `WrapLabel` or `SealLabel`, and the label
    // registry that mints them is package-internal (pinned above), so no caller
    // outside this package can construct an argument for them. Exporting them
    // published a surface nothing could call.
    expect('wrapSecretTo' in module_).toBe(false);
    expect('unwrapSecret' in module_).toBe(false);
    expect('sealWithKey' in module_).toBe(false);
    expect('openSealed' in module_).toBe(false);
    // The branded TOTP key is minted for callers by `deriveTotpEncryptionKey`;
    // the raw cast is how a caller would bypass that.
    expect('asTotpEncryptionKey' in module_).toBe(false);
  });

  it('exports the checked epoch-key opener and the key-chain verifier', async () => {
    const module_ = await import('./index.js');

    expect('openEpochWrap' in module_).toBe(true);
    expect('verifyKeyChain' in module_).toBe(true);
  });

  it('withholds the unchecked epoch-key openers', async () => {
    const module_ = await import('./index.js');

    // Each returned a key without checking it against the epoch's published
    // public key, so a caller could trust a key the server chose.
    expect('unwrapEpochKey' in module_).toBe(false);
    expect('traverseChainLink' in module_).toBe(false);
    expect('verifyEpochKeyConfirmation' in module_).toBe(false);
  });

  it('exports the link authentication token surface', async () => {
    const module_ = await import('./index.js');

    expect('deriveLinkAuthToken' in module_).toBe(true);
    expect('hashLinkAuthToken' in module_).toBe(true);
    expect('LINK_AUTH_TOKEN_BYTES' in module_).toBe(true);
  });

  it('exports the synchronous keyed digest', async () => {
    const module_ = await import('./index.js');

    expect('hmacSha256Hex' in module_).toBe(true);
  });

  it('exports the recovery-reset challenge surface', async () => {
    const module_ = await import('./index.js');

    expect('sealResetChallenge' in module_).toBe(true);
    expect('openResetChallenge' in module_).toBe(true);
    expect('deriveResetProof' in module_).toBe(true);
    expect('verifyResetProof' in module_).toBe(true);
    expect('RESET_CHALLENGE_NONCE_BYTES' in module_).toBe(true);
    expect('deriveDummyRecoveryPublicKey' in module_).toBe(true);
  });
});
