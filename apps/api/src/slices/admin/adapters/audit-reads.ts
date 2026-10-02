import { and, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { adminAudit } from '@hushbox/db';
import { buildKeysetPage } from '../../../lib/pagination/index.js';
import type { Database } from '@hushbox/db';
import type { KeysetPage } from '../../../lib/pagination/index.js';
import type {
  AdminAuditDigestReads,
  AdminAuditDigestRow,
  AdminAuditReads,
  AdminAuditSearchFilter,
  AdminAuditSearchResult,
  AdminAuditThreadedRow,
  AdminAuditWindow,
} from '../ports/index.js';

const SELECTED_COLUMNS = {
  id: adminAudit.id,
  actor: adminAudit.actor,
  role: adminAudit.role,
  action: adminAudit.action,
  targetType: adminAudit.targetType,
  targetId: adminAudit.targetId,
  details: adminAudit.details,
  undoes: adminAudit.undoes,
  createdAt: adminAudit.createdAt,
} as const;

type PageRow = Omit<AdminAuditThreadedRow, 'undoneBy'>;

/**
 * Resolves the reverse edge of undo threading for one page: an undo row's
 * own `undoes` column is the forward edge; the row it undid learns its
 * `undoneBy` from this batched lookup over the UNIQUE `undoes` index.
 */
async function undoneByFor(db: Database, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const undos = await db
    .select({ id: adminAudit.id, undoes: adminAudit.undoes })
    .from(adminAudit)
    .where(inArray(adminAudit.undoes, [...ids]));
  return new Map(undos.flatMap((row) => (row.undoes === null ? [] : [[row.undoes, row.id]])));
}

async function threadPage(
  db: Database,
  page: KeysetPage<PageRow>
): Promise<AdminAuditSearchResult> {
  const undoneBy = await undoneByFor(
    db,
    page.rows.map((row) => row.id)
  );
  return {
    rows: page.rows.map((row) => ({ ...row, undoneBy: undoneBy.get(row.id) ?? null })),
    nextCursor: page.nextCursor,
  };
}

/**
 * Read surface over the slice-owned `admin_audit` table. Every filter path
 * is indexed: actor rides `admin_audit_actor_created_at_idx`, target rides
 * `admin_audit_target_idx`, the cursor rides the primary key (uuidv7 ids
 * order by creation time), and undo threading rides the `undoes` UNIQUE
 * index.
 */
async function search(
  db: Database,
  filter: AdminAuditSearchFilter
): Promise<AdminAuditSearchResult> {
  const conditions = [
    filter.actor === undefined ? undefined : eq(adminAudit.actor, filter.actor),
    filter.action === undefined ? undefined : eq(adminAudit.action, filter.action),
    filter.targetType === undefined ? undefined : eq(adminAudit.targetType, filter.targetType),
    filter.targetId === undefined ? undefined : eq(adminAudit.targetId, filter.targetId),
    filter.from === undefined ? undefined : gte(adminAudit.createdAt, filter.from),
    filter.to === undefined ? undefined : lte(adminAudit.createdAt, filter.to),
    filter.cursor === undefined ? undefined : lt(adminAudit.id, filter.cursor),
  ].filter((condition) => condition !== undefined);
  const fetched = await db
    .select(SELECTED_COLUMNS)
    .from(adminAudit)
    .where(and(...conditions))
    .orderBy(desc(adminAudit.id))
    .limit(filter.limit + 1);
  // Paged before threading so the peeked row never costs an undo lookup.
  return threadPage(db, buildKeysetPage(fetched, filter.limit));
}

export function createAdminAuditReads(): AdminAuditReads {
  return {
    search,
    async recent(db: Database, limit: number): Promise<readonly AdminAuditThreadedRow[]> {
      const result = await search(db, { limit });
      return result.rows;
    },
  };
}

/**
 * Bound to its handle because the consumer is a job handler, not a request:
 * the composition root opens the connection once and hands the reader over
 * (`createJobsHealthProbes` precedent).
 */
export function createAdminAuditDigestReads(db: Database): AdminAuditDigestReads {
  return {
    async actionsInWindow(
      window: AdminAuditWindow,
      limit: number
    ): Promise<readonly AdminAuditDigestRow[]> {
      const rows = await db
        .select({
          action: adminAudit.action,
          actor: adminAudit.actor,
          targetType: adminAudit.targetType,
          targetId: adminAudit.targetId,
          createdAt: adminAudit.createdAt,
        })
        .from(adminAudit)
        .where(and(gte(adminAudit.createdAt, window.since), lt(adminAudit.createdAt, window.until)))
        .orderBy(desc(adminAudit.createdAt))
        .limit(limit);
      rows.reverse();
      return rows;
    },
  };
}
