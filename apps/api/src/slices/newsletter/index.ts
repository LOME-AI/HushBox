export { createNewsletterManifest } from './routes.js';
export { NEWSLETTER_ROUTE_POSTURES } from './rate-limit-posture.js';
export {
  createNewsletterStores,
  listSubscribersForAdmin,
  subscriberStats,
} from './adapters/stores.js';
export type { AdminSubscriberRow, SubscriberStats } from './adapters/stores.js';
export { purgeUnconfirmedSubscribers } from './adapters/subscriber-retention.js';
// Dev/E2E subscriber fixtures, published so the dev route mints rows through
// this slice — `newsletter_subscribers` has one writer.
export { mintNewsletterSubscribers } from './adapters/dev-fixtures.js';
export { cancelIssueWithinTx, createIssueWithinTx, listIssues } from './adapters/issue-stores.js';
export type { NewsletterIssueRow } from './adapters/issue-stores.js';
export {
  NEWSLETTER_DISPATCH_JOB_TYPE,
  createNewsletterDispatchJobRegistration,
  enqueueIssueDispatch,
  newsletterDispatchPayloadSchema,
} from './domain/dispatch.js';
export { createNewsletterDispatchStores } from './adapters/dispatch-stores.js';
export { renderIssuePreview, sendIssueTest } from './domain/issue-email.js';
export type { IssueEmailUrls } from './domain/issue-email.js';
export { createResendWebhookVerifier } from './domain/index.js';
export type { ResendWebhookSecretEnv } from './domain/index.js';
export {
  newsletterConfirmIpRateLimit,
  newsletterSubscribeIpRateLimit,
  newsletterUnsubscribeIpRateLimit,
} from './domain/rate-limit.js';
export type { NewsletterConfirmEmailPort, NewsletterStoresFactory } from './ports/index.js';
