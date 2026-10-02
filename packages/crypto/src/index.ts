/**
 * Crypto segregation: this package is the one home for all keyed cryptography —
 * every `@noble/*`, `@scure/*`, `@cloudflare/opaque` use and every keyed
 * `crypto.subtle` operation (AEAD, ECDH/wrap, HMAC/RSA signing) lives here and
 * nowhere else.
 *
 * Documented carve-out (keyless SHA-256): content-addressable / non-keyed
 * `sha256` hashing that binds no secret is NOT keyed crypto and may stay at its
 * call site rather than routing through this package. Five such sites exist by
 * design — rate-limit key derivation, canonical-JSON body hashing,
 * billing-portal and trial-quota identifiers, and roadmap normalization — each a
 * one-shot `crypto.subtle.digest('SHA-256', …)` over public/non-secret bytes.
 * Only keyed signing (e.g. FCM's RS256 OAuth JWT, `signRs256Jwt`) is relocated
 * into this package; keyless hashing is the explicit exception.
 */
export { DecryptionFailedError, UnknownKeyVersionError } from './errors.js';

export {
  KEY_BYTES,
  asWrappingPrivateKey,
  asWrappingPublicKey,
  asEpochPrivateKey,
  asEpochPublicKey,
  asContentKey,
  asShareSecret,
  generateAccountKeyPair,
  generateEpochKeyPair,
  generateContentKey,
  generateKeyPair,
  getPublicKeyFromPrivate,
} from './primitives/keys.js';
export type {
  /**
   * Named by no consumer's import, but reachable through the inferred type of
   * `generateAccountKeyPair().publicKey`: withholding it makes a consumer's own
   * exported binding unnameable (TS2883).
   * @compilerRequired
   */
  AccountPublicKey,
  WrappingPrivateKey,
  WrappingPublicKey,
  EpochPublicKey,
  ContentKey,
  KeyPair,
  OpaqueKek,
} from './primitives/keys.js';

export type { WrappedSecret } from './wrap/wrap.js';

export type { SealedSecret } from './wrap/seal.js';

export {
  asServerSecret,
  deriveDummyRecoveryPublicKey,
  deriveDummyRecoveryWrappedKey,
} from './recovery/dummy.js';

export {
  RESET_CHALLENGE_NONCE_BYTES,
  deriveResetProof,
  openResetChallenge,
  sealResetChallenge,
  verifyResetProof,
} from './recovery/challenge.js';

export { encryptContentEnvelope, decryptContentEnvelope } from './wrap/envelope.js';
export type { ContentLocation } from './wrap/envelope.js';

export { wrapContentKeyToEpoch, unwrapContentKeyFromEpoch } from './content/epoch.js';

export {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
export type { CreateAccountResult } from './account.js';

export {
  createFirstEpoch,
  performEpochRotation,
  openEpochWrap,
} from './content/epoch-lifecycle.js';

export { verifyKeyChain } from './content/key-chain.js';
export type { KeyChainVerdict } from './content/key-chain.js';

export {
  encryptTextForEpoch,
  decryptTextFromEpoch,
  encryptCustomInstructions,
  decryptCustomInstructions,
} from './content/message-encrypt.js';

export { wrapEpochKeyForNewMember } from './content/member.js';

export {
  LINK_AUTH_TOKEN_BYTES,
  createSharedLink,
  deriveKeysFromLinkSecret,
  deriveLinkAuthToken,
  hashLinkAuthToken,
} from './content/link.js';

export { createShare, openShare } from './content/message-share.js';
export type { CreateShareResult } from './content/message-share.js';

export { FINGERPRINT_BYTES } from './primitives/fingerprint.js';
export {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  decryptTotpSecret,
  totpKeyFingerprint,
  generateTotpSecret,
  generateTotpUri,
  generateTotpCodeSync,
  verifyTotpToken,
  decryptAndVerifyTotp,
} from './totp.js';

export { generateRecoveryPhrase, validatePhrase } from './recovery/phrase.js';

export {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
} from './opaque/client.js';

export {
  OpaqueServerConfig,
  createOpaqueServer,
  createFakeRegistrationRecord,
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueRegistrationRecord,
  OpaqueServerRegistrationRequest,
  OpaqueKE1,
} from './opaque/server.js';

export {
  mintServerMaterial,
  deriveServerMaterial,
  deriveOpaqueKek,
  opaqueKekFingerprint,
  sealServerMaterial,
  openServerMaterial,
} from './opaque/server-material.js';
export type { ServerMaterial } from './opaque/server-material.js';

export { opaqueStepUpInit, opaqueStepUpFinish } from './opaque/step-up.js';

export { verifyHmacSha256Webhook, signHmacSha256Webhook } from './webhook.js';

export { hmacSha256Hex } from './hmac.js';

export { signRs256Jwt } from './rs256-jwt.js';
