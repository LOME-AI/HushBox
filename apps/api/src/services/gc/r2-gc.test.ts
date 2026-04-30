import { describe, it, expect, vi } from 'vitest';
import { runR2Gc } from './r2-gc.js';
import type { MediaStorage } from '../storage/index.js';

const NOW = new Date('2026-04-29T12:00:00.000Z').getTime();
const ONE_DAY_AGO = new Date('2026-04-28T11:00:00.000Z').getTime(); // > 24h ago
const ONE_HOUR_AGO = new Date('2026-04-29T11:00:00.000Z').getTime(); // < 24h ago

interface ListPage {
  objects: { key: string; uploaded: Date; size: number }[];
  nextCursor?: string;
}

function stubStorage(pages: ListPage[]): {
  storage: MediaStorage;
  deleteCalls: string[];
  deleteRejectKeys: Set<string>;
} {
  const deleteCalls: string[] = [];
  const deleteRejectKeys = new Set<string>();
  let pageIndex = 0;
  const storage: MediaStorage = {
    put: vi.fn(),
    mintDownloadUrl: vi.fn(),
    list: vi.fn(() => {
      const page = pages[pageIndex] ?? { objects: [] };
      pageIndex += 1;
      return Promise.resolve(page);
    }),
    delete: vi.fn((key: string) => {
      deleteCalls.push(key);
      if (deleteRejectKeys.has(key)) {
        return Promise.reject(new Error(`fake delete failure for ${key}`));
      }
      return Promise.resolve();
    }),
  };
  return { storage, deleteCalls, deleteRejectKeys };
}

interface DbRow {
  key: string;
}

function stubDb(knownKeys: string[]): { db: never; selectCalls: number } {
  const knownSet = new Set(knownKeys);
  let selectCalls = 0;
  const where = (predicate: { lookup: string[] }): Promise<DbRow[]> => {
    selectCalls += 1;
    const matches = predicate.lookup.filter((k) => knownSet.has(k)).map((k) => ({ key: k }));
    return Promise.resolve(matches);
  };
  const fromBuilder = {
    where: (clause: { _: string; values: string[] }) => where({ lookup: clause.values }),
  };
  const selectBuilder = { from: () => fromBuilder };
  const db = {
    select: () => selectBuilder,
  } as unknown as never;
  return { db, selectCalls: () => selectCalls } as unknown as { db: never; selectCalls: number };
}

vi.mock(import('drizzle-orm'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    inArray: ((_col: unknown, values: string[]) => ({ _: 'inArray', values })) as never,
  };
});

describe('runR2Gc', () => {
  it('deletes orphans uploaded more than 24h ago', async () => {
    const { storage, deleteCalls } = stubStorage([
      {
        objects: [
          { key: 'media/known-old.enc', uploaded: new Date(ONE_DAY_AGO), size: 1000 },
          { key: 'media/orphan-old-1.enc', uploaded: new Date(ONE_DAY_AGO), size: 2000 },
          { key: 'media/orphan-old-2.enc', uploaded: new Date(ONE_DAY_AGO), size: 3000 },
        ],
      },
    ]);
    const dbHelper = stubDb(['media/known-old.enc']);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: NOW });

    expect(stats.scanned).toBe(3);
    expect(stats.orphansFound).toBe(2);
    expect(stats.deleted).toBe(2);
    expect(stats.bytesReclaimed).toBe(5000);
    expect(deleteCalls.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'media/orphan-old-1.enc',
      'media/orphan-old-2.enc',
    ]);
  });

  it('preserves objects uploaded less than 24h ago', async () => {
    const { storage, deleteCalls } = stubStorage([
      {
        objects: [{ key: 'media/recent-orphan.enc', uploaded: new Date(ONE_HOUR_AGO), size: 1000 }],
      },
    ]);
    const dbHelper = stubDb([]);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: NOW });

    expect(stats.scanned).toBe(1);
    expect(stats.orphansFound).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('paginates through multiple list calls via cursor', async () => {
    const { storage } = stubStorage([
      {
        objects: [{ key: 'media/a.enc', uploaded: new Date(ONE_DAY_AGO), size: 100 }],
        nextCursor: 'cursor-1',
      },
      {
        objects: [{ key: 'media/b.enc', uploaded: new Date(ONE_DAY_AGO), size: 200 }],
        nextCursor: 'cursor-2',
      },
      {
        objects: [{ key: 'media/c.enc', uploaded: new Date(ONE_DAY_AGO), size: 300 }],
      },
    ]);
    const dbHelper = stubDb(['media/a.enc', 'media/b.enc', 'media/c.enc']);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: NOW });

    expect(stats.scanned).toBe(3);
    expect(stats.orphansFound).toBe(0);
    expect(storage.list).toHaveBeenCalledTimes(3);
  });

  it('handles empty bucket without errors', async () => {
    const { storage } = stubStorage([{ objects: [] }]);
    const dbHelper = stubDb([]);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: NOW });

    expect(stats).toEqual(expect.objectContaining({ scanned: 0, deleted: 0, bytesReclaimed: 0 }));
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('deletes all objects when DB has none', async () => {
    const objects = Array.from({ length: 5 }, (_, index) => ({
      key: `media/orphan-${String(index)}.enc`,
      uploaded: new Date(ONE_DAY_AGO),
      size: 100,
    }));
    const { storage, deleteCalls } = stubStorage([{ objects }]);
    const dbHelper = stubDb([]);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: NOW });

    expect(stats.deleted).toBe(5);
    expect(deleteCalls).toHaveLength(5);
  });

  it('continues and logs after an individual delete failure', async () => {
    const { storage, deleteCalls, deleteRejectKeys } = stubStorage([
      {
        objects: [
          { key: 'media/orphan-1.enc', uploaded: new Date(ONE_DAY_AGO), size: 100 },
          { key: 'media/orphan-2.enc', uploaded: new Date(ONE_DAY_AGO), size: 200 },
          { key: 'media/orphan-3.enc', uploaded: new Date(ONE_DAY_AGO), size: 300 },
        ],
      },
    ]);
    deleteRejectKeys.add('media/orphan-2.enc');
    const dbHelper = stubDb([]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stats = await runR2Gc({ storage, db: dbHelper.db, now: NOW });
      expect(deleteCalls).toEqual([
        'media/orphan-1.enc',
        'media/orphan-2.enc',
        'media/orphan-3.enc',
      ]);
      expect(stats.deleted).toBe(2);
      expect(stats.bytesReclaimed).toBe(400);
      expect(errorSpy).toHaveBeenCalledWith('r2-gc delete failed', expect.any(Object));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns durationMs >= 0', async () => {
    const { storage } = stubStorage([{ objects: [] }]);
    const dbHelper = stubDb([]);

    const stats = await runR2Gc({ storage, db: dbHelper.db, now: NOW });

    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes prefix and limit to storage.list', async () => {
    const { storage } = stubStorage([{ objects: [] }]);
    const dbHelper = stubDb([]);

    await runR2Gc({
      storage,
      db: dbHelper.db,
      now: NOW,
      prefix: 'custom-prefix/',
      batchSize: 250,
    });

    expect(storage.list).toHaveBeenCalledWith(
      'custom-prefix/',
      expect.objectContaining({ limit: 250 })
    );
  });
});
