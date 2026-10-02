import { notFoundError, unavailableError, validationError } from '../../../lib/errors/index.js';
import { err, fromPromise, ok } from '../../../lib/result/index.js';
import { getFeedbackById, listFeedbackForInbox } from '../../feedback/index.js';
import { listAdminCatalog } from '../../models/index.js';
import {
  listIssues,
  listSubscribersForAdmin,
  renderIssuePreview,
  subscriberStats,
} from '../../newsletter/index.js';
import { auditToWire, jobToWire, loadCustomer360 } from './customer-360.js';
import { READ_AUDIT_ACTIONS, writeReadAudit } from './read-audit.js';
import type {
  AdminSubscriberRow,
  NewsletterIssueRow,
  SubscriberStats,
} from '../../newsletter/index.js';
import type {
  AdminModelsWire,
  AdminModelWire,
  AuditSearchWire,
  Customer360View,
  DashboardWire,
  JobQueueWire,
  NewsletterIssueWire,
  NewsletterIssuesWire,
  NewsletterRenderWire,
  NewsletterStatus,
  NewsletterSubscriberWire,
  NewsletterSubscribersWire,
} from '@hushbox/shared';
import type { AdminCatalogModel } from '../../models/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { FeedbackDetailWire, FeedbackInboxWire, FeedbackStatus } from '@hushbox/shared';
import type {
  AdminAuditSearchFilter,
  AdminJobQueueFilter,
  SqlPanel,
  SqlPanelResult,
} from '../ports/index.js';
import type { Customer360Deps, Customer360Query } from './customer-360.js';

interface AdminReadSurfaceDeps extends Customer360Deps {
  readonly sqlPanel: SqlPanel;
  /** The marketing origin the compose preview's unsubscribe link reaches. */
  readonly marketingUrl: string;
}

/** One keyset page request for the feedback triage inbox. */
export interface FeedbackInboxFilter {
  readonly status?: FeedbackStatus;
  readonly cursor?: string;
  readonly limit: number;
}

/** One audited, capped page request for the job queue. */
export interface AdminJobQueueQuery extends AdminJobQueueFilter {
  readonly actor: string;
}

/** One keyset page request for the newsletter issues table. */
export interface NewsletterIssuesFilter {
  readonly limit: number;
  readonly cursor?: string;
}

/** One audited, capped page request for the subscriber consent-evidence list. */
export interface NewsletterSubscribersQuery {
  readonly actor: string;
  readonly limit: number;
  readonly status?: NewsletterStatus;
  readonly cursor?: string;
}

/**
 * The admin plane's bespoke read surface (reads skip the op-engine tx
 * machinery but stay audited and volume-capped per the Charter). One
 * factory, one wire mapping — routes hold no business logic.
 */
export interface AdminReadSurface {
  customer360(params: {
    readonly actor: string;
    readonly query: Customer360Query;
  }): Promise<Result<Customer360View, DomainError>>;
  auditSearch(filter: AdminAuditSearchFilter): Promise<Result<AuditSearchWire, DomainError>>;
  dashboard(params: { readonly actor: string }): Promise<Result<DashboardWire, DomainError>>;
  jobQueue(query: AdminJobQueueQuery): Promise<Result<JobQueueWire, DomainError>>;
  feedbackInbox(filter: FeedbackInboxFilter): Promise<Result<FeedbackInboxWire, DomainError>>;
  feedbackDetail(params: {
    readonly actor: string;
    readonly id: string;
  }): Promise<Result<FeedbackDetailWire, DomainError>>;
  newsletterIssues(
    filter: NewsletterIssuesFilter
  ): Promise<Result<NewsletterIssuesWire, DomainError>>;
  newsletterSubscriberStats(): Promise<Result<SubscriberStats, DomainError>>;
  renderIssue(params: {
    readonly subject: string;
    readonly bodyMarkdown: string;
  }): Promise<Result<NewsletterRenderWire, DomainError>>;
  newsletterSubscribers(
    query: NewsletterSubscribersQuery
  ): Promise<Result<NewsletterSubscribersWire, DomainError>>;
  modelsCatalog(): Promise<Result<AdminModelsWire, DomainError>>;
  sqlPanel(params: {
    readonly actor: string;
    readonly query: string;
  }): Promise<Result<SqlPanelResult, DomainError>>;
}

