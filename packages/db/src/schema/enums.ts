import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACQUISITION_PLATFORMS,
  ADMIN_ROLES,
  EXCLUDE_REASONS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  GROWTH_CAMPAIGN_STATUS,
  GROWTH_CHANNELS,
  GROWTH_DEVICE,
  GROWTH_FUNNEL_STEP,
  GROWTH_GRAIN,
  GROWTH_SELF_REPORT_CONTEXT,
  LEDGER_ENTRY_KINDS,
  MEMBER_PRIVILEGES,
  MODALITIES,
  NEWSLETTER_CONSENT_SOURCES,
  NEWSLETTER_DELIVERY_STATUSES,
  NEWSLETTER_ISSUE_STATUSES,
  NEWSLETTER_STATUSES,
  NEWSLETTER_SUPPRESS_REASONS,
  PAYMENT_STATUSES,
  RESOLVED_REASONING_EFFORTS,
  USER_LOCK_REASONS,
} from '@hushbox/shared';

/**
 * pgEnums for every status/type/privilege field and for modality. The
 * modality enum derives from the single shared MODALITIES const — the one
 * source feeding the pgEnum, the Zod contracts, and the dispatch types.
 */
export const modalityEnum = pgEnum('modality', MODALITIES);

/** Job state machine. */
export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'running',
  'succeeded',
  'cancelled',
  'dead',
]);

/** Dispatcher shards (one Durable Object per shard). */
export const jobShardEnum = pgEnum('job_shard', ['default', 'bulk']);

/**
 * ledger_entries.kind discriminator. OpenRouter returns the authoritative cost
 * inline, so settlement charges it directly with no async reconcile leg; rare
 * manual cost corrections use charge/refund.
 */
export const ledgerEntryKindEnum = pgEnum('ledger_entry_kind', LEDGER_ENTRY_KINDS);

/** House accounts beside user wallets (double-entry counterlegs). */
export const houseAccountEnum = pgEnum('house_account', ['revenue', 'payments-in', 'promo']);

/**
 * Pre-claim lifecycle: pending → awaiting_webhook →
 * completed/failed, with expired for pre-claims the verify job gives up on.
 */
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);

/** Dual-lifecycle split: request dedup vs the run-settlement referee. */
export const idempotencyKeyKindEnum = pgEnum('idempotency_key_kind', ['request', 'run']);

/** Outcome state machine (the unique insert is the claim). */
export const idempotencyKeyStatusEnum = pgEnum('idempotency_key_status', [
  'claimed',
  'succeeded',
  'failed',
]);

/** One purchased + one free-tier wallet per user. */
export const walletTypeEnum = pgEnum('wallet_type', ['purchased', 'free']);

/** Derives from the single shared MEMBER_PRIVILEGES const (same pattern as modality). */
export const memberPrivilegeEnum = pgEnum('member_privilege', MEMBER_PRIVILEGES);

export const messageSenderTypeEnum = pgEnum('message_sender_type', ['user', 'assistant', 'system']);

/** Content modalities that rest as content_items (modality minus embedding). */
export const contentItemTypeEnum = pgEnum('content_item_type', ['text', 'image', 'audio', 'video']);

/**
 * Derives from the single shared ACQUISITION_PLATFORMS const (same pattern as
 * modality). The registration body validates the platform against that tuple
 * before this column ever sees it, so the two agree by construction rather
 * than by a second list kept in step.
 */
export const devicePlatformEnum = pgEnum('device_platform', ACQUISITION_PLATFORMS);

/**
 * The admin plane's roles, from the single shared ADMIN_ROLES tuple (same
 * pattern as modality). The audit row stamps which role executed an op, so a
 * read-only role's reach is visible in the permanent trail and not only in the
 * declarations that bound it.
 */
export const adminRoleEnum = pgEnum('admin_role', ADMIN_ROLES);

/**
 * Chargeback auto-defense vs explicit admin lock. Derives from the single
 * shared USER_LOCK_REASONS const (same pattern as modality).
 */
export const userLockReasonEnum = pgEnum('user_lock_reason', USER_LOCK_REASONS);

