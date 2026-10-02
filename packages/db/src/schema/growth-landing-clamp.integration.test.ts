import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { landingsAboveVisitors } from './growth-landing-clamp';
import { growthPaths } from './growth-paths';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

/**
 * A day this file has to itself, past the reference day every other suite
 * writes on: a path row is addressed by its dimension tuple alone, so a shared
 * bucket would make another file's row this file's subject.
 */
const DAY = new Date(TEST_DAY_START + 400 * DAY_MS);
const HOUR = new Date(DAY.getTime() + 9 * HOUR_MS);

/** Page names this file mints, so the cleanup deletes exactly what it wrote. */
const PATHS = {
  above: '/clamp-above',
  equal: '/clamp-equal',
  below: '/clamp-below',
  neighbour: '/clamp-neighbour',
} as const;

let db: Database;

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  // Written past the check the predicate exists to keep a row inside, so every
  // row a case reads is one the table accepts.
  await db.insert(growthPaths).values([
    { grain: 'day', bucket: DAY, path: PATHS.above, visitors: 12, landings: 2 },
    { grain: 'day', bucket: DAY, path: PATHS.equal, visitors: 4, landings: 3 },
    { grain: 'day', bucket: DAY, path: PATHS.below, visitors: 4, landings: 1 },
    { grain: 'day', bucket: DAY, path: PATHS.neighbour, visitors: 12, landings: 2 },
    { grain: 'hour', bucket: HOUR, path: PATHS.neighbour, visitors: 12, landings: 2 },
  ]);
}, 60_000);

afterAll(async () => {
  await db.delete(growthPaths).where(inArray(growthPaths.path, Object.values(PATHS)));
  await db.$client.end();
});

/** The pages the predicate selects for one addressed row and visitor count. */
async function selectedBy(target: {
  grain: 'hour' | 'day';
  bucket: Date;
  path: string;
  visitors: number;
}): Promise<string[]> {
  const rows = await db
    .select({ path: growthPaths.path })
    .from(growthPaths)
    .where(landingsAboveVisitors(target));
  return rows.map((row) => row.path);
}

describe('landingsAboveVisitors', () => {
  it('selects the addressed row whose stored landing count stands above the visitors written', async () => {
    expect(await selectedBy({ grain: 'day', bucket: DAY, path: PATHS.above, visitors: 1 })).toEqual(
      [PATHS.above]
    );
  });

  it('selects nothing where the stored landing count equals the visitors written', async () => {
    expect(await selectedBy({ grain: 'day', bucket: DAY, path: PATHS.equal, visitors: 3 })).toEqual(
      []
    );
  });

  it('selects nothing where the stored landing count is below the visitors written', async () => {
    expect(await selectedBy({ grain: 'day', bucket: DAY, path: PATHS.below, visitors: 3 })).toEqual(
      []
    );
  });

  it('selects nothing where the addressed row does not exist', async () => {
    expect(
      await selectedBy({ grain: 'day', bucket: DAY, path: '/clamp-absent', visitors: 0 })
    ).toEqual([]);
  });

  it('selects no row of another grain holding the same page and counts', async () => {
    expect(
      await selectedBy({ grain: 'hour', bucket: HOUR, path: PATHS.neighbour, visitors: 1 })
    ).toEqual([PATHS.neighbour]);
    expect(
      await selectedBy({ grain: 'day', bucket: HOUR, path: PATHS.neighbour, visitors: 1 })
    ).toEqual([]);
  });
});
