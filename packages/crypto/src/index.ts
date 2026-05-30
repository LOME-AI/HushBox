export { CryptoError, DecryptionError, InvalidBlobError, KeyDerivationError } from './errors.js';

export {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
export type { CreateAccountResult, RegenerateRecoveryResult } from './account.js';

export {
  createFirstEpoch,
  performEpochRotation,
  unwrapEpochKey,
  traverseChainLink,
  verifyEpochKeyConfirmation,
} from './epoch.js';
export type { EpochMemberWrap, CreateEpochResult, EpochRotationResult } from './epoch.js';

export {
  generateContentKey,
  wrapContentKeyForEpoch,
  unwrapContentKeyForEpoch,
  wrapContentKeyForShare,
  unwrapContentKeyForShare,
  CONTENT_KEY_LENGTH,
  SHARE_WRAP_INFO,
} from './content-key.js';
export type { ContentKey, WrappedContentKey } from './content-key.js';

export {
  beginMessageEnvelope,
  openMessageEnvelope,
  encryptTextWithContentKey,
  decryptTextWithContentKey,
  encryptBinaryWithContentKey,
  decryptBinaryWithContentKey,
  encryptTextForEpoch,
  decryptTextFromEpoch,
} from './message-encrypt.js';
export type { MessageEnvelope } from './message-encrypt.js';

export { wrapEpochKeyForNewMember } from './member.js';

export { createSharedLink, deriveKeysFromLinkSecret } from './link.js';
export type { CreateSharedLinkResult } from './link.js';

export { createShare, openShare } from './message-share.js';
export type { CreateShareResult } from './message-share.js';

export {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  generateTotpCodeSync,
  verifyTotpToken,
  decryptAndVerifyTotp,
} from './totp.js';
export type { DecryptAndVerifyTotpResult, VerifyTotpTokenResult } from './totp.js';

export { generateKeyPair, getPublicKeyFromPrivate } from './sharing.js';
export type { KeyPair } from './sharing.js';

export { generateRecoveryPhrase, validatePhrase, phraseToSeed } from './recovery-phrase.js';

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

export {
  OpaqueServerConfig,
  deriveServerCredentials,
  createOpaqueServer,
  createOpaqueServerFromEnv,
  createFakeRegistrationRecord,
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueRegistrationRecord,
  OpaqueServerRegistrationRequest,
  OpaqueKE1,
  OpaqueKE3,
  OpaqueExpectedAuthResult,
} from './opaque-server.js';

export { opaqueStepUpInit, opaqueStepUpFinish } from './opaque-step-up.js';
export type { FinishOutcome as OpaqueStepUpFinishOutcome } from './opaque-step-up.js';

export { verifyHmacSha256Webhook, signHmacSha256Webhook } from './webhook.js';
export type { HmacWebhookSignParams, HmacWebhookVerifyParams } from './webhook.js';
