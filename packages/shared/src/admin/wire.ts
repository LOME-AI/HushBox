import { z } from 'zod';
import { ADMIN_OP_EFFECT_CLASSES } from './contract.ts';
import { ADMIN_ROLES } from './roles.ts';
import { FeedbackKind, FeedbackStatus } from '../enums/feedback.ts';
import { CALL_SHAPE_FAMILIES } from '../affordability/model/model-descriptor.ts';
import { GrowthCampaignStatus, GrowthGrain } from '../growth/enums.ts';
import {
  NewsletterConsentSource,
  NewsletterIssueStatus,
  NewsletterStatus,
  NewsletterSuppressReason,
} from '../enums/newsletter.ts';

/** Guardrail caps as they cross JSON: money serialized as a NanoUSD string. */
export const adminOpGuardrailsWireSchema = z.object({
  maxAmountNanoUsd: z
    .string()
    .regex(/^\d+$/, 'maxAmountNanoUsd must be a decimal NanoUSD string')
    .optional(),
});
export type AdminOpGuardrailsWire = z.infer<typeof adminOpGuardrailsWireSchema>;

/** One `GET /admin/ops` catalog entry — drives the ops table, palette, and form. */
export const adminOpWireSchema = z.object({
  name: z.string(),
  title: z.string(),
  kind: z.enum(['mutation', 'read']),
  /** The contract's own sentence about the op, when it states one. */
  description: z.string().optional(),
  effectClass: z.enum(ADMIN_OP_EFFECT_CLASSES),
  inverse: z.string().nullable(),
  /**
   * The op input's field names, in declaration order. The admin SPA bundles
   * `ADMIN_OP_CONTRACTS` at build time and builds the form of every op that
   * map carries from the contract's own Zod input; it reads this list only
   * for an op the map does not carry (`apps/admin/src/lib/op-fields.ts`),
   * which is how an op registered on the server that a bundle predates still
   * renders a usable form. The SPA is the catalog's only client and reads the
   * list nowhere else, so what a registered op's list contains is pinned in
   * `packages/shared/src/admin/catalog-projection.test.ts` rather than by
   * anything that renders it.
   */
  fields: z.array(z.string()),
  /**
   * Optional because only a `system-owned` entry has one: the contract
   * constructor requires the reason there and refuses it on every other
   * class, and the catalog projection copies whatever the contract states,
   * so the class↔reason pairing is enforced once rather than re-asserted
   * here (`packages/shared/src/admin/contract.ts`).
   */
  systemOwnedReason: z.string().optional(),
  guardrails: adminOpGuardrailsWireSchema.optional(),
});
export type AdminOpWire = z.infer<typeof adminOpWireSchema>;

/**
 * The `GET /admin/ops` response envelope. `role` is the CALLER's role, which
 * the route already filtered `ops` by: it is what lets the SPA render its
 * navigation for the same role the plane authorized, without a second round
 * trip and without the SPA deciding anything. Hiding a screen is a courtesy —
 * the route stage and the engine are the controls.
 */
export const adminOpsCatalogSchema = z.object({
  ops: z.array(adminOpWireSchema),
  role: z.enum(ADMIN_ROLES),
});
export type AdminOpsCatalog = z.infer<typeof adminOpsCatalogSchema>;

