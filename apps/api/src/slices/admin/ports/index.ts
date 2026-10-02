import type { AdminRole } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { AdminJobCountsWire, SqlPanelResultWire } from '@hushbox/shared';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

export { UndoAlreadyClaimedError } from './undo-already-claimed-error.js';

/** One audit row, as the engine writes it. `details` must be wire-JSON. */
export interface AdminAuditInsertRow {
  readonly actor: string;
  /** The role the Access stage resolved for that actor; every row carries one. */
  readonly role: AdminRole;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly details: unknown;
  /** The audit row id being undone, when this run is an inverse-as-undo. */
  readonly undoes?: string;
}

/** The undo target's fields the engine validates the relationship against. */
export interface AdminAuditUndoTarget {
  readonly action: string;
  readonly details: unknown;
}

/** One audit-trail row with its undo threading resolved both ways. */
export interface AdminAuditThreadedRow {
  readonly id: string;
  readonly actor: string;
  /** The role the actor was acting as when the row was written. */
  readonly role: AdminRole;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly details: unknown;
  /** The audit row this row undid, when this row is an undo execution. */
  readonly undoes: string | null;
  /** The audit row that undid this one, when it has been undone. */
  readonly undoneBy: string | null;
  readonly createdAt: Date;
}

export interface AdminAuditSearchFilter {
  readonly actor?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  /** An audit row id; strictly-older rows are returned (uuidv7 ordering). */
  readonly cursor?: string;
}

export interface AdminAuditSearchResult {
  readonly rows: readonly AdminAuditThreadedRow[];
  readonly nextCursor: string | null;
}

/** Read surface over the slice-owned `admin_audit` (search + dashboard feed). */
export interface AdminAuditReads {
  search(db: Database, filter: AdminAuditSearchFilter): Promise<AdminAuditSearchResult>;
  recent(db: Database, limit: number): Promise<readonly AdminAuditThreadedRow[]>;
}

/** The half-open span `[since, until)` a window read summarizes. */
export interface AdminAuditWindow {
  readonly since: Date;
  readonly until: Date;
}

/** One `admin_audit` row as a summary of the trail reports it. */
export interface AdminAuditDigestRow {
  readonly action: string;
  readonly actor: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: Date;
}

/**
 * The capped window read over the slice-owned `admin_audit`, beside the search
 * surface above. Returns the window's newest `limit` rows oldest-first: the cap
 * keeps a summary from becoming an unbounded scan, and dropping the oldest
 * rather than the newest is what leaves an over-full window still reporting
 * what happened last.
 */
export interface AdminAuditDigestReads {
  actionsInWindow(window: AdminAuditWindow, limit: number): Promise<readonly AdminAuditDigestRow[]>;
}

/** Per-user panel: conversation metadata counts (never content). */
export interface AdminConversationCounts {
  readonly owned: number;
  readonly activeMemberships: number;
}

/** 360-header account facts identity's published record does not carry. */
export interface AdminUserAccountFacts {
  readonly createdAt: Date;
  readonly lockReason: string | null;
}

/**
 * One wallet's identity for the 360 money panel — the id is what the UI
 * prefills into `wallet.credit`/`wallet.clawback` targets.
 */
export interface AdminWalletSummary {
  readonly id: string;
  readonly type: string;
  readonly balanceNanoUsd: bigint;
}

/**
 * Per-user device-token summary: platform per token, never the token value —
 * the token itself is push credential material and must not leave the server.
 */
export interface AdminDeviceTokenSummary {
  readonly count: number;
  readonly tokens: readonly { readonly platform: string }[];
}

