// Errors
export { CryptoError, DecryptionError, InvalidBlobError, KeyDerivationError } from './errors.js';

// Account lifecycle
export {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
export type { CreateAccountResult, RegenerateRecoveryResult } from './account.js';

// Epoch management
export {
  createFirstEpoch,
  performEpochRotation,
  unwrapEpochKey,
  traverseChainLink,
  verifyEpochKeyConfirmation,
} from './epoch.js';
export type { EpochMemberWrap, CreateEpochResult, EpochRotationResult } from './epoch.js';

// Message encryption
export { encryptMessageForStorage, decryptMessage } from './message-encrypt.js';

// Member management
export { wrapEpochKeyForNewMember } from './member.js';

// Shared links
export { createSharedLink, deriveKeysFromLinkSecret } from './link.js';
export type { CreateSharedLinkResult } from './link.js';

// Message sharing
export { createMessageShare, decryptMessageShare } from './message-share.js';
export type { CreateMessageShareResult } from './message-share.js';

// TOTP (two-factor authentication)
export {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  generateTotpCodeSync,
} from './totp.js';

// Key pairs (domain-agnostic but needed externally)
export { generateKeyPair, getPublicKeyFromPrivate } from './sharing.js';
export type { KeyPair } from './sharing.js';

// Recovery phrases
export { generateRecoveryPhrase, validatePhrase, phraseToSeed } from './recovery-phrase.js';

// OPAQUE client
export {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
} from './opaque-client.js';
export type {
  RegistrationRequest,
  RegistrationResult,
  LoginRequest,
  LoginResult,
} from './opaque-client.js';

// OPAQUE server
export {
  OpaqueServerConfig,
  deriveServerCredentials,
  createOpaqueServer,
  createOpaqueServerFromEnv,
  createFakeRegistrationRecord,
  getServerIdentifier,
  OpaqueRegistrationRecord,
  OpaqueServerRegistrationRequest,
  OpaqueKE1,
  OpaqueKE3,
  OpaqueExpectedAuthResult,
} from './opaque-server.js';

// Webhook verification (HMAC-SHA256)
export { verifyHmacSha256Webhook, signHmacSha256Webhook } from './webhook.js';
export type { HmacWebhookSignParams, HmacWebhookVerifyParams } from './webhook.js';
