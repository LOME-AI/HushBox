import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs, modelCatalog } from '@hushbox/db';
import { DAY_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { createJobWakeCollector, grantJobWakes } from '../../../../lib/jobs/index.js';
import { completeFail, completeOk } from '../../../../lib/jobs/complete.js';
import { TEST_GATEWAY_BASE_URL, catalogFetch, modelEntryFixture } from './gateway-fixtures.js';
import { createCatalogSightingRecorder } from '../../adapters/catalog-lifecycle.js';
import { readExposedCatalog } from './list-descriptors.js';
import { DESCRIPTOR_VERSION } from './normalize.js';
import { refreshCatalog } from './refresh.js';
import { CATALOG_REFRESH_JOB_TYPE } from './refresh-job-declaration.js';
import { createCatalogRefreshJobRegistration } from './refresh-job.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { JobExecution, JobOutcome } from '../../../../lib/jobs/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { RefreshCatalogDeps } from './refresh.js';

/** A stored descriptor read back as the object it was written as. */
const StoredDescriptor = z.record(z.string(), z.unknown());
const StoredVersion = z.object({ version: z.string() });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for stale-version catalog read integration tests');
}

/** The conversation Durable Object's handle: no scope granted it the job-wake capability. */
const roomDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Stands in for the request boundary's collector, which discharges after the response. */
const requestWakes = createJobWakeCollector();
/** The Worker request's handle, granted the capability as the request pipeline grants it. */
const requestDb = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  requestWakes
);

/** A granted handle whose transactions the test makes fail, as a database outage would. */
const outageDb = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);