/** One effect row from the engine's dry-run/committed change list. */
export const adminOpEffectSchema = z.object({
  label: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AdminOpEffect = z.infer<typeof adminOpEffectSchema>;

/** Preview response: the rolled-back run minus its (never-leaked) audit id. */
export const adminOpPreviewResultSchema = z.object({
  effects: z.array(adminOpEffectSchema),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminOpPreviewResult = z.infer<typeof adminOpPreviewResultSchema>;

/** Execute response: the committed run, audit row id included. */
export const adminOpExecuteResultSchema = z.object({
  auditId: z.uuid(),
  effects: z.array(adminOpEffectSchema),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminOpExecuteResult = z.infer<typeof adminOpExecuteResultSchema>;

/**
 * Execute response for a contract whose kind is read: the id of the
 * read-audit row the run wrote, and the read's own payload. `kind` is the
 * literal that keeps the two run shapes apart — an execute result carries no
 * such field, so a caller can never take one for the other, and the execute
 * shape is unchanged by this existing.
 *
 * `data` is unknown here because the envelope is generic over every read: the
 * payload of each one has its own schema (the growth panels below), which the
 * caller parses once it knows which op it asked for.
 */
export const adminOpReadResultSchema = z.object({
  kind: z.literal('read'),
  auditId: z.uuid(),
  data: z.unknown(),
});
export type AdminOpReadResult = z.infer<typeof adminOpReadResultSchema>;

/**
 * `GET /admin/ops/:name/prefill` response: a partial op input the SPA
 * pours into the op form (the server never includes `reason` — the
 * operator always types it). Transport-shape only; per-field validation
 * happens client-side against the op's live contract. There is no
 * catalog advertisement for prefill: the SPA probes blindly and treats
 * any failure as "open blank".
 */
export const adminOpPrefillResultSchema = z.object({
  input: z.record(z.string(), z.unknown()),
});
export type AdminOpPrefillResult = z.infer<typeof adminOpPrefillResultSchema>;

/** Signed nano-USD wire string — display-only on the SPA side. Signed
 * because a negative balance is a legal state. */
const signedNanoUsdWire = z.string().regex(/^-?\d+$/, 'expected a signed decimal NanoUSD string');

export const adminJobCountsWireSchema = z.object({
  pending: z.number().int(),
  running: z.number().int(),
  dead: z.number().int(),
  discarded: z.number().int(),
});
export type AdminJobCountsWire = z.infer<typeof adminJobCountsWireSchema>;

/** One `admin_audit` row as the read surface serializes it. */
export const adminAuditRowWireSchema = z.object({
  id: z.string(),
  actor: z.string(),
  // The role the Access stage resolved for the actor at the time of the
  // action, not the role that actor holds now: an actor's mapping can change,
  // and the trail records what they acted as.
  role: z.enum(ADMIN_ROLES),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.unknown(),
  undoes: z.string().nullable(),
  undoneBy: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminAuditRowWire = z.infer<typeof adminAuditRowWireSchema>;

/**
 * The details shape the engine writes for an executed effect, and the gate the
 * engine's own undo-target check parses a candidate row through: rows matching
 * it are undoable when their op has a registered inverse and no undo has
 * claimed them yet. A guardrail-refusal row (`{ refusal, input }`) fails it — a
 * refusal records a refused attempt and has no effect to undo.
 */
export const adminAuditExecutedDetailsSchema = z.object({
  effects: z.array(z.unknown()),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminAuditExecutedDetails = z.infer<typeof adminAuditExecutedDetailsSchema>;

/** The `GET /admin/dashboard` envelope. */
export const dashboardWireSchema = z.object({
  jobs: adminJobCountsWireSchema,
  recentActions: z.array(adminAuditRowWireSchema),
});
export type DashboardWire = z.infer<typeof dashboardWireSchema>;

/** A Customer-360 panel: loaded, or failed on its own with an error code. */
function panelSchema<T extends z.ZodType>(
  data: T
): z.ZodDiscriminatedUnion<
  [
    z.ZodObject<{ ok: z.ZodLiteral<true>; data: T }>,
    z.ZodObject<{ ok: z.ZodLiteral<false>; error: z.ZodString }>,
  ],
  'ok'
> {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]);
}

export const customer360MoneyPanelSchema = z.object({
  balance: z.object({
    purchasedNanoUsd: signedNanoUsdWire,
    freeNanoUsd: signedNanoUsdWire,
    allowance: z.object({
      day: z.string(),
      limitNanoUsd: signedNanoUsdWire,
      spentNanoUsd: signedNanoUsdWire,
      remainingNanoUsd: signedNanoUsdWire,
    }),
  }),
  // Wallet identity rows: the ids prefill wallet.credit/clawback targets.
  wallets: z.array(
    z.object({ id: z.string(), type: z.string(), balanceNanoUsd: signedNanoUsdWire })
  ),
  recentLedger: z.array(
    z.object({
      createdAt: z.string(),
      kind: z.string(),
      amountNanoUsd: signedNanoUsdWire,
      balanceAfterNanoUsd: signedNanoUsdWire,
    })
  ),
});
export type Customer360MoneyPanel = z.infer<typeof customer360MoneyPanelSchema>;

export const customer360UsagePanelSchema = z.object({
  models: z.array(
    z.object({
      modelId: z.string(),
      totalNanoUsd: signedNanoUsdWire,
      recordCount: z.number().int(),
      estimatedCount: z.number().int(),
    })
  ),
});
export type Customer360UsagePanel = z.infer<typeof customer360UsagePanelSchema>;

export const customer360ConversationsPanelSchema = z.object({
  owned: z.number().int(),
  activeMemberships: z.number().int(),
});
export type Customer360ConversationsPanel = z.infer<typeof customer360ConversationsPanelSchema>;

export const adminJobRowWireSchema = z.object({
  id: z.string(),
  type: z.string(),
  shard: z.string(),
  status: z.string(),
  discarded: z.boolean(),
  failures: z.number().int(),
  claims: z.number().int(),
  payload: z.unknown(),
  errors: z.array(z.object({ at: z.string(), claim: z.number().int(), error: z.string() })),
  nextAttemptAt: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AdminJobRowWire = z.infer<typeof adminJobRowWireSchema>;

/** Device-token summary: platform per token — never the token value. */
const customer360DevicesPanelSchema = z.object({
  count: z.number().int(),
  tokens: z.array(z.object({ platform: z.string() })),
});

/**
 * The `GET /admin/users/overview` view: safe header + independent panels.
 * No sessions panel exists by design: sessions are stateless iron-session
 * cookies with no server-side store to enumerate.
 */
export const customer360ViewSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    username: z.string(),
    emailVerified: z.boolean(),
    totpEnabled: z.boolean(),
    createdAt: z.string(),
    lockedAt: z.string().nullable(),
    lockReason: z.string().nullable(),
    hasAcknowledgedPhrase: z.boolean(),
  }),
  panels: z.object({
    money: panelSchema(customer360MoneyPanelSchema),
    usage: panelSchema(customer360UsagePanelSchema),
    conversations: panelSchema(customer360ConversationsPanelSchema),
    devices: panelSchema(customer360DevicesPanelSchema),
    jobs: panelSchema(z.object({ jobs: z.array(adminJobRowWireSchema) })),
    adminHistory: panelSchema(z.object({ actions: z.array(adminAuditRowWireSchema) })),
  }),
});
export type Customer360View = z.infer<typeof customer360ViewSchema>;
export type Customer360Panel<T> = { ok: true; data: T } | { ok: false; error: string };

/** `GET /admin/jobs` envelope: one cursor page of the queue read. */
export const jobQueueWireSchema = z.object({
  rows: z.array(adminJobRowWireSchema),
  nextCursor: z.string().nullable(),
});
export type JobQueueWire = z.infer<typeof jobQueueWireSchema>;

/** `GET /admin/audit` envelope: one cursor page of the trail search. */
export const auditSearchWireSchema = z.object({
  rows: z.array(adminAuditRowWireSchema),
  nextCursor: z.string().nullable(),
});
export type AuditSearchWire = z.infer<typeof auditSearchWireSchema>;

/** One `GET /admin/feedback` inbox row — the preview projection for the table. */
export const feedbackInboxRowWireSchema = z.object({
  id: z.uuid(),
  kind: FeedbackKind,
  status: FeedbackStatus,
  bodyPreview: z.string(),
  createdAt: z.string(),
  userId: z.uuid(),
});
export type FeedbackInboxRowWire = z.infer<typeof feedbackInboxRowWireSchema>;

/** `GET /admin/feedback` envelope: one cursor page of the inbox read. */
export const feedbackInboxWireSchema = z.object({
  rows: z.array(feedbackInboxRowWireSchema),
  nextCursor: z.string().nullable(),
});
export type FeedbackInboxWire = z.infer<typeof feedbackInboxWireSchema>;

/** `GET /admin/feedback/:id` detail: the full body, never the preview. */
export const feedbackDetailWireSchema = z.object({
  id: z.uuid(),
  kind: FeedbackKind,
  status: FeedbackStatus,
  body: z.string(),
  createdAt: z.string(),
  userId: z.uuid(),
});
export type FeedbackDetailWire = z.infer<typeof feedbackDetailWireSchema>;

/** One `GET /admin/newsletter/issues` row — timestamps as ISO strings. */
export const newsletterIssueWireSchema = z.object({
  id: z.uuid(),
  subject: z.string(),
  status: NewsletterIssueStatus,
  scheduledAt: z.string(),
  canceledAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  recipientCount: z.number().int().nullable(),
  sentCount: z.number().int().nullable(),
  failedCount: z.number().int().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});

export type NewsletterIssueWire = z.infer<typeof newsletterIssueWireSchema>;

/** `GET /admin/newsletter/issues` envelope: one cursor page. */
export const newsletterIssuesWireSchema = z.object({
  rows: z.array(newsletterIssueWireSchema),
  nextCursor: z.string().nullable(),
});

export type NewsletterIssuesWire = z.infer<typeof newsletterIssuesWireSchema>;

/** One `GET /admin/newsletter/subscribers` consent-evidence row — the
 * server-side projection excludes every token column by construction. */
export const newsletterSubscriberWireSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  status: NewsletterStatus,
  suppressReason: NewsletterSuppressReason.nullable(),
  consentSource: NewsletterConsentSource,
  consentIp: z.string(),
  consentTextVersion: z.string(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  unsubscribedAt: z.string().nullable(),
  suppressedAt: z.string().nullable(),
});

export type NewsletterSubscriberWire = z.infer<typeof newsletterSubscriberWireSchema>;

/** `GET /admin/newsletter/subscribers` envelope: one audited cursor page. */
export const newsletterSubscribersWireSchema = z.object({
  rows: z.array(newsletterSubscriberWireSchema),
  nextCursor: z.string().nullable(),
});

export type NewsletterSubscribersWire = z.infer<typeof newsletterSubscribersWireSchema>;

/** `GET /admin/newsletter/subscribers/stats` — exhaustive per-enum counts. */
export const newsletterStatsWireSchema = z.object({
  byStatus: z.record(NewsletterStatus, z.number().int()),
  bySuppressReason: z.record(NewsletterSuppressReason, z.number().int()),
});

export type NewsletterStatsWire = z.infer<typeof newsletterStatsWireSchema>;

/**
 * `POST /admin/newsletter/render` response: the preview HTML produced by the
 * same template the dispatch job renders, with an inert unsubscribe link.
 */
export const newsletterRenderWireSchema = z.object({
  html: z.string(),
});

export type NewsletterRenderWire = z.infer<typeof newsletterRenderWireSchema>;

/**
 * `GET /admin/sql` result page. `truncated` means the server cut the page at
 * its row cap (a LIMIT cap+1 probe), so the client must never infer "all
 * rows" from `rowCount` when it is set.
 */
export const sqlPanelResultWireSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean(),
});
export type SqlPanelResultWire = z.infer<typeof sqlPanelResultWireSchema>;

/**
 * `GET /admin/models` page: the slim per-model projection (identity + kill
 * switch), never the descriptor jsonb. Projection fields are null when the
 * stored descriptor fails its own contract — the admin read shows corrupt
 * rows instead of hiding them. `truncated` means the server cut at its model
 * cap, so the client must never infer "the whole catalog" when it is set.
 */
export const adminModelWireSchema = z.object({
  modelId: z.string(),
  name: z.string().nullable(),
  family: z.enum(CALL_SHAPE_FAMILIES).nullable(),
  zdrReachable: z.boolean().nullable(),
  adminDisabledAt: z.string().nullable(),
});
export type AdminModelWire = z.infer<typeof adminModelWireSchema>;

export const adminModelsWireSchema = z.object({
  models: z.array(adminModelWireSchema),
  truncated: z.boolean(),
});
export type AdminModelsWire = z.infer<typeof adminModelsWireSchema>;

/**
 * The growth reads' payloads. Each is a map of panels, and each panel carries
 * its own outcome: a read that fails degrades to its error code inside a
 * successful run rather than failing the run, so the dashboard shows one panel
 * unavailable instead of nothing at all (the Customer-360 pattern).
 */

/** One week of one campaign's ladder, as the funnel read serializes it. */
export const growthFunnelWeekWireSchema = z.object({
  week: z.string(),
  campaign: z.string(),
  /**
   * A step whose bucket holds more than one row is a weekly sum of bucket
   * maxima and so a lower bound — `BUCKET_MAXIMUM_NOTE` in
   * `packages/shared/src/growth/funnel-steps.ts` — and its name says which
   * bucketing produced it. Such a step carries the ceiling flag of every row
   * behind it: a count a set ceiling cut off is a floor, which is a different
   * fact from the count the figure would otherwise assert. Whether a step is anonymous is a separate question with a separate
   * answer, `ANONYMOUS_STEP_NOTE` in the same module.
   *
   * `started` carries one on the same terms: its count is the cardinality of a
   * ceiling-bounded set, and the hour row behind it records the refusal. The
   * steps counting accounts carry none — an account is a row rather than a set
   * member a ceiling can turn away.
   */
  visitorsDailySummed: z.number().int(),
  visitorsOverflow: z.boolean(),
  productEntryClicksHourlySummed: z.number().int(),
  productEntryClicksOverflow: z.boolean(),
  started: z.number().int(),
  startedOverflow: z.boolean(),
  finished: z.number().int(),
  verified: z.number().int(),
  activated: z.number().int(),
  returnedWeek1: z.number().int(),
  firstPaid: z.number().int(),
  revenueNanoUsd: signedNanoUsdWire,
});
export type GrowthFunnelWeekWire = z.infer<typeof growthFunnelWeekWireSchema>;

export const growthFunnelReadSchema = z.object({
  panels: z.object({
    funnel: panelSchema(z.object({ weeks: z.array(growthFunnelWeekWireSchema) })),
  }),
});
export type GrowthFunnelRead = z.infer<typeof growthFunnelReadSchema>;

/**
 * One marketing marginal. Every family fills the dimensions it owns and leaves
 * the rest null; two families are never joined, because a distinct count over a
 * cross product is not derivable from the counts of its projections.
 */
export const growthMarketingRowWireSchema = z.object({
  bucket: z.string(),
  family: z.string(),
  path: z.string().nullable(),
  referrerHost: z.string().nullable(),
  campaign: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  device: z.string().nullable(),
  visitors: z.number().int(),
  landings: z.number().int().nullable(),
  /** The bucket hit a set ceiling, so its figure is a lower bound. */
  overflow: z.boolean(),
});
export type GrowthMarketingRowWire = z.infer<typeof growthMarketingRowWireSchema>;

export const growthMarketingReadSchema = z.object({
  panels: z.object({
    marketing: panelSchema(
      z.object({ grain: GrowthGrain, rows: z.array(growthMarketingRowWireSchema) })
    ),
  }),
});
export type GrowthMarketingRead = z.infer<typeof growthMarketingReadSchema>;

/** How many accounts named one source in one creation week. */
export const growthSourceCountWireSchema = z.object({
  userCreatedWeek: z.string(),
  campaign: z.string(),
  selfReportedChannel: z.string().nullable(),
  selfReportedContext: z.string().nullable(),
  primarySource: z.string(),
  accounts: z.number().int(),
});
export type GrowthSourceCountWire = z.infer<typeof growthSourceCountWireSchema>;

export const growthSourcesReadSchema = z.object({
  panels: z.object({
    sources: panelSchema(z.object({ rows: z.array(growthSourceCountWireSchema) })),
  }),
});
export type GrowthSourcesRead = z.infer<typeof growthSourcesReadSchema>;

/** One campaign as the admin plane lists it; the row's uuid stays behind. */
export const growthCampaignWireSchema = z.object({
  tag: z.string(),
  label: z.string(),
  status: GrowthCampaignStatus,
  createdAt: z.string(),
});
export type GrowthCampaignWire = z.infer<typeof growthCampaignWireSchema>;

export const growthCampaignsReadSchema = z.object({
  panels: z.object({
    campaigns: panelSchema(z.object({ rows: z.array(growthCampaignWireSchema) })),
  }),
});
export type GrowthCampaignsRead = z.infer<typeof growthCampaignsReadSchema>;

/**
 * One landing page paired with one page reached from it. The figure sums each
 * day's own distinct count, so a visitor who made the journey on two days
 * counts twice; the name says which bucketing produced it, as the weekly
 * ladder's anonymous steps do. A pair carries a row only when the table holds
 * one for it — an absent pair is a journey nobody was counted making, which is
 * not the same fact as a count of zero.
 */
export const growthReachRowWireSchema = z.object({
  landingPath: z.string(),
  reachedPath: z.string(),
  visitorsDailySummed: z.number().int(),
  /** A day this figure sums hit a set ceiling, so the sum is a lower bound. */
  overflow: z.boolean(),
});
export type GrowthReachRowWire = z.infer<typeof growthReachRowWireSchema>;

export const growthReachReadSchema = z.object({
  panels: z.object({
    reach: panelSchema(z.object({ rows: z.array(growthReachRowWireSchema) })),
  }),
});
export type GrowthReachRead = z.infer<typeof growthReachReadSchema>;

/** One named event's distinct visitors, for one campaign and page, in one hour. */
export const growthEventRowWireSchema = z.object({
  hour: z.string(),
  campaign: z.string(),
  eventName: z.string(),
  path: z.string(),
  visitors: z.number().int(),
  /** The hour hit a set ceiling, so its figure is a lower bound. */
  overflow: z.boolean(),
});
export type GrowthEventRowWire = z.infer<typeof growthEventRowWireSchema>;

export const growthEventsReadSchema = z.object({
  panels: z.object({
    events: panelSchema(
      z.object({
        page: z.number().int(),
        pageSize: z.number().int(),
        /** Another page follows this one, so the reader never infers "all rows". */
        hasMore: z.boolean(),
        rows: z.array(growthEventRowWireSchema),
      })
    ),
  }),
});
export type GrowthEventsRead = z.infer<typeof growthEventsReadSchema>;

/**
 * The newest day one growth data set holds, under the grain of the relation it
 * came from — which decides what the day means. A week-grouped set's newest
 * value is the day its newest week *opens on*, which is earlier than the day
 * that set's data runs through; a set grouped by a day or finer answers the day
 * its data does run through. Rendering the first as the second understates how
 * current the data is, so the two kinds carry different day fields and a reader
 * must narrow on `grain` before it can read either.
 *
 * Day resolution is the ceiling either way: every set buckets by a day or
 * coarser than a day *in what this reports*, so an instant here would state a
 * precision the reading does not carry.
 */
export const growthNewestDayWireSchema = z.discriminatedUnion('grain', [
  z.object({ grain: z.literal('week'), weekOpening: z.iso.date() }),
  z.object({ grain: z.literal('day'), runsThrough: z.iso.date() }),
]);
export type GrowthNewestDayWire = z.infer<typeof growthNewestDayWireSchema>;

/**
 * How current each growth data set is, over the whole of that set. A set
 * holding no rows has no newest day and carries `null`: absence is a different
 * fact from a day, and one a reader cannot mistake for one.
 */
export const growthFreshnessWireSchema = z.object({
  funnel: growthNewestDayWireSchema.nullable(),
  sources: growthNewestDayWireSchema.nullable(),
  marketing: growthNewestDayWireSchema.nullable(),
  events: growthNewestDayWireSchema.nullable(),
});
export type GrowthFreshnessWire = z.infer<typeof growthFreshnessWireSchema>;

export const growthFreshnessReadSchema = z.object({
  panels: z.object({ freshness: panelSchema(growthFreshnessWireSchema) }),
});
export type GrowthFreshnessRead = z.infer<typeof growthFreshnessReadSchema>;
