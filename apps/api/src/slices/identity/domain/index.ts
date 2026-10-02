// This barrel exists for consumers outside domain/: domain-internal consumers
// import sibling modules directly. Publish a name here when a route or the
// slice surface needs it.
export {
  createRegisterFinishFlow,
  registerFinishBodySchema,
  registerInitBodySchema,
  startRegistration,
} from './opaque/registration.js';
export {
  createLoginFinishFlow,
  loginFinishBodySchema,
  loginInitBodySchema,
  startLogin,
} from './opaque/login.js';
export {
  destroySessionCookie,
  evictUserBestEffort,
  issueBillingPortalCredential,
  issueSession,
  revokeAllSessions,
  revokeSession,
} from './session/session.js';
export {
  SESSION_REVOKE_JOB_TYPE,
  createSessionRevokeJobRegistration,
} from './session/revoke-job.js';

export { billingTokenLogin, billingTokenLoginBodySchema } from './account/billing-portal.js';
export {
  checkBillingPortalRevocation,
  checkSessionLiveness,
  checkSessionRevocation,
} from './session/revocation.js';

export { resolveLinkGuestPrincipal } from './link-guest.js';

export { resolveTrialSessionPrincipal } from './trial-session.js';

export { duplicateFreshHandshakeDefect, identitySecretsFromEnv } from './opaque/opaque.js';
export type { IdentitySecrets } from './opaque/opaque.js';
export {
  createTotpVerifySetupFlow,
  startTotpSetup,
  totpCodeBodySchema,
  verifyLogin2fa,
} from './two-factor/totp.js';
export {
  changePasswordFinishBodySchema,
  changePasswordInitBodySchema,
  createPasswordChangeFinishFlow,
  startPasswordChange,
} from './account/password-change.js';
export {
  createDisable2faFinishFlow,
  disable2faFinishBodySchema,
  disable2faInitBodySchema,
  startDisable2fa,
} from './two-factor/disable.js';
export {
  createRecoveryResetFinishFlow,
  getRecoveryWrappedKey,
  recoveryGetKeyBodySchema,
  recoveryResetFinishBodySchema,
  recoveryResetInitBodySchema,
  startRecoveryReset,
} from './recovery/recovery.js';
export {
  createRecoverySaveFinishFlow,
  recoverySaveFinishBodySchema,
  recoverySaveInitBodySchema,
  startRecoverySave,
} from './recovery/save.js';
export { resolveMe } from './me.js';
export {
  resendVerification,
  resendVerificationBodySchema,
  verifyEmailBodySchema,
  verifyEmailToken,
} from './account/email-verification.js';
export {
  createDeleteAccountFinishFlow,
  deleteAccountFinishBodySchema,
  deleteAccountInitBodySchema,
  startDeleteAccount,
} from './account/deletion.js';
export type { RedisClient } from './keys.js';
export type { OpaqueFinishFlow } from './opaque/opaque.js';

export type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  AccountLockedEmailPort,
  EvictUserPort,
  IdentityStores,
  IdentityStoresFactory,
  IdentityUserRecord,
  IdentityUsersStore,
  LinkResolutionPort,
  PasswordChangedEmailPort,
  PasswordResetEmailPort,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  TwoFactorLockedEmailPort,
  VerificationEmailPort,
} from '../ports/index.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor and
// the idempotency wrappers the exemption declarations must compose with — is
// published here rather than imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export { okAsync } from '../../../lib/result/index.js';
export type { ResultAsync } from '../../../lib/result/index.js';
export type { DomainError } from '../../../lib/errors/index.js';

export { resolveClientIp } from '../../../lib/redis/index.js';

// The caller's address identity for a window that must BOUND something: it
// answers null where the sentinel would be one window every caller behind an
// edge fault shares, and login's per-network lockout refuses on that null
// rather than keying every such caller onto one account's window.
export { trustedCallerIpId as resolveTrustedCallerIpId } from '../../../lib/redis/index.js';

// Registration provisions the new user's wallets + welcome credit atomically
// with the account INSERT, composing billing's
// published within-tx helper. Routes may import only this domain barrel, so
// the billing types the route deps name are re-exported through here.
export type { BillingStores, WelcomeEmailPort } from '../../billing/index.js';

// Registration counts its first funnel step through growth's published door and
// resolves the signup link's tag against growth's live campaigns. Routes may
// import only this barrel, so the growth type the route deps name comes through
// here.
export type { GrowthStores } from '../../growth/index.js';

export { applySelfReport, readAcquisitionSource } from './account/acquisition-source.js';