export function createAdminReadSurface(deps: AdminReadSurfaceDeps): AdminReadSurface {
  return {
    customer360: (params) => loadCustomer360(deps, params),

    async auditSearch(filter) {
      const result = await fromPromise(deps.auditReads.search(deps.db, filter), (cause) =>
        unavailableError('audit search failed', cause)
      );
      return result.map((page) => ({
        rows: page.rows.map((row) => auditToWire(row)),
        nextCursor: page.nextCursor,
      }));
    },

    // The recent-actions feed over `admin_audit` (Charter #12) — audited
    // AFTER the read because this read is self-referential: a row written
    // first is the newest row the feed then returns, so every open would
    // count itself. Dropping the row from the feed instead was rejected — a
    // recent-actions read that omits an action is a filtered trail. The write
    // stays unconditional, so a read that failed is still recorded.
    async dashboard({ actor }) {
      // One read after the other: the request's database is serial and
      // refuses a read issued while another is in flight.
      const result = await fromPromise(deps.crossSlice.jobCounts(), dashboardUnavailable).andThen(
        (jobs) =>
          fromPromise(
            deps.auditReads.recent(deps.db, DASHBOARD_RECENT_ACTIONS),
            dashboardUnavailable
          ).map((recent) => ({ jobs, recent }))
      );
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        role: deps.role,
        action: READ_AUDIT_ACTIONS.dashboard,
        details: { recentActions: DASHBOARD_RECENT_ACTIONS },
      });
      return result.map(({ jobs, recent }) => ({
        jobs,
        recentActions: recent.map((row) => auditToWire(row)),
      }));
    },

    // The job queue (Charter #12) — audited before the read, like the panel
    // and the subscriber list. `payload` rides the response VERBATIM and a
    // registered payload can name an account (the media-reclaim schema opens
    // on a user id), so the parameters are recorded and never the rows.
    async jobQueue({ actor, ...filter }) {
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        role: deps.role,
        action: READ_AUDIT_ACTIONS.jobQueue,
        details: {
          limit: filter.limit,
          ...(filter.status === undefined ? {} : { status: filter.status }),
          ...(filter.type === undefined ? {} : { type: filter.type }),
          ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
        },
      });
      const result = await fromPromise(deps.crossSlice.listJobs(filter), (cause) =>
        unavailableError('job queue read failed', cause)
      );
      return result.map((page) => ({
        rows: page.rows.map((row) => jobToWire(row)),
        nextCursor: page.nextCursor,
      }));
    },

    // Feedback triage inbox: a keyset page composed from the feedback slice's
    // published read (this slice never touches the `feedback` table). Not a
    // sensitive per-customer read — the list ships bounded body previews only,
    // so it is unaudited (the detail read below is the audited one).
    async feedbackInbox(filter) {
      return listFeedbackForInbox(deps.db, filter);
    },

    // Feedback detail: the full note. Sensitive (Charter #12) — exactly one
    // read-audit row per found detail, mirroring Customer-360, written only
    // when the row exists (a miss reveals nothing and targets no one).
    async feedbackDetail({ actor, id }) {
      const found = await getFeedbackById(deps.db, id);
      if (found.isErr()) return err(found.error);
      const detail = found.value;
      if (detail === null) return err(notFoundError('no feedback matches the id'));
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        role: deps.role,
        action: READ_AUDIT_ACTIONS.feedbackView,
        targetType: 'feedback',
        targetId: id,
        details: { feedbackId: id },
      });
      return ok(detail);
    },

    // Newsletter issues table: admin-authored content composed from the
    // newsletter slice's published keyset read — like the feedback inbox,
    // unaudited (nothing customer-derived; the subscriber reads are the
    // audited newsletter surface). The route caps the page size.
    async newsletterIssues(filter) {
      return listIssues(deps.db, {
        limit: filter.limit,
        ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
      }).map((page) => ({
        rows: page.issues.map((issue) => issueToWire(issue)),
        nextCursor: page.nextCursor,
      }));
    },

    // Aggregate counts only — no per-person data — so unaudited; the per-row
    // consent-evidence list below is the audited one.
    async newsletterSubscriberStats() {
      return subscriberStats(deps.db);
    },

    // Compose-screen preview: the SAME render the test-send mails, whose
    // unsubscribe link carries a token no subscriber holds — never a live
    // subscriber's URL, never a parallel renderer. Unaudited: admin-authored
    // content, no user data (the issues-read rationale).
    renderIssue({ subject, bodyMarkdown }) {
      const preview = renderIssuePreview({
        subject,
        bodyMarkdown,
        marketingUrl: deps.marketingUrl,
        sentAt: deps.clock.now(),
      });
      return Promise.resolve(ok({ html: preview.html }));
    },

    // Subscriber consent evidence: customer-derived PII (Charter #12) —
    // audited BEFORE the read executes (the SQL-panel precedent: a failed
    // read is still on the record) with the query parameters, never results.
    // The barrel's projection excludes every token column by construction.
    async newsletterSubscribers({ actor, limit, status, cursor }) {
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        role: deps.role,
        action: READ_AUDIT_ACTIONS.newsletterSubscribers,
        details: {
          limit,
          ...(status === undefined ? {} : { status }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      return listSubscribersForAdmin(deps.db, { limit, status, cursor }).map((page) => ({
        rows: page.subscribers.map((subscriber) => subscriberToWire(subscriber)),
        nextCursor: page.nextCursor,
      }));
    },

    // Catalog metadata, not customer metadata: deliberately OUTSIDE the
    // closed audited-read set (`READ_AUDIT_ACTIONS` is that set) and left to
    // the route class default — models' published admin read is what sees
    // through the product exposure gate.
    async modelsCatalog() {
      return listAdminCatalog(deps.db).map((page) => ({
        truncated: page.truncated,
        models: page.models.map((model) => modelToWire(model)),
      }));
    },

    async sqlPanel({ actor, query }) {
      const trimmed = query.trim();
      if (trimmed === '') {
        return err(validationError('sql panel query is empty'));
      }
      // Audit BEFORE executing: a refused or failed query is still on the
      // record, and the row counts toward the read-volume story either way.
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        role: deps.role,
        action: READ_AUDIT_ACTIONS.sqlPanel,
        details: { query: trimmed },
      });
      return deps.sqlPanel.run(trimmed);
    },
  };
}

