import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { readLatestDescriptorRows, upsertCatalog } from './store.js';
import type { DescriptorContent, StoredPricing } from './normalize.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for catalog-store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per test run so repeated runs against one database never collide. */
const RUN_PREFIX = `mdl-cs-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

/** A stored token price at one rate for both legs; the store never reads it. */
function tokenPrice(rate: string): StoredPricing {
  return { kind: 'tokens', anchor: { base: { input: rate, output: rate }, tiers: [] } };
}

function contentFor(modelId: string, pricing: StoredPricing = tokenPrice('1')): DescriptorContent {
  return {
    id: modelId,
    provider: 'test-provider',
    version: '3',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {},
    pricing,
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
  };
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('upsertCatalog', () => {
  it('writes the catalog row on first delivery', async () => {
    const modelId = freshModelId('first');
    const result = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, tokenPrice('2500')),
      popularityRank: null,
      fetchedAt: new Date(TEST_DAY_START),
    });
    expect(result.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.descriptor).toMatchObject({ pricing: tokenPrice('2500') });
  });

  it('stores a descriptor that satisfies the shared ModelDescriptor contract', async () => {
    const modelId = freshModelId('contract');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      popularityRank: null,
      fetchedAt: new Date(TEST_DAY_START),
    });
    expect(written.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows[0]?.descriptor).toMatchObject({
      id: modelId,
      version: '3',
      fetchedAt: new Date(TEST_DAY_START).getTime(),
    });
  });

  it('overwrites the descriptor in place on a second upsert, keeping one row', async () => {
    const modelId = freshModelId('overwrite');
    const first = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, tokenPrice('2500')),
      popularityRank: null,
      fetchedAt: new Date(),
    });
    const second = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, tokenPrice('5000')),
      popularityRank: null,
      fetchedAt: new Date(),
    });
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.descriptor).toMatchObject({ pricing: tokenPrice('5000') });
  });

  it('persists the popularity rank and reads it back', async () => {
    const modelId = freshModelId('rank');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      popularityRank: 3,
      fetchedAt: new Date(),
    });
    expect(written.isOk()).toBe(true);
    const map = await unwrap(readLatestDescriptorRows(db));
    expect(map.get(modelId)?.popularityRank).toBe(3);
  });

  it('overwrites the popularity rank on a later upsert with identical content', async () => {
    const modelId = freshModelId('rank-change');
    const first = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      popularityRank: 5,
      fetchedAt: new Date(),
    });
    const second = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      popularityRank: 1,
      fetchedAt: new Date(),
    });
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const map = await unwrap(readLatestDescriptorRows(db));
    expect(map.get(modelId)?.popularityRank).toBe(1);
  });

  it('stores a null popularity rank for an unranked model', async () => {
    const modelId = freshModelId('rank-null');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      popularityRank: null,
      fetchedAt: new Date(),
    });
    expect(written.isOk()).toBe(true);
    const map = await unwrap(readLatestDescriptorRows(db));
    expect(map.get(modelId)?.popularityRank).toBeNull();
  });

  it('converges to one row when two writers race the same model', async () => {
    const modelId = freshModelId('race');
    const params = {
      modelId,
      content: contentFor(modelId),
      fetchedAt: new Date(),
      popularityRank: null,
    };
    const [a, b] = await Promise.all([upsertCatalog(db, params), upsertCatalog(rival, params)]);
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
  });
});

describe('readLatestDescriptorRows', () => {
  it('returns the stored descriptor keyed by model id', async () => {
    const modelId = freshModelId('read');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, tokenPrice('42')),
      popularityRank: null,
      fetchedAt: new Date(),
    });
    expect(written.isOk()).toBe(true);
    const map = await unwrap(readLatestDescriptorRows(db));
    const stored = map.get(modelId);
    expect(stored?.descriptor).toMatchObject({ pricing: tokenPrice('42') });
    expect(stored?.catalogId).toBeDefined();
  });

  it('reads in model_id order however the rows were written', async () => {
    // A plain select has no defined row order, and every exposure surface derives
    // its catalog list from this map's insertion order — so the order is part of
    // the contract. Written deliberately out of order.
    const ids = [freshModelId('order-c'), freshModelId('order-a'), freshModelId('order-b')];
    for (const modelId of ids) {
      const written = await upsertCatalog(db, {
        modelId,
        content: contentFor(modelId),
        popularityRank: null,
        fetchedAt: new Date(),
      });
      expect(written.isOk()).toBe(true);
    }
    const map = await unwrap(readLatestDescriptorRows(db));
    const read = [...map.keys()].filter((modelId) => ids.includes(modelId));
    expect(read).toEqual([...ids].toSorted((left, right) => left.localeCompare(right)));
  });

  it('carries the admin kill-switch state on every row (null when never disabled)', async () => {
    const modelId = freshModelId('read-enabled');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      popularityRank: null,
      fetchedAt: new Date(),
    });
    expect(written.isOk()).toBe(true);
    const map = await unwrap(readLatestDescriptorRows(db));
    expect(map.get(modelId)?.adminDisabledAt).toBeNull();
  });

  it('surfaces a set admin_disabled_at as a Date', async () => {
    const modelId = freshModelId('read-disabled');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      popularityRank: null,
      fetchedAt: new Date(),
    });
    expect(written.isOk()).toBe(true);
    const disabledAt = new Date(TEST_DAY_START);
    await db
      .update(modelCatalog)
      .set({ adminDisabledAt: disabledAt })
      .where(eq(modelCatalog.modelId, modelId));
    const map = await unwrap(readLatestDescriptorRows(db));
    expect(map.get(modelId)?.adminDisabledAt).toEqual(disabledAt);
  });

  it('reflects the latest overwrite for a model', async () => {
    const modelId = freshModelId('read-latest');
    for (const rate of ['1', '2', '3']) {
      const written = await upsertCatalog(db, {
        modelId,
        content: contentFor(modelId, tokenPrice(rate)),
        popularityRank: null,
        fetchedAt: new Date(),
      });
      expect(written.isOk()).toBe(true);
    }
    const map = await unwrap(readLatestDescriptorRows(db));
    expect(map.get(modelId)?.descriptor).toMatchObject({ pricing: tokenPrice('3') });
  });
});

describe('when the database is unreachable', () => {
  // Module-level narrowing of DATABASE_URL does not reach this closure.
  const databaseUrl: string = DATABASE_URL;

  async function closedDb(): Promise<typeof db> {
    const closed = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await closed.$client.end();
    return closed;
  }

  it('upsertCatalog fails unavailable', async () => {
    const modelId = freshModelId('down-upsert');
    const result = await upsertCatalog(await closedDb(), {
      modelId,
      content: contentFor(modelId),
      popularityRank: null,
      fetchedAt: new Date(),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('readLatestDescriptorRows fails unavailable', async () => {
    const result = await readLatestDescriptorRows(await closedDb());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