export const verificationPurposeEnum = pgEnum('verification_purpose', ['email_verification']);

/**
 * Why a catalog row is not sellable, derived by the hourly refresh. Sources the
 * single shared EXCLUDE_REASONS const, which is also what the refresh summary's
 * per-reason breakdown counts — one authority, no second list.
 */
export const modelExcludeReasonEnum = pgEnum('model_exclude_reason', EXCLUDE_REASONS);

/**
 * The level a generation actually reasoned at. Derives from the single shared
 * RESOLVED_REASONING_EFFORTS const (same pattern as modality), so `auto` — a
 * selection, never a resolution — is unrepresentable in storage.
 */
export const reasoningEffortEnum = pgEnum('reasoning_effort', RESOLVED_REASONING_EFFORTS);

/** Derives from the single shared FEEDBACK_KINDS const (same pattern as modality). */
export const feedbackKindEnum = pgEnum('feedback_kind', FEEDBACK_KINDS);

/** Derives from the single shared FEEDBACK_STATUSES const (admin triage state machine). */
export const feedbackStatusEnum = pgEnum('feedback_status', FEEDBACK_STATUSES);

/** Derives from the single shared NEWSLETTER_STATUSES const (subscriber lifecycle). */
export const newsletterStatusEnum = pgEnum('newsletter_status', NEWSLETTER_STATUSES);

/** Derives from the single shared NEWSLETTER_SUPPRESS_REASONS const (provider-signaled only). */
export const newsletterSuppressReasonEnum = pgEnum(
  'newsletter_suppress_reason',
  NEWSLETTER_SUPPRESS_REASONS
);

/** Derives from the single shared NEWSLETTER_ISSUE_STATUSES const (issue lifecycle). */
export const newsletterIssueStatusEnum = pgEnum(
  'newsletter_issue_status',
  NEWSLETTER_ISSUE_STATUSES
);

/** Derives from the single shared NEWSLETTER_DELIVERY_STATUSES const (per-recipient state). */
export const newsletterDeliveryStatusEnum = pgEnum(
  'newsletter_delivery_status',
  NEWSLETTER_DELIVERY_STATUSES
);

/** Derives from the single shared NEWSLETTER_CONSENT_SOURCES const (where consent was given). */
export const newsletterConsentSourceEnum = pgEnum(
  'newsletter_consent_source',
  NEWSLETTER_CONSENT_SOURCES
);

/** Derives from the single shared GROWTH_GRAIN const. The aggregate grain a row carries; the same beacon lands in an hour bucket and a day bucket, so both grains live in one table. */
export const growthGrainEnum = pgEnum('growth_grain', GROWTH_GRAIN);

/** Derives from the single shared GROWTH_DEVICE const (the coarse device families a request is classified into). */
export const growthDeviceEnum = pgEnum('growth_device', GROWTH_DEVICE);

/** Derives from the single shared GROWTH_CAMPAIGN_STATUS const. Archived, never deleted: growth rows kept forever reference the tag. */
export const growthCampaignStatusEnum = pgEnum('growth_campaign_status', GROWTH_CAMPAIGN_STATUS);

/** Derives from the single shared GROWTH_FUNNEL_STEP const. One value today; a second step is an enum migration, never ad-hoc data. */
export const growthFunnelStepEnum = pgEnum('growth_funnel_step', GROWTH_FUNNEL_STEP);

/** Derives from the single shared GROWTH_CHANNELS const. The closed set an account holder may name as where they heard about HushBox; there is no free-text alternative anywhere. */
export const growthChannelEnum = pgEnum('growth_channel', GROWTH_CHANNELS);

/**
 * Derives from the single shared GROWTH_SELF_REPORT_CONTEXT const. Declaration
 * order is the order the two moments occur, and Postgres compares the enum by
 * that order — which is what lets a skip be recorded as one advancing value
 * rather than a set.
 */
export const growthSelfReportContextEnum = pgEnum(
  'growth_self_report_context',
  GROWTH_SELF_REPORT_CONTEXT
);