const RUN_PREFIX = `mdl-sv-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

/**
 * Every refresh and read here runs at this instant. No concurrent file shares
 * this table, because each vitest worker slot clones its own database; but
 * files in one slot run in turn, and an earlier one can leave catalog rows
 * behind. Rows other files leave were sighted more than a staleness window
 * before this instant, and a file that sights rows at this instant removes them
 * before its next test runs. So the read's staleness window hides every row
 * this file did not write, and whether a read is all-old or mixed depends on
 * this file's rows alone, which `afterEach` removes.
 */
const SEEN_AT = new Date(TEST_DAY_START + 3650 * DAY_MS);

/** A release a few weeks before {@link SEEN_AT}, so no fixture model is too old to sell. */
const RECENT_RELEASE_SECONDS = secondsAt(SEEN_AT.getTime() - 30 * DAY_MS);

function refreshDeps(modelIds: readonly string[]): RefreshCatalogDeps {
  return {
    db: roomDb,
    fetch: catalogFetch({
      models: modelIds.map((id) => modelEntryFixture({ id, created: RECENT_RELEASE_SECONDS })),
      zdrModelIds: modelIds,
    }),
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: silentTelemetry,
    now: () => SEEN_AT,
    recordSighting: createCatalogSightingRecorder(roomDb),
  };
}

/** Rows a refresh wrote at the running version; `olderIds` are then stamped back to '2'. */
async function seedCatalog(
  currentIds: readonly string[],
  olderIds: readonly string[]
): Promise<void> {
  const refreshed = await refreshCatalog(refreshDeps([...currentIds, ...olderIds]));
  refreshed._unsafeUnwrap();
  if (olderIds.length === 0) return;
  const rows = await roomDb
    .select({ modelId: modelCatalog.modelId, descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [...olderIds]));
  for (const row of rows) {
    await roomDb
      .update(modelCatalog)
      .set({ descriptor: { ...StoredDescriptor.parse(row.descriptor), version: '2' } })
      .where(eq(modelCatalog.modelId, row.modelId));
  }
}

async function storedVersions(modelIds: readonly string[]): Promise<string[]> {
  const rows = await roomDb
    .select({ descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [...modelIds]));
  return rows.map((row) => StoredVersion.parse(row.descriptor).version);
}

function refreshJobRows(): Promise<{ payload: unknown }[]> {
  return roomDb
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.type, CATALOG_REFRESH_JOB_TYPE));
}

function readCatalog(db: Database): ReturnType<typeof readExposedCatalog> {
  return readExposedCatalog({ db, telemetry: silentTelemetry }, SEEN_AT.getTime());
}

/** The ids a read that must succeed exposes. */
async function exposedIds(db: Database): Promise<string[]> {
  const read = await readCatalog(db);
  return read._unsafeUnwrap().descriptors.map((descriptor) => descriptor.id);
}

/** A read the test needs refused before it asserts on what the refusal left behind. */
async function refusedRead(db: Database): Promise<DomainError> {
  const read = await readCatalog(db);
  return read._unsafeUnwrapErr();
}

function executionFor(payload: {
  readonly descriptorVersion: string;
}): JobExecution<{ descriptorVersion: string }> {
  return {
    jobId: crypto.randomUUID(),
    payload,
    claims: 1,
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

/**
 * Claims the one pending refresh row and writes the outcome's terminal state
 * through the dispatcher's own completion writers: success retires the row, a
 * failure re-pends it for its retry.
 */
async function completeAsTheDispatcher(outcome: JobOutcome): Promise<void> {
  const claimedBy = crypto.randomUUID();
  const [claimed] = await roomDb
    .update(jobs)
    .set({ status: 'running', claimedBy, claimedAt: SEEN_AT, claims: 1 })
    .where(eq(jobs.type, CATALOG_REFRESH_JOB_TYPE))
    .returning({ id: jobs.id, claims: jobs.claims });
  if (claimed === undefined) throw new Error('no catalog refresh row to claim');
  const fence = { jobId: claimed.id, claimedBy, claims: claimed.claims };
  if (outcome.kind === 'ok') await completeOk(roomDb, fence, outcome.result);
  else if (outcome.kind === 'fail') {
    await completeFail(roomDb, fence, { error: outcome.error, backoffSeconds: 1 });
  } else throw new Error(`unexpected outcome ${outcome.kind}`);
}

async function removeRefreshJobs(): Promise<void> {
  await roomDb.delete(jobs).where(eq(jobs.type, CATALOG_REFRESH_JOB_TYPE));
}

/** The read is whole-catalog, so a stale row seeded here must not outlive its test. */
async function removeSeededRows(): Promise<void> {
  if (createdModelIds.length > 0) {
    await roomDb.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
}

beforeEach(removeRefreshJobs);

afterEach(async () => {
  await removeRefreshJobs();
  await removeSeededRows();
});

afterAll(async () => {
  await roomDb.$client.end();
  await requestDb.$client.end();
  await outageDb.$client.end();
});

describe('a Worker catalog read whose every exposable row is at an older descriptor version', () => {
  it('fails with UNAVAILABLE', async () => {
    await seedCatalog([], [freshModelId('all-old-refused')]);

    const read = await readCatalog(requestDb);

    expect(read._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('enqueues exactly one catalog refresh job naming the running descriptor version', async () => {
    await seedCatalog([], [freshModelId('all-old-enqueues')]);

    await refusedRead(requestDb);

    expect(await refreshJobRows()).toEqual([
      { payload: { descriptorVersion: DESCRIPTOR_VERSION } },
    ]);
  });

  it('enqueues nothing more on a second read while the job is pending', async () => {
    await seedCatalog([], [freshModelId('all-old-second-read')]);

    await refusedRead(requestDb);
    await refusedRead(requestDb);

    expect(await refreshJobRows()).toHaveLength(1);
  });

  it("leaves the job's shard on the request's wake collector for the boundary to nudge", async () => {
    await seedCatalog([], [freshModelId('all-old-wake')]);

    await refusedRead(requestDb);

    expect(requestWakes.shards()).toContain('bulk');
  });

  it('succeeds once the enqueued job has run, with every row at the running version', async () => {
    const modelIds = [freshModelId('all-old-recovers-a'), freshModelId('all-old-recovers-b')];
    await seedCatalog([], modelIds);
    await refusedRead(requestDb);
    const [row] = await refreshJobRows();
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps(modelIds),
    });

    const outcome = await registration.handler(
      executionFor(registration.schema.parse(row?.payload))
    );

    expect(outcome.kind).toBe('ok');
    expect(await storedVersions(modelIds)).toEqual([DESCRIPTOR_VERSION, DESCRIPTOR_VERSION]);
    expect(await exposedIds(requestDb)).toEqual(expect.arrayContaining(modelIds));
  });
});

describe('a Worker catalog read with current rows beside older ones', () => {
  it('serves the current rows', async () => {
    const current = freshModelId('mixed-current');
    await seedCatalog([current], [freshModelId('mixed-older')]);

    expect(await exposedIds(requestDb)).toEqual([current]);
  });

  it('never exposes the older row', async () => {
    const older = freshModelId('mixed-never-exposed');
    await seedCatalog([freshModelId('mixed-beside')], [older]);

    expect(await exposedIds(requestDb)).not.toContain(older);
  });

  it('enqueues nothing, because a completed refresh leaves older rows only for models the gateway dropped', async () => {
    await seedCatalog([freshModelId('mixed-enqueue-current')], [freshModelId('mixed-enqueue-old')]);

    await exposedIds(requestDb);

    expect(await refreshJobRows()).toEqual([]);
  });
});

describe('a Worker catalog read after a refresh the gateway no longer offers a model to', () => {
  it("serves the rewritten rows while the dropped model's older row stays unexposed", async () => {
    const kept = freshModelId('dropped-kept');
    const dropped = freshModelId('dropped-gone');
    await seedCatalog([], [kept, dropped]);
    await refusedRead(requestDb);
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps([kept]),
    });
    await registration.handler(executionFor({ descriptorVersion: DESCRIPTOR_VERSION }));

    expect(await exposedIds(requestDb)).toEqual([kept]);
  });

  it('enqueues no further job once that refresh has completed', async () => {
    const kept = freshModelId('dropped-no-reenqueue-kept');
    const dropped = freshModelId('dropped-no-reenqueue-gone');
    await seedCatalog([], [kept, dropped]);
    await refusedRead(requestDb);
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps([kept]),
    });
    await registration.handler(executionFor({ descriptorVersion: DESCRIPTOR_VERSION }));
    // The dispatcher's terminal write, which takes the row out of the dedupe key's reach.
    await roomDb
      .update(jobs)
      .set({ status: 'succeeded' })
      .where(eq(jobs.type, CATALOG_REFRESH_JOB_TYPE));

    await exposedIds(requestDb);

    expect(await refreshJobRows()).toHaveLength(1);
  });
});

describe('a catalog refresh job whose refresh leaves no current row exposed', () => {
  it('fails, because an unreadable catalog is not a completed job', async () => {
    await seedCatalog([], [freshModelId('empty-listing-fails')]);
    await refusedRead(requestDb);
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps([]),
    });

    const outcome = await registration.handler(
      executionFor({ descriptorVersion: DESCRIPTOR_VERSION })
    );

    expect(outcome).toEqual({ kind: 'fail', error: 'catalog-refresh-exposed-nothing' });
  });

  it('fails when the refresh excludes every listed model, leaving the read served but empty', async () => {
    const modelId = freshModelId('all-excluded-fails');
    await seedCatalog([], [modelId]);
    await refusedRead(requestDb);
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => ({
        ...refreshDeps([modelId]),
        // Listed but outside the ZDR set, so the refresh excludes it.
        fetch: catalogFetch({
          models: [modelEntryFixture({ id: modelId, created: RECENT_RELEASE_SECONDS })],
          zdrModelIds: [],
        }),
      }),
    });

    const outcome = await registration.handler(
      executionFor({ descriptorVersion: DESCRIPTOR_VERSION })
    );

    expect(outcome).toEqual({ kind: 'fail', error: 'catalog-refresh-exposed-nothing' });
  });

  it('stays pending for its retry, so a following refused read adds no row', async () => {
    await seedCatalog([], [freshModelId('empty-listing-pending')]);
    await refusedRead(requestDb);
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps([]),
    });
    await completeAsTheDispatcher(
      await registration.handler(executionFor({ descriptorVersion: DESCRIPTOR_VERSION }))
    );

    await refusedRead(requestDb);

    expect(await refreshJobRows()).toHaveLength(1);
  });
});

describe('a catalog refresh job whose refresh leaves a current row exposed', () => {
  it('succeeds, and retires its row', async () => {
    const modelId = freshModelId('listing-succeeds');
    await seedCatalog([], [modelId]);
    await refusedRead(requestDb);
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps([modelId]),
    });

    const outcome = await registration.handler(
      executionFor({ descriptorVersion: DESCRIPTOR_VERSION })
    );
    await completeAsTheDispatcher(outcome);

    expect(outcome.kind).toBe('ok');
    const [row] = await roomDb
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.type, CATALOG_REFRESH_JOB_TYPE));
    expect(row?.status).toBe('succeeded');
  });
});

describe('a Worker catalog read whose refresh enqueue cannot commit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails with UNAVAILABLE naming the enqueue', async () => {
    await seedCatalog([], [freshModelId('enqueue-down')]);
    vi.spyOn(outageDb, 'transaction').mockRejectedValue(new Error('connection lost'));

    const read = await readCatalog(outageDb);

    const error = read._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toBe('model catalog refresh enqueue failed');
  });
});

describe('a Worker catalog read whose rows are all at the running version', () => {
  it('enqueues nothing', async () => {
    await seedCatalog([freshModelId('all-current')], []);

    await exposedIds(requestDb);

    expect(await refreshJobRows()).toEqual([]);
  });
});

describe("the conversation Durable Object's catalog read", () => {
  it('fails closed with UNAVAILABLE when every exposable row is older', async () => {
    await seedCatalog([], [freshModelId('room-all-old')]);

    const read = await readCatalog(roomDb);

    expect(read._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('enqueues nothing when every exposable row is older, because its handle carries no job-wake capability', async () => {
    await seedCatalog([], [freshModelId('room-all-old-no-job')]);

    await refusedRead(roomDb);

    expect(await refreshJobRows()).toEqual([]);
  });

  it('serves the current rows beside an older one', async () => {
    const current = freshModelId('room-mixed-current');
    await seedCatalog([current], [freshModelId('room-mixed-older')]);

    expect(await exposedIds(roomDb)).toEqual([current]);
  });

  it('enqueues nothing beside an older row', async () => {
    await seedCatalog([freshModelId('room-mixed-current-b')], [freshModelId('room-mixed-older-b')]);

    await exposedIds(roomDb);

    expect(await refreshJobRows()).toEqual([]);
  });
});
