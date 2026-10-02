import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { err, fromPromise, ok } from '../../../lib/result/index.js';
import { READ_AUDIT_ACTIONS, writeReadAudit } from './read-audit.js';
import type { AdminRole } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type {
  AdminAuditRowWire,
  AdminJobRowWire,
  Customer360MoneyPanel,
  Customer360Panel,
  Customer360UsagePanel,
  Customer360View,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type {
  AdminAuditReads,
  AdminAuditThreadedRow,
  AdminCrossSliceReads,
  AdminJobRow,
  AdminStores,
} from '../ports/index.js';

/** The safe identity projection for the 360 header (never key material,
 * never the OPAQUE registration record). */
interface AdminUserSummary {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly emailVerified: boolean;
  readonly totpEnabled: boolean;
  readonly lockedAt: Date | null;
  readonly hasAcknowledgedPhrase: boolean;
}

/** Bound to identity's published stores at composition (structural subset). */
export interface AdminIdentityReader {
  findByEmail(email: string): ResultAsync<AdminUserSummary | null, DomainError>;
  findById(id: string): ResultAsync<AdminUserSummary | null, DomainError>;
}

/** Structural shapes of billing's published reads (bound at composition). */
interface AdminBalanceView {
  readonly purchasedNanoUsd: bigint;
  readonly freeNanoUsd: bigint;
  readonly allowance: {
    readonly day: string;
    readonly limitNanoUsd: bigint;
    readonly spentNanoUsd: bigint;
    readonly remainingNanoUsd: bigint;
  };
}

interface AdminLedgerRow {
  readonly createdAt: Date;
  readonly kind: string;
  readonly amountNanoUsd: bigint;
  readonly balanceAfterNanoUsd: bigint;
}

interface AdminUsageBreakdown {
  readonly models: readonly {
    readonly modelId: string;
    readonly totalNanoUsd: bigint;
    readonly recordCount: number;
    readonly estimatedCount: number;
  }[];
  readonly nextCursor: string | null;
}

export interface AdminBillingReader {
  balance(userId: string, now: Date): ResultAsync<AdminBalanceView, DomainError>;
  ledgerHistory(
    userId: string,
    window: { readonly start: Date; readonly end: Date; readonly limit: number }
  ): ResultAsync<readonly AdminLedgerRow[], DomainError>;
  usage(userId: string): ResultAsync<AdminUsageBreakdown, DomainError>;
}

export interface Customer360Deps {
  readonly db: Database;
  /**
   * The role the request's actor holds. It sits on the per-request deps rather
   * than on each read's params because it is a property of who is asking, not
   * of what was asked — one place to set, and no read can forget it.
   */
  readonly role: AdminRole;
  readonly stores: AdminStores;
  readonly auditReads: AdminAuditReads;
  readonly crossSlice: AdminCrossSliceReads;
  readonly identity: AdminIdentityReader;
  readonly billing: AdminBillingReader;
  readonly clock: { now(): Date };
}

/** Exactly one of the two lookups (the route schema enforces it too). */
export type Customer360Query =
  | { readonly email: string; readonly userId?: undefined }
  | { readonly userId: string; readonly email?: undefined };

/** The devices panel's payload, derived from the wire view rather than
 * restated: the shared package exports no standalone type for it. */
type DevicesPanelData = Extract<Customer360View['panels']['devices'], { ok: true }>['data'];

export function jobToWire(row: AdminJobRow): AdminJobRowWire {
  return {
    ...row,
    errors: [...row.errors],
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  };
}

export function auditToWire(row: AdminAuditThreadedRow): AdminAuditRowWire {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** Recent-ledger window: enough for a remediation conversation, hard-bounded. */
const LEDGER_WINDOW_DAYS = 90;
const LEDGER_LIMIT = 25;
const JOBS_PANEL_LIMIT = 20;
const ADMIN_HISTORY_LIMIT = 25;

/** One failing panel never blanks the view — it degrades to its error code.
 * Per-panel isolation is server-shaped for the SPA. */
async function panelOf<T>(
  load: () => PromiseLike<Result<T, DomainError>>
): Promise<Customer360Panel<T>> {
  const result = await load();
  return result.match(
    (data): Customer360Panel<T> => ({ ok: true, data }),
    (error): Customer360Panel<T> => ({ ok: false, error: error.code })
  );
}

function moneyPanel(
  deps: Customer360Deps,
  userId: string,
  now: Date
): ResultAsync<Customer360MoneyPanel, DomainError> {
  const start = new Date(now.getTime() - LEDGER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // One read after the other, like the panels in {@link loadCustomer360}: the
  // request's database holds one connection.
  return deps.billing
    .balance(userId, now)
    .andThen((balance) =>
      deps.billing
        .ledgerHistory(userId, { start, end: now, limit: LEDGER_LIMIT })
        .map((ledger) => ({ balance, ledger }))
    )
    .andThen(({ balance, ledger }) =>
      fromPromise(deps.crossSlice.walletSummaries(userId), (cause) =>
        unavailableError('wallet summaries read failed', cause)
      ).map((walletRows) => ({ balance, ledger, walletRows }))
    )
    .map(
      ({ balance, ledger, walletRows }): Customer360MoneyPanel => ({
        balance: {
          purchasedNanoUsd: balance.purchasedNanoUsd.toString(10),
          freeNanoUsd: balance.freeNanoUsd.toString(10),
          allowance: {
            day: balance.allowance.day,
            limitNanoUsd: balance.allowance.limitNanoUsd.toString(10),
            spentNanoUsd: balance.allowance.spentNanoUsd.toString(10),
            remainingNanoUsd: balance.allowance.remainingNanoUsd.toString(10),
          },
        },
        wallets: walletRows.map((wallet) => ({
          id: wallet.id,
          type: wallet.type,
          balanceNanoUsd: wallet.balanceNanoUsd.toString(10),
        })),
        recentLedger: ledger.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          kind: row.kind,
          amountNanoUsd: row.amountNanoUsd.toString(10),
          balanceAfterNanoUsd: row.balanceAfterNanoUsd.toString(10),
        })),
      })
    );
}

