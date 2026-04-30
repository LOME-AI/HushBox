import { inArray } from 'drizzle-orm';
import { contentItems, type Database } from '@hushbox/db';
import type { MediaStorage } from '../storage/index.js';

const DEFAULT_PREFIX = 'media/';
const DEFAULT_CUTOFF_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;

export interface RunR2GcInput {
  storage: MediaStorage;
  db: Database;
  now: number;
  prefix?: string;
  cutoffMs?: number;
  batchSize?: number;
}

export interface R2GcStats {
  scanned: number;
  orphansFound: number;
  deleted: number;
  bytesReclaimed: number;
  durationMs: number;
}

interface PageStats {
  orphansFound: number;
  deleted: number;
  bytesReclaimed: number;
}

async function findOrphans(
  db: Database,
  eligible: { key: string; uploaded: Date; size: number }[]
): Promise<{ key: string; size: number }[]> {
  if (eligible.length === 0) return [];
  const eligibleKeys = eligible.map((o) => o.key);
  const rows = await db
    .select({ key: contentItems.storageKey })
    .from(contentItems)
    .where(inArray(contentItems.storageKey, eligibleKeys));
  const knownKeys = new Set(rows.map((r) => r.key));
  return eligible.filter((o) => !knownKeys.has(o.key));
}

async function deleteOrphans(
  storage: MediaStorage,
  orphans: { key: string; size: number }[]
): Promise<{ deleted: number; bytesReclaimed: number }> {
  let deleted = 0;
  let bytesReclaimed = 0;
  for (const orphan of orphans) {
    try {
      await storage.delete(orphan.key);
      deleted += 1;
      bytesReclaimed += orphan.size;
    } catch (error) {
      console.error('r2-gc delete failed', { key: orphan.key, error });
    }
  }
  return { deleted, bytesReclaimed };
}

async function processPage(
  input: RunR2GcInput,
  cutoffMs: number,
  page: Awaited<ReturnType<MediaStorage['list']>>
): Promise<PageStats> {
  const eligible = page.objects.filter((o) => input.now - o.uploaded.getTime() > cutoffMs);
  const orphans = await findOrphans(input.db, eligible);
  const { deleted, bytesReclaimed } = await deleteOrphans(input.storage, orphans);
  return { orphansFound: orphans.length, deleted, bytesReclaimed };
}

/**
 * Daily GC of orphaned R2 media objects. Lists every object under `media/`,
 * filters to those uploaded more than 24h ago (cutoff configurable), looks
 * each batch up in `content_items.storage_key`, and deletes any object that
 * no DB row references.
 *
 * The 24h cutoff protects in-flight uploads — an object that was just
 * written but whose DB transaction hasn't committed yet must not be deleted.
 *
 * Errors on individual deletes are logged and the loop continues; errors
 * during list (the loop's outer call) abort the run and propagate.
 */
export async function runR2Gc(input: RunR2GcInput): Promise<R2GcStats> {
  const prefix = input.prefix ?? DEFAULT_PREFIX;
  const cutoffMs = input.cutoffMs ?? DEFAULT_CUTOFF_MS;
  const limit = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const startedAt = Date.now();

  let scanned = 0;
  let orphansFound = 0;
  let deleted = 0;
  let bytesReclaimed = 0;
  let cursor: string | undefined;

  do {
    const page = await input.storage.list(prefix, {
      limit,
      ...(cursor !== undefined && { cursor }),
    });
    scanned += page.objects.length;

    const pageStats = await processPage(input, cutoffMs, page);
    orphansFound += pageStats.orphansFound;
    deleted += pageStats.deleted;
    bytesReclaimed += pageStats.bytesReclaimed;

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return {
    scanned,
    orphansFound,
    deleted,
    bytesReclaimed,
    durationMs: Date.now() - startedAt,
  };
}
