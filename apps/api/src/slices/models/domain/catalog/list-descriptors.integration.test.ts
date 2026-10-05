import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { HOUR_MS, OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageEndpointsFixture,
  imageModelFixture,
  modelEntryFixture,
} from './gateway-fixtures.js';
import {
  CATALOG_STALENESS_WINDOW_MS,
  exposedCatalogGeneration,
  listDescriptors,
  readExposedCatalog,
} from './list-descriptors.js';
import { refreshCatalog } from './refresh.js';
import { createCatalogSightingRecorder } from '../../adapters/catalog-lifecycle.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';

async function unwrap(
  result: ResultAsync<ModelDescriptor[], DomainError>
): Promise<ModelDescriptor[]> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for list-descriptors integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per test run so repeated runs against one database never collide. */
const RUN_PREFIX = `mdl-ls-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

interface RecordedCapture {
  readonly message: string;
  readonly code: string;
}

function recordingTelemetry(): {
  telemetry: Telemetry;
  errors: RecordedLine[];
  captures: RecordedCapture[];
} {
  const errors: RecordedLine[] = [];
  const captures: RecordedCapture[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    captureError: (error: Error, code: string) => {
      captures.push({ message: error.message, code });
    },
  };
  return { telemetry, errors, captures };
}

const silentTelemetry: Telemetry = recordingTelemetry().telemetry;

/** The refresh clock every seeding refresh here stamps `last_seen_at` with, and
 * the clock every read below is taken at — the exposure filter hides a row it has
 * not sighted for {@link CATALOG_STALENESS_WINDOW_MS}, so a read whose clock has
 * drifted from the write's would hide the fixture rather than test it. */
const SEEN_AT = new Date(TEST_DAY_START);

async function refresh(fetch: typeof globalThis.fetch, seenAt: Date = SEEN_AT): Promise<void> {
  const result = await refreshCatalog({
    db,
    fetch,
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: silentTelemetry,
    now: () => seenAt,
    recordSighting: createCatalogSightingRecorder(db),
  });
  result._unsafeUnwrap();
}

/** Scoped to the caller's own model ids: the read is whole-catalog, and rows
 * seeded by other files sharing this worker's database — or by a retried
 * earlier attempt of this one — are still present. */
async function exposedIds(
  ids: readonly string[],
  nowMs: number = SEEN_AT.getTime()
): Promise<string[]> {
  const descriptors = await unwrap(listDescriptors({ db, telemetry: silentTelemetry }, nowMs));
  return descriptors.map((descriptor) => descriptor.id).filter((id) => ids.includes(id));
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('listDescriptors', () => {
  it('exposes newly discovered models with zero code changes', async () => {
    const first = freshModelId('zero-touch-a');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: first })], zdrModelIds: [first] })
    );
    expect(await exposedIds([first])).toEqual([first]);

    const second = freshModelId('zero-touch-b');
    await refresh(
      catalogFetch({
        models: [modelEntryFixture({ id: first }), modelEntryFixture({ id: second })],
        zdrModelIds: [first, second],
      })
    );
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const exposed = await exposedIds([first, second]);
    expect(exposed.toSorted(byName)).toEqual([first, second].toSorted(byName));
  });

  it('returns the parsed descriptor for an exposed model', async () => {
    const modelId = freshModelId('parsed');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    const descriptors = await unwrap(
      listDescriptors({ db, telemetry: silentTelemetry }, SEEN_AT.getTime())
    );
    const descriptor = descriptors.find((entry: ModelDescriptor) => entry.id === modelId);
    // Provider is derived from the model id's first path segment.
    expect(descriptor).toMatchObject({ provider: RUN_PREFIX, version: '4', zdrReachable: true });
  });

  it('injects the persisted popularity rank onto the exposed descriptor', async () => {
    const modelId = freshModelId('rank');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    const descriptors = await unwrap(
      listDescriptors({ db, telemetry: silentTelemetry }, SEEN_AT.getTime())
    );
    const descriptor = descriptors.find((entry: ModelDescriptor) => entry.id === modelId);
    expect(descriptor?.popularityRank).toBe(0);
  });

  it('hides a model that is not in the ZDR set', async () => {
    const modelId = freshModelId('no-zdr');
    await refresh(catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [] }));
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides an empty-pricing model', async () => {
    const modelId = freshModelId('unpriced');
    await refresh(
      catalogFetch({
        models: [modelEntryFixture({ id: modelId, pricing: null })],
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('exposes a ZDR-reachable, priced image model without any manual step', async () => {
    const modelId = freshModelId('image');
    await refresh(
      catalogFetch({
        images: [imageModelFixture({ id: modelId })],
        imageEndpoints: () =>
          imageEndpointsFixture([{ billable: 'output_image', unit: 'image', cost_usd: '0.04' }]),
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([modelId]);
  });

  it('hides a ZDR-reachable image model with no usable pricing', async () => {
    const modelId = freshModelId('image-unpriced');
    await refresh(
      catalogFetch({
        images: [imageModelFixture({ id: modelId })],
        imageEndpoints: () =>
          imageEndpointsFixture([
            { billable: 'output_image', unit: 'megapixel', cost_usd: '0.01' },
          ]),
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides a priced ZDR-reachable embedding model', async () => {
    // No embedding adapter exists; a listed model that always errors at call
    // time is a product flaw, so the family is hidden until one ships.
    const modelId = freshModelId('embedding');
    await refresh(
      catalogFetch({
        models: [
          modelEntryFixture({
            id: modelId,
            architecture: { input_modalities: ['text'], output_modalities: ['embedding'] },
          }),
        ],
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides an admin-disabled model without alerting (deliberate, not corrupt)', async () => {
    const modelId = freshModelId('admin-disabled');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    expect(await exposedIds([modelId])).toEqual([modelId]);

    await db
      .update(modelCatalog)
      .set({ adminDisabledAt: new Date() })
      .where(eq(modelCatalog.modelId, modelId));
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('hides a soft-deleted model without alerting (a derived verdict, not corrupt)', async () => {
    const modelId = freshModelId('excluded');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    expect(await exposedIds([modelId])).toEqual([modelId]);

    await db
      .update(modelCatalog)
      .set({ excludedReason: 'below-price-floor', excludedAt: new Date() })
      .where(eq(modelCatalog.modelId, modelId));
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('hides a stored descriptor whose outputs match no call-shape family, naming it a defect', async () => {
    const modelId = freshModelId('audio-only');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '4',
          inputs: ['text'],
          outputs: ['audio'],
          parameters: {},
          behaviors: [],
          limits: {},
          pricing: { kind: 'perSecond', anchor: { standard: '1' }, dearest: { standard: '1' } },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const settled = await readExposedCatalog({ db, telemetry: recorder.telemetry });
    const read = settled._unsafeUnwrap();
    expect(read.descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(read.defects).toContainEqual({ modelId, defect: 'family-unclassifiable' });
  });

  it('reports an unclassifiable row to its caller without emitting on the read', async () => {
    // Two corrupt rows: both come back on the defect channel, and neither
    // reaches telemetry — the refresh-time audit is what reports them.
    const ids = [freshModelId('audio-only-a'), freshModelId('audio-only-b')];
    for (const modelId of ids) {
      await db
        .insert(modelCatalog)
        .values({
          modelId,
          descriptor: {
            id: modelId,
            provider: 'x',
            version: '4',
            inputs: ['text'],
            outputs: ['audio'],
            parameters: {},
            behaviors: [],
            limits: {},
            pricing: { kind: 'perSecond', anchor: { standard: '1' }, dearest: { standard: '1' } },
            zdrReachable: true,
            releasedAt: OLD_RELEASE_SECONDS,
            fetchedAt: 0,
          },
        })
        .onConflictDoNothing();
    }
    const recorder = recordingTelemetry();
    const read = await readExposedCatalog({ db, telemetry: recorder.telemetry });
    // The read hands the defect to its caller and emits nothing itself: a
    // permanently unclassifiable row must not page once per visitor.
    expect(
      read
        ._unsafeUnwrap()
        .defects.filter((entry) => ids.includes(entry.modelId))
        .map((entry) => entry.defect)
    ).toEqual(['family-unclassifiable', 'family-unclassifiable']);
    expect(recorder.errors.filter((line) => ids.includes(String(line.fields?.modelName)))).toEqual(
      []
    );
    expect(recorder.captures).toEqual([]);
  });

  it('reports a contract-breaking row to its caller without emitting on the read', async () => {
    const ids = [freshModelId('corrupt-a'), freshModelId('corrupt-b')];
    for (const modelId of ids) {
      await db
        .insert(modelCatalog)
        .values({ modelId, descriptor: { id: modelId, nonsense: true } })
        .onConflictDoNothing();
    }
    const recorder = recordingTelemetry();
    const read = await readExposedCatalog({ db, telemetry: recorder.telemetry });
    expect(
      read
        ._unsafeUnwrap()
        .defects.filter((entry) => ids.includes(entry.modelId))
        .map((entry) => entry.defect)
    ).toEqual(['descriptor-invalid', 'descriptor-invalid']);
    expect(recorder.errors.filter((line) => ids.includes(String(line.fields?.modelName)))).toEqual(
      []
    );
    expect(recorder.captures).toEqual([]);
  });

  it('hides a persisted non-runnable (multi-output) descriptor without alerting', async () => {
    // Defense-in-depth: a dual-output row persisted before admission gained the
    // runnability gate (its outputs classify to a family, so the family gate
    // does not catch it) must still be hidden from every consumer.
    const modelId = freshModelId('multi-output');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '4',
          inputs: ['text'],
          outputs: ['text', 'image'],
          parameters: {},
          behaviors: [],
          limits: {},
          pricing: {
            kind: 'tokens',
            anchorContextTokens: 1_000_000,
            anchor: { base: { input: '1', output: '1' }, tiers: [] },
          },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('hides a persisted embedding descriptor without alerting', async () => {
    // Defense-in-depth: an embedding row that is ZDR-reachable and priced
    // classifies to the `embedding` family (so the unclassifiable gate does not
    // catch it) but has no adapter, so `isExposed` hides it — no alert, since a
    // classified family is not data corruption.
    const modelId = freshModelId('embedding-persisted');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '4',
          inputs: ['text'],
          outputs: ['embedding'],
          parameters: {},
          behaviors: [],
          limits: {},
          pricing: {
            kind: 'tokens',
            anchorContextTokens: 1_000_000,
            anchor: { base: { input: '1', output: '1' }, tiers: [] },
          },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('skips a stored descriptor that breaks the contract, naming it a defect', async () => {
    const modelId = freshModelId('corrupt');
    await db
      .insert(modelCatalog)
      .values({ modelId, descriptor: { id: modelId, nonsense: true } })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const settled = await readExposedCatalog({ db, telemetry: recorder.telemetry });
    const read = settled._unsafeUnwrap();
    expect(read.descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(read.defects).toContainEqual({ modelId, defect: 'descriptor-invalid' });
  });

  it('refuses a stored image price whose dearest rate is below its anchor, naming it a defect', async () => {
    // The price core does not re-validate what it is handed, so a price reaches
    // it only through the schema parse this read performs.
    const modelId = freshModelId('dearest-below-anchor');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '4',
          inputs: ['text'],
          outputs: ['image'],
          parameters: {},
          behaviors: [],
          limits: {},
          pricing: { kind: 'perImage', anchor: '50000000', dearest: '40000000' },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const settled = await readExposedCatalog({ db, telemetry: silentTelemetry });
    const read = settled._unsafeUnwrap();
    expect(read.descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(read.defects).toContainEqual({ modelId, defect: 'descriptor-invalid' });
  });

  it('never exposes a v2 row whose pricing predates the schedule, nor reports it as corrupt', async () => {
    // A v2 row carries flat rates the current pricing contract cannot parse, so
    // the version is read before the contract: a whole-contract parse first
    // would report it as a corrupt row instead of naming the refresh it needs.
    const current = freshModelId('beside-flat-v2');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: current })], zdrModelIds: [current] })
    );
    const modelId = freshModelId('flat-v2');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '2',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: ['streaming'],
          limits: { contextLength: 1000 },
          pricing: { inputPerToken: '2875', outputPerToken: '11500' },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
        lastSeenAt: SEEN_AT,
      })
      .onConflictDoNothing();
    try {
      const read = await readExposedCatalog({ db, telemetry: silentTelemetry }, SEEN_AT.getTime());
      const { descriptors, defects } = read._unsafeUnwrap();
      expect(descriptors.map((entry) => entry.id)).toContain(current);
      expect(descriptors.map((entry) => entry.id)).not.toContain(modelId);
      expect(defects.map((defect) => defect.modelId)).not.toContain(modelId);
    } finally {
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    }
  });

  it('never exposes an unbaked v1 descriptor row beside current rows', async () => {
    // A v1 row carries PRE-fee provider rates; serving it would price turns
    // below billable.
    const current = freshModelId('beside-unbaked-v1');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: current })], zdrModelIds: [current] })
    );
    const modelId = freshModelId('unbaked-v1');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '1',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: ['streaming'],
          limits: {},
          pricing: { inputPerToken: '2500' },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
        lastSeenAt: SEEN_AT,
      })
      .onConflictDoNothing();
    try {
      expect(await exposedIds([current, modelId])).toEqual([current]);
    } finally {
      // Remove the held-back row so no later whole-table read in this file sees it.
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    }
  });
});

describe('listDescriptors delisting', () => {
  /** One refresh offering exactly `ids`, stamped at `seenAt`. */
  async function sight(ids: readonly string[], seenAt: Date): Promise<void> {
    await refresh(
      catalogFetch({ models: ids.map((id) => modelEntryFixture({ id })), zdrModelIds: [...ids] }),
      seenAt
    );
  }

  it('keeps exposing a model still inside the staleness window', async () => {
    const modelId = freshModelId('recently-seen');
    await sight([modelId], SEEN_AT);
    const readAt = SEEN_AT.getTime() + CATALOG_STALENESS_WINDOW_MS - HOUR_MS;
    expect(await exposedIds([modelId], readAt)).toEqual([modelId]);
  });

  it('hides a model the gateway has stopped offering once the window passes', async () => {
    const dropped = freshModelId('delisted');
    const kept = freshModelId('still-offered');
    await sight([dropped, kept], SEEN_AT);

    // A later refresh no longer offers `dropped`, so nothing re-sights its row.
    const later = new Date(SEEN_AT.getTime() + CATALOG_STALENESS_WINDOW_MS + HOUR_MS);
    await sight([kept], later);

    expect(await exposedIds([dropped, kept], later.getTime())).toEqual([kept]);
  });

  it('retains the hidden row, so nothing naming the model id is orphaned', async () => {
    const dropped = freshModelId('retained');
    await sight([dropped], SEEN_AT);
    const readAt = SEEN_AT.getTime() + CATALOG_STALENESS_WINDOW_MS + HOUR_MS;
    expect(await exposedIds([dropped], readAt)).toEqual([]);

    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, dropped));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.excludedReason).toBeNull();
  });

  it('re-exposes a delisted model on the next refresh that offers it again', async () => {
    const returning = freshModelId('returning');
    await sight([returning], SEEN_AT);
    const afterWindow = SEEN_AT.getTime() + CATALOG_STALENESS_WINDOW_MS + HOUR_MS;
    expect(await exposedIds([returning], afterWindow)).toEqual([]);

    // No manual action: the gateway offering it again re-sights the row.
    const back = new Date(afterWindow);
    await sight([returning], back);
    expect(await exposedIds([returning], back.getTime())).toEqual([returning]);
  });
});

describe('readExposedCatalog generation', () => {
  /** One exposure read at the clock the fixture refreshes stamp `last_seen_at` with. */
  async function readNow(): Promise<{
    readonly descriptors: readonly ModelDescriptor[];
    readonly generation: string;
  }> {
    const settled = await readExposedCatalog({ db, telemetry: silentTelemetry }, SEEN_AT.getTime());
    return settled._unsafeUnwrap();
  }

  it('names the generation of exactly the rows it exposed', async () => {
    const modelId = freshModelId('generation-named');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    const read = await readNow();
    expect(read.generation).toBe(await exposedCatalogGeneration(read.descriptors));
  });

  it('moves on an admin enable while the enabled row keeps its fetchedAt', async () => {
    const modelId = freshModelId('generation-enabled');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    const first = await readNow();
    await db
      .update(modelCatalog)
      .set({ adminDisabledAt: new Date(TEST_DAY_START) })
      .where(eq(modelCatalog.modelId, modelId));
    const disabled = await readNow();

    await db
      .update(modelCatalog)
      .set({ adminDisabledAt: null })
      .where(eq(modelCatalog.modelId, modelId));
    const enabled = await readNow();

    const fetchedAtOf = (read: typeof first): number | undefined =>
      read.descriptors.find((entry) => entry.id === modelId)?.fetchedAt;
    expect(fetchedAtOf(enabled)).toBe(fetchedAtOf(first));
    expect(enabled.generation).not.toBe(disabled.generation);
  });
});