function usagePanel(
  deps: Customer360Deps,
  userId: string
): ResultAsync<Customer360UsagePanel, DomainError> {
  return deps.billing.usage(userId).map(
    (breakdown): Customer360UsagePanel => ({
      models: breakdown.models.map((row) => ({
        modelId: row.modelId,
        totalNanoUsd: row.totalNanoUsd.toString(10),
        recordCount: row.recordCount,
        estimatedCount: row.estimatedCount,
      })),
    })
  );
}

/**
 * Assembles the Customer-360 view: safe identity header + independent
 * panels, one coarse read-audit row per view (Charter #3 — sensitive reads
 * are audited), written only when a user was actually found (a miss reveals
 * nothing and targets no one).
 *
 * No sessions panel is assembled, and none can be: the only server-side
 * trace of a session is the per-(userId, sessionId) `sessionActive` Redis
 * liveness key, addressable only by exact key from a presented cookie (the
 * typed key registry deliberately exposes no keyspace scan), so a session
 * list or count is structurally impossible and any proxy metric would
 * misrepresent revocation truth.
 */
export async function loadCustomer360(
  deps: Customer360Deps,
  params: { readonly actor: string; readonly query: Customer360Query }
): Promise<Result<Customer360View, DomainError>> {
  const { query } = params;
  const lookup =
    query.email === undefined
      ? deps.identity.findById(query.userId)
      : deps.identity.findByEmail(query.email);
  const found = await lookup;
  if (found.isErr()) return err(found.error);
  const user = found.value;
  if (user === null) return err(notFoundError('no user matches the 360 query'));

  // Header facts identity's published record doesn't carry (createdAt,
  // lockReason). The header isn't a panel: a failure here fails the whole
  // view, exactly like the identity lookup — it reads the same users row.
  const facts = await fromPromise(deps.crossSlice.userAccountFacts(user.id), (cause) =>
    unavailableError('account facts read failed', cause)
  );
  if (facts.isErr()) return err(facts.error);
  if (facts.value === null) return err(notFoundError('no user matches the 360 query'));
  const accountFacts = facts.value;

  await writeReadAudit(deps.stores, deps.db, {
    actor: params.actor,
    role: deps.role,
    action: READ_AUDIT_ACTIONS.customer360,
    targetType: 'user',
    targetId: user.id,
    // The key kind, never the key: the audit table is append-only and outlives
    // the account, so an email written here would outlive its erasure.
    details: { by: query.email === undefined ? 'userId' : 'email' },
  });

  const now = deps.clock.now();
  // One panel after the other: the request's database is serial and refuses a
  // read issued while another is in flight.
  const money = await panelOf(() => moneyPanel(deps, user.id, now));
  const usage = await panelOf(() => usagePanel(deps, user.id));
  const conversations = await panelOf(() =>
    fromPromise(deps.crossSlice.conversationCounts(user.id), (cause) =>
      unavailableError('conversation counts read failed', cause)
    )
  );
  const devices = await panelOf(() =>
    // The port hands back a readonly token list where the wire type is a
    // mutable array, so the list is copied rather than aliased.
    fromPromise(deps.crossSlice.deviceTokenSummary(user.id), (cause) =>
      unavailableError('device tokens read failed', cause)
    ).map((summary): DevicesPanelData => ({ ...summary, tokens: [...summary.tokens] }))
  );
  const jobs = await panelOf(() =>
    fromPromise(deps.crossSlice.jobsTouchingUser(user.id, JOBS_PANEL_LIMIT), (cause) =>
      unavailableError('jobs panel read failed', cause)
    ).map((rows) => ({ jobs: rows.map((row) => jobToWire(row)) }))
  );
  const adminHistory = await panelOf(() =>
    fromPromise(
      deps.auditReads.search(deps.db, {
        targetType: 'user',
        targetId: user.id,
        limit: ADMIN_HISTORY_LIMIT,
      }),
      (cause) => unavailableError('admin history read failed', cause)
    ).map((page) => ({ actions: page.rows.map((row) => auditToWire(row)) }))
  );

  return ok({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      emailVerified: user.emailVerified,
      totpEnabled: user.totpEnabled,
      createdAt: accountFacts.createdAt.toISOString(),
      lockedAt: user.lockedAt === null ? null : user.lockedAt.toISOString(),
      lockReason: accountFacts.lockReason,
      hasAcknowledgedPhrase: user.hasAcknowledgedPhrase,
    },
    panels: { money, usage, conversations, devices, jobs, adminHistory },
  });
}
