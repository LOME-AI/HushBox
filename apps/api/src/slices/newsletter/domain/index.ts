export { confirmNewsletterSubscription } from './confirm.js';
export { callerUserId } from './principal.js';
export { readNewsletterSettings, writeNewsletterSettings } from './settings.js';
export { subscribeToNewsletter } from './subscribe.js';
export { applyWebhookSuppression } from './suppress.js';
export type { WebhookSuppressionApplication } from './suppress.js';
export { unsubscribeFromNewsletter } from './unsubscribe.js';
export { createResendWebhookVerifier } from './webhook-verify.js';
export type { ResendWebhookSecretEnv, ResendWebhookVerifier } from './webhook-verify.js';
export type {
  AccountEmailReaderFactory,
  NewsletterConfirmEmailPort,
  NewsletterStoresFactory,
} from '../ports/index.js';

// Routes import only this barrel + middleware (boundaries), so the lib
// surface the route seam needs — the uniform error-body constructor and the
// idempotency machinery the wrappers compose — is published here rather than
// imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export { okAsync } from '../../../lib/result/index.js';
// The literal address, for the consent-evidence record only — a rate-limit key
// is `callerIpId`, which collapses an IPv6 caller onto its /64.
export { resolveClientIp } from '../../../lib/redis/caller-ip.js';
export type { DomainError } from '../../../lib/errors/index.js';
