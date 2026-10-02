export { createWebhookVerifier } from './payments/webhook-verify.js';
export type { WebhookVerifier } from './payments/webhook-verify.js';

export {
  COST_CIRCUIT_MULTIPLIER,
  DAILY_ALLOWANCE_NANO_USD,
  TRIAL_DAILY_SPEND_CAP_NANO_USD,
  WELCOME_CREDIT_NANO_USD,
} from './constants.js';
export {
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  providerUsdToBillableNanoUsd,
  usdToNanoUsd,
} from './money.js';

export { BILLING_KEYS } from './keys.js';
export type { RedisClient } from './keys.js';
export { provisionWalletsWithinTx } from './wallets/wallets.js';

export { chargeWithinTx } from './charge.js';
export type { ChargeInput, ChargeSender } from './charge.js';
export {
  admitRun,
  refreshWalletSnapshot,
  releaseHold,
  writeThroughSnapshot,
} from './admission/admission.js';
export { readFundingSnapshot, serializeFundingSnapshot } from './wallets/spendable.js';
export type {
  ActiveHoldsReadout,
  BudgetScopeHoldRef,
  ConversationFundingFacts,
  ConversationFundingReader,
} from './wallets/spendable.js';
export type { AdmissionDeps, AdmissionRefusalReason, BudgetScope } from './admission/admission.js';
export { admitTrialSpend, incrementTrialSpend } from './trial-spend.js';
export type { TrialSpendDeps } from './trial-spend.js';

export {
  PAYMENT_MINIMUM_NANO_USD,
  PAYMENT_VERIFY_JOB_TYPE,
  initiateCardPayment,
  initiatePaymentBodySchema,
  billingPrincipalUserId,
} from './payments/payments.js';

export { postPaymentAdjustmentWithinTx } from './payments/payment-ledger.js';

export { paymentMockDirectivesFor } from './payments/payment-mock-directives.js';
export {
  releaseHeldPaymentWebhook,
  releaseHeldWebhookQuerySchema,
} from './payments/held-webhook-release.js';

export { createPaymentVerifyJobRegistration } from './payments/payment-verify.js';

export {
  applyPaymentWebhookEvent,
  recordPaymentWebhookEvidence,
  signalPaymentWebhookDisposition,
} from './payments/payment-webhook.js';
export type { PaymentWebhookApplication } from './payments/payment-webhook.js';
export { runConservationAudit } from './audit/auditors.js';

export {
  createLedgerConservationEntry,
  createPaymentsStatusAuditEntry,
  createSnapshotDriftEntry,
} from './audit/entries.js';

export { callerUserId, readBalance } from './wallets/balance.js';
export type { BalanceView } from './wallets/balance.js';
export { billingLoginLinkResponseSchema, issueBillingLoginToken } from './login-link.js';
export { resolveBudgetScopes } from './budgets/budget-resolution.js';

export {
  buildPublicUsageStats,
  readLatestPublicStatsSnapshot,
  savePublicStatsSnapshot,
} from './usage/public-usage-stats.js';

export {
  createCatalogModelMetaResolver,
  createPublicStatsSnapshotEntry,
} from './usage/public-stats-snapshot-entry.js';

export {
  readCostByModel,
  readLedgerTransactions,
  readSpendingByConversation,
  readSpendingOverTime,
  readUsageBreakdown,
  readUsageModels,
  readUsageSummary,
  usageBreakdownQuerySchema,
} from './usage/analytics.js';

// Route-seam re-exports: routes.ts may import only this barrel and the
// middleware (boundaries), so the lib surface routes need travels through
// here.
export { createErrorResponse } from '../../../lib/errors/index.js';
export type { DomainError } from '../../../lib/errors/index.js';
export {
  idempotencyExempt,
  idempotent,
  readIdempotencyKey,
  runMutation,
} from '../../../lib/idempotency/index.js';
export { okAsync } from '../../../lib/result/index.js';
export type { JobRegistry } from '../../../lib/jobs/index.js';
export type {
  AccountDefensePort,
  ChargebackLockEmailPort,
  BillingStores,
  PaymentMockDirectives,
  PaymentProvider,
  WebhookDeliveryLifetime,
} from '../ports/index.js';
