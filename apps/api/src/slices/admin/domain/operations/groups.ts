import { bannerSet } from './banner.js';
import { feedbackSetStatus } from './feedback.js';
import {
  growthCampaignArchive,
  growthCampaignCreate,
  growthCampaignsRead,
  growthEventsRead,
  growthFreshnessRead,
  growthFunnelRead,
  growthMarketingRead,
  growthReachRead,
  growthSourcesRead,
} from './growth.js';
import { jobDiscard, jobRedrive, jobRestore } from './job.js';
import { modelDisable, modelEnable } from './model.js';
import { newsletterCancel, newsletterSchedule, newsletterTestSend } from './newsletter.js';
import {
  paymentForceCompleteAndCredit,
  paymentForceExpire,
  paymentRestoreAwaitingWebhook,
  paymentUncompleteAndClawback,
} from './payment.js';
import { shareRevoke, shareUnrevoke } from './share.js';
import {
  twoFactorClear,
  twoFactorClearStranded,
  twoFactorRestore,
  twoFactorRestoreStranded,
} from './two-factor.js';
import { sessionsRevokeAll, userLock, userUnlock } from './user.js';
import { walletClawback, walletCredit } from './wallet.js';
import type { z } from 'zod';
import type { AdminOpImplementation } from '../registry.js';
import type { AdminBannerDeps } from './banner.js';
import type { AdminFeedbackDeps } from './feedback.js';
import type { AdminGrowthDeps } from './growth.js';
import type { AdminJobDeps } from './job.js';
import type { AdminModelDeps } from './model.js';
import type { AdminNewsletterDeps, AdminNewsletterPostDeps } from './newsletter.js';
import type { AdminPaymentDeps, AdminPaymentPostDeps } from './payment.js';
import type { AdminShareDeps, AdminSharePostDeps } from './share.js';
import type { AdminTwoFactorDeps } from './two-factor.js';
import type { AdminUserDeps, AdminUserPostDeps } from './user.js';
import type { AdminWalletDeps, AdminWalletPostDeps } from './wallet.js';

/**
 * The v1 admin op implementations, grouped per composed-slice dependency
 * set and combined into one list so every registry construction over it
 * passes the Iron Law gate (a durable mutation without its registered
 * inverse fails `createAdminOpRegistry` at boot).
 */
export const adminWalletOperations: readonly AdminOpImplementation<
  AdminWalletDeps,
  z.ZodObject,
  AdminWalletPostDeps
>[] = [walletCredit, walletClawback];

export const adminPaymentOperations: readonly AdminOpImplementation<
  AdminPaymentDeps,
  z.ZodObject,
  AdminPaymentPostDeps
>[] = [
  paymentForceExpire,
  paymentRestoreAwaitingWebhook,
  paymentForceCompleteAndCredit,
  paymentUncompleteAndClawback,
];

export const adminUserOperations: readonly AdminOpImplementation<
  AdminUserDeps,
  z.ZodObject,
  AdminUserPostDeps
>[] = [userLock, userUnlock, sessionsRevokeAll];

export const adminJobOperations: readonly AdminOpImplementation<AdminJobDeps>[] = [
  jobRedrive,
  jobDiscard,
  jobRestore,
];

export const adminModelOperations: readonly AdminOpImplementation<AdminModelDeps>[] = [
  modelDisable,
  modelEnable,
];

export const adminShareOperations: readonly AdminOpImplementation<
  AdminShareDeps,
  z.ZodObject,
  AdminSharePostDeps
>[] = [shareRevoke, shareUnrevoke];

export const adminFeedbackOperations: readonly AdminOpImplementation<AdminFeedbackDeps>[] = [
  feedbackSetStatus,
];

export const adminTwoFactorOperations: readonly AdminOpImplementation<AdminTwoFactorDeps>[] = [
  twoFactorClearStranded,
  twoFactorRestoreStranded,
  twoFactorClear,
  twoFactorRestore,
];

export const adminBannerOperations: readonly AdminOpImplementation<AdminBannerDeps>[] = [bannerSet];

/**
 * The growth family: the reads the dashboard composes and the campaign pair
 * that mints and retires tags. The reads are the plane's first registered
 * operations of kind `read`, so this is also where a read body first reaches
 * the registry.
 */
export const adminGrowthOperations: readonly AdminOpImplementation<AdminGrowthDeps>[] = [
  growthCampaignCreate,
  growthCampaignArchive,
  growthFunnelRead,
  growthMarketingRead,
  growthSourcesRead,
  growthCampaignsRead,
  growthEventsRead,
  growthReachRead,
  growthFreshnessRead,
];

export const adminNewsletterOperations: readonly AdminOpImplementation<
  AdminNewsletterDeps,
  z.ZodObject,
  AdminNewsletterPostDeps
>[] = [newsletterSchedule, newsletterCancel, newsletterTestSend];

/**
 * The full production op set's dependency union (`AdminOpEngineDeps.opDeps`).
 * `feedback.setStatus` contributes nothing — it composes only the engine-owned
 * `SettlementTx` — so `AdminFeedbackDeps` (empty) is deliberately not part of
 * the union. `AdminJobDeps` is empty for the same reason but stays listed, so a
 * transaction-scoped job dependency would join the union without an edit here.
 */
export interface AdminOperationsDeps
  extends
    AdminWalletDeps,
    AdminPaymentDeps,
    AdminUserDeps,
    AdminJobDeps,
    AdminModelDeps,
    AdminShareDeps,
    AdminBannerDeps,
    AdminNewsletterDeps,
    AdminTwoFactorDeps,
    AdminGrowthDeps {}

/**
 * The full production op set's post-commit dependency union
 * (`AdminOpEngineDeps.postDeps`). Naming it at every registry construction is
 * what makes a missing or partial post-commit binding a compile error: the
 * method-parameter bivariance that lets a specifically-typed op widen into the
 * registry's element type does not extend to the registry's own type argument,
 * so a registry left at the default accepts an empty object and the effect then
 * fails at runtime inside the engine's best-effort capture. Families with no
 * post-commit capability contribute nothing.
 */
export interface AdminOperationsPostDeps
  extends
    AdminWalletPostDeps,
    AdminPaymentPostDeps,
    AdminUserPostDeps,
    AdminSharePostDeps,
    AdminNewsletterPostDeps {}

export const adminOperations: readonly AdminOpImplementation<
  AdminOperationsDeps,
  z.ZodObject,
  AdminOperationsPostDeps
>[] = [
  ...adminWalletOperations,
  ...adminPaymentOperations,
  ...adminUserOperations,
  ...adminJobOperations,
  ...adminModelOperations,
  ...adminShareOperations,
  ...adminFeedbackOperations,
  ...adminBannerOperations,
  ...adminNewsletterOperations,
  ...adminTwoFactorOperations,
  ...adminGrowthOperations,
];