/** One job row summarized for the 360 jobs panel / queue screen. */
export interface AdminJobRow {
  readonly id: string;
  readonly type: string;
  readonly shard: string;
  readonly status: string;
  /** True when a dead row has been discarded (restorable marker). */
  readonly discarded: boolean;
  readonly failures: number;
  readonly claims: number;
  readonly payload: unknown;
  readonly errors: readonly { at: string; claim: number; error: string }[];
  readonly nextAttemptAt: Date;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface AdminJobQueueFilter {
  /** `discarded` selects dead rows carrying the restorable marker. */
  readonly status?: 'pending' | 'running' | 'succeeded' | 'cancelled' | 'dead' | 'discarded';
  readonly type?: string;
  readonly limit: number;
  /** A job row id; strictly-older rows are returned (uuidv7 ordering). */
  readonly cursor?: string;
}

export interface AdminJobQueueResult {
  readonly rows: readonly AdminJobRow[];
  readonly nextCursor: string | null;
}

/** Dashboard job-health counters (backlog + dead-letter inbox) — the wire
 * shape itself, so the counters this port supplies and the ones the SPA
 * parses are one declaration. */
export type AdminJobCounts = AdminJobCountsWire;

/**
 * Cross-slice read surface for the 360 panels and the jobs screens, bound at
 * the composition root (slice code references only its own schema objects;
 * each method's doc names the slice that owns the table it reads).
 */
export interface AdminCrossSliceReads {
  /** `users`-row facts for the 360 header (identity owns the table). */
  userAccountFacts(userId: string): Promise<AdminUserAccountFacts | null>;
  /** Wallet ids/types/balances for the 360 money panel (billing owns `wallets`). */
  walletSummaries(userId: string): Promise<readonly AdminWalletSummary[]>;
  /** Device-token summary for the 360 devices panel (notifications owns `device_tokens`). */
  deviceTokenSummary(userId: string): Promise<AdminDeviceTokenSummary>;
  /** Owned/membership counts for the 360 conversations panel (conversations owns both tables). */
  conversationCounts(userId: string): Promise<AdminConversationCounts>;
  /**
   * Jobs whose payload names the user (`jobs` is lib-owned). Deliberately
   * payload-based and unindexed — add a `jobs.targetUserId` (payload) index
   * when this panel gets hot.
   */
  jobsTouchingUser(userId: string, limit: number): Promise<readonly AdminJobRow[]>;
  /** Job-queue page for the jobs screens (`jobs` is lib-owned). */
  listJobs(filter: AdminJobQueueFilter): Promise<AdminJobQueueResult>;
  /** Dashboard job-health counters (`jobs` is lib-owned). */
  jobCounts(): Promise<AdminJobCounts>;
}

/** A SELECT-only SQL panel result page (rows capped, never unbounded) — the
 * wire shape itself, so the page this port hands back and the one the SPA
 * parses are one declaration. */
export type SqlPanelResult = SqlPanelResultWire;

/**
 * The read-only SQL panel connection: a SECOND Postgres connection using the
 * SELECT-only `admin_sql_panel` role — psql-grade power, structurally
 * write-proof (a write is refused by the role, not by parsing).
 */
export interface SqlPanel {
  run(queryText: string): ResultAsync<SqlPanelResult, DomainError>;
}

/**
 * The admin slice's own store surface — `admin_audit` is the only table this
 * slice owns; every other effect composes published slice barrels.
 */
export interface AdminStores {
  /**
   * Loads the audit row an undo names as its target. The engine calls this
   * on the open settlement transaction before the audit insert, so the
   * relationship check and the `undoes` UNIQUE claim see one snapshot.
   */
  getAuditForUndo(writer: DbWriter, id: string): Promise<AdminAuditUndoTarget | undefined>;
  /**
   * Inserts the audit row. The engine passes the open settlement transaction
   * so the row commits atomically with the op's effects (audit-in-tx);
   * guardrail-refusal rows pass the client directly (they have no effects to
   * be atomic with). Throws `UndoAlreadyClaimedError` on a lost undo claim.
   */
  insertAudit(writer: DbWriter, row: AdminAuditInsertRow): Promise<{ id: string }>;
}

export type {
  AccessLogEvent,
  AccessLogRead,
  AccessLogReader,
  AccessLogWindow,
} from './access-log.js';
