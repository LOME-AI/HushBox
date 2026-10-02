export { createIdentityManifest } from './routes.js';
export type { IdentityRouteDeps } from './routes/deps.js';
export { createIdentityStores } from './adapters/stores.js';
// The retention delete for account_deletion_events — published so the cron
// composition root schedules the purge without writing an identity-owned table
// from outside the slice.
export { purgeExpiredAccountDeletionEvents } from './adapters/deletion-events-purge.js';

// The retention delete for verification_tokens — plaintext bearer credentials
// the consume path can no longer reach once they expire.
export { purgeExpiredVerificationTokens } from './adapters/verification-token-retention.js';

// Dev/E2E fixture states on `users` — published so the dev seed tooling puts
// an account into one through this slice, the table's single writer.
export {
  applyChargebackLock,
  setAccountCreatedAt,
  setEmailVerified,
} from './adapters/dev-fixtures.js';

// The registration settlement (account INSERT + wallet/welcome-credit
// provisioning in one transaction) — published on the barrel so the dev-only
// seed tool provisions personas through the slice's public surface instead of
// reaching into the domain module.
export { completeRegistration } from './domain/opaque/registration.js';
export type { AcquisitionStamp } from './domain/opaque/registration.js';

// The channel prompt's two verbs — published so the dev seed answers the
// question through the same path an account holder answers it through, rather
// than writing the acquisition row's answer columns from outside the slice.
export { applySelfReport } from './domain/account/acquisition-source.js';
// Per-IP abuse throttles for the unauthenticated auth surfaces, counted at the
// edge from the layers this slice's posture fragment declares.
export {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  verifyEmailIpRateLimit,
} from './domain/rate-limit.js';
export { IDENTITY_ROUTE_POSTURES } from './rate-limit-posture.js';

// The per-network lockouts' key derivations. Published because each identifier
// is a digest of the account and the caller's address rather than a value a key
// template can spell, so the dev auth reset clears them by calling the one
// derivation each flow spends them through.
export { loginNetworkLockoutKey, recoveryNetworkLockoutKeys } from './domain/keys.js';

export {
  SESSION_REVOKE_JOB_TYPE,
  checkBillingPortalRevocation,
  checkSessionLiveness,
  checkSessionRevocation,
  createSessionRevokeJobRegistration,
  evictUserBestEffort,
  issueBillingPortalCredential,
  issueSession,
  resolveLinkGuestPrincipal,
  resolveTrialSessionPrincipal,
  revokeAllSessions,
} from './domain/index.js';
export type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  AccountLockedEmailPort,
  EvictUserPort,
  IdentityStores,
  IdentityUsersStore,
  LinkResolutionPort,
  PasswordChangedEmailPort,
  PasswordResetEmailPort,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  TwoFactorLockedEmailPort,
  VerificationEmailPort,
} from './domain/index.js';