/** Dashboard feed depth — a screenful, not an export. */
const DASHBOARD_RECENT_ACTIONS = 20;

function dashboardUnavailable(cause: unknown): DomainError {
  return unavailableError('dashboard read failed', cause);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function subscriberToWire(subscriber: AdminSubscriberRow): NewsletterSubscriberWire {
  return {
    ...subscriber,
    createdAt: subscriber.createdAt.toISOString(),
    confirmedAt: iso(subscriber.confirmedAt),
    unsubscribedAt: iso(subscriber.unsubscribedAt),
    suppressedAt: iso(subscriber.suppressedAt),
  };
}

function modelToWire(model: AdminCatalogModel): AdminModelWire {
  return { ...model, adminDisabledAt: iso(model.adminDisabledAt) };
}

function issueToWire(issue: NewsletterIssueRow): NewsletterIssueWire {
  return {
    id: issue.id,
    subject: issue.subject,
    status: issue.status,
    scheduledAt: issue.scheduledAt.toISOString(),
    canceledAt: iso(issue.canceledAt),
    sentAt: iso(issue.sentAt),
    recipientCount: issue.recipientCount,
    sentCount: issue.sentCount,
    failedCount: issue.failedCount,
    createdBy: issue.createdBy,
    createdAt: issue.createdAt.toISOString(),
  };
}
