export { createWebhookVerifier } from './domain/index.js';
export type { WebhookVerifier } from './domain/index.js';
export { createPaymentProviderFromEnv } from './adapters/payment-provider-factory.js';

export type { ChargeOutcome, PaymentProvider } from './ports/index.js';

export { createBillingManifest } from './routes.js';

export { BILLING_ROUTE_POSTURES } from './rate-limit-posture.js';
export { BILLING_RATE_LIMITS } from './domain/rate-limit.js';

export { createBillingStores } from './adapters/stores.js';
export { createBillingAuditProbes } from './audit-probes.js';

export {
  COST_CIRCUIT_MULTIPLIER,
  DAILY_ALLOWANCE_NANO_USD,
  PAYMENT_MINIMUM_NANO_USD,
  PAYMENT_VERIFY_JOB_TYPE,
  TRIAL_DAILY_SPEND_CAP_NANO_USD,
  WELCOME_CREDIT_NANO_USD,
  admitRun,
  admitTrialSpend,
  applyPaymentWebhookEvent,
  chargeWithinTx,
  createLedgerConservationEntry,
  createPaymentVerifyJobRegistration,
  createPaymentsStatusAuditEntry,
  createSnapshotDriftEntry,
  incrementTrialSpend,
  postPaymentAdjustmentWithinTx,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  providerUsdToBillableNanoUsd,
  provisionWalletsWithinTx,
  readBalance,
  refreshWalletSnapshot,
  readUsageBreakdown,
  releaseHold,
  resolveBudgetScopes,
  runConservationAudit,
  usdToNanoUsd,
  writeThroughSnapshot,
} from './domain/index.js';
export { billableRateToMaxPriceUsdPerMillion } from './domain/money.js';

/**
 * No file imports this from the barrel — the slice's own route reaches the function through
 * `./domain/index.js`. `index.test.ts` reaches it as a member of the namespace object from
 * `import * as billing from './index.js'`, indexed by the string name it hands
 * `expectExposes`.
 * @namespaceMember
 */
export { initiateCardPayment } from './domain/index.js';

export type {
  ActiveHoldsReadout,
  AdmissionDeps,
  AdmissionRefusalReason,
  BalanceView,
  BudgetScopeHoldRef,
  BudgetScope,
  ChargeInput,
  ChargeSender,
  ConversationFundingFacts,
  ConversationFundingReader,
  RedisClient,
  TrialSpendDeps,
} from './domain/index.js';
export type {
  AccountDefensePort,
  ChargebackLockEmailPort,
  BillingStores,
  LedgerLegInput,
  LlmCompletionInput,
  PaymentRecord,
  PaymentStatus,
  SpendingUpsert,
  UsageRecordInput,
  WalletRecord,
  WelcomeEmailPort,
} from './ports/index.js';

// The anonymized public usage-stats surface (the snapshot cron and the
// public endpoint compose these; raw counts never cross this barrel).
export { createPublicStatsStores } from './adapters/public-stats-stores.js';
export { readLatestPublicStatsSnapshot } from './domain/index.js';

/**
 * No file imports these from the barrel — the snapshot cron entry reaches both through
 * `./usage/public-usage-stats.js`. `index.test.ts` reaches them as members of the namespace
 * object from `import * as billing from './index.js'`, indexed by the string names it hands
 * `expectExposes`.
 * @namespaceMember
 */
export { buildPublicUsageStats, savePublicStatsSnapshot } from './domain/index.js';

export { createCatalogModelMetaResolver, createPublicStatsSnapshotEntry } from './domain/index.js';

export type { PublicStatsSnapshotRow, PublicStatsStores } from './ports/public-stats.js';

// The dev/E2E history producers: timestamp-controlled writes this slice's
// live settlement path cannot make, published so the seed tooling composes
// them instead of writing billing-owned tables from outside the slice.
export {
  seedAwaitingWebhookPayment,
  seedPaymentsHistory,
  seedUsageHistory,
} from './adapters/dev-billing-history.js';

export { seedPublicUsageRecords } from './adapters/dev-public-usage.js';
