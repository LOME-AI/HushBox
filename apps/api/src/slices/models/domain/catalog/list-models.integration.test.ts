import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { auditCatalogHealth, listModels } from './list-models.js';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the list-models integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per test run so repeated runs against one database never collide. */
const RUN_PREFIX = `mdl-lm-${crypto.randomUUID().slice(0, 8)}`;
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

/**
 * Exposed by every `listDescriptors` gate (ZDR-reachable, priced, language
 * family) but unprojectable: a text model without a context length fails the
 * shared `modelSchema` refine, so the list drops it.
 */
async function seedUnprojectable(modelId: string): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: {
        id: modelId,
        provider: RUN_PREFIX,
        version: '3',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: [],
        limits: {},
        pricing: { kind: 'tokens', anchor: { base: { input: '100', output: '200' }, tiers: [] } },
        zdrReachable: true,
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('listModels', () => {
  it('hides an unprojectable model from the list without emitting on the read', async () => {
    // A row that cannot be projected is a defect in data we wrote ourselves, and
    // a permanent one — so the list drops it silently and the refresh-time audit
    // is what reports it. Alerting here would page once per visitor.
    const ids = [freshModelId('no-context-a'), freshModelId('no-context-b')];
    for (const modelId of ids) await seedUnprojectable(modelId);
    const recorder = recordingTelemetry();
    const result = await listModels({ db, telemetry: recorder.telemetry }, TEST_DAY_START);
    const response = result._unsafeUnwrap();
    expect(response.models.filter((entry) => ids.includes(entry.id))).toEqual([]);
    expect(recorder.errors.filter((line) => ids.includes(String(line.fields?.modelName)))).toEqual(
      []
    );
    expect(recorder.captures).toEqual([]);
  });
});

describe('auditCatalogHealth', () => {
  it('alerts per unprojectable row and pages Sentry once for the whole catalog', async () => {
    // Two unprojectable rows, one page: the audit alerts per row so the ids are
    // recoverable from the line stream, and pages once so a catalog full of them
    // cannot flood Sentry.
    const ids = [freshModelId('audit-no-context-a'), freshModelId('audit-no-context-b')];
    for (const modelId of ids) await seedUnprojectable(modelId);
    const recorder = recordingTelemetry();

    await auditCatalogHealth({ db, telemetry: recorder.telemetry }, TEST_DAY_START);

    expect(
      recorder.errors.filter((line) => ids.includes(String(line.fields?.modelName)))
    ).toHaveLength(2);
    expect(
      recorder.captures.filter((capture) => capture.code === 'model_projection_invalid')
    ).toEqual([{ message: 'model failed wire projection', code: 'model_projection_invalid' }]);
  });

  it('alerts per contract-breaking row and pages Sentry once for the whole catalog', async () => {
    const ids = [freshModelId('audit-corrupt-a'), freshModelId('audit-corrupt-b')];
    for (const modelId of ids) {
      await db
        .insert(modelCatalog)
        .values({ modelId, descriptor: { id: modelId, nonsense: true } })
        .onConflictDoNothing();
    }
    const recorder = recordingTelemetry();

    await auditCatalogHealth({ db, telemetry: recorder.telemetry }, TEST_DAY_START);

    expect(
      recorder.errors.filter((line) => ids.includes(String(line.fields?.modelName)))
    ).toHaveLength(2);
    expect(
      recorder.captures.filter((capture) => capture.code === 'model_descriptor_invalid')
    ).toEqual([
      {
        message: 'stored model descriptor failed contract validation',
        code: 'model_descriptor_invalid',
      },
    ]);
  });

  it('alerts per unclassifiable row and pages Sentry once for the whole catalog', async () => {
    const ids = [freshModelId('audit-audio-a'), freshModelId('audit-audio-b')];
    for (const modelId of ids) {
      await db
        .insert(modelCatalog)
        .values({
          modelId,
          descriptor: {
            id: modelId,
            provider: RUN_PREFIX,
            version: '3',
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

    await auditCatalogHealth({ db, telemetry: recorder.telemetry }, TEST_DAY_START);

    expect(
      recorder.errors.filter((line) => ids.includes(String(line.fields?.modelName)))
    ).toHaveLength(2);
    expect(
      recorder.captures.filter((capture) => capture.code === 'model_family_unclassifiable')
    ).toEqual([
      { message: 'model outputs match no call-shape family', code: 'model_family_unclassifiable' },
    ]);
  });

  it('stays quiet when the catalog read itself refuses', async () => {
    // A v1 row makes the whole read fail fast (its PRE-fee rates would price
    // turns below billable). That condition already answers every product read
    // with a 503, so the audit adds nothing by repeating it — and it must not
    // turn a telemetry read into a refresh failure.
    const poison = freshModelId('audit-unbaked-v1');
    await db
      .insert(modelCatalog)
      .values({
        modelId: poison,
        descriptor: {
          id: poison,
          provider: RUN_PREFIX,
          version: '1',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: [],
          limits: { contextLength: 128_000 },
          pricing: { kind: 'tokens', anchor: { base: { input: '100', output: '200' }, tiers: [] } },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    try {
      await auditCatalogHealth({ db, telemetry: recorder.telemetry }, TEST_DAY_START);
      expect(recorder.errors).toEqual([]);
      expect(recorder.captures).toEqual([]);
    } finally {
      // Remove the poison row so no later whole-table read in this file trips
      // over it.
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, poison));
    }
  });

  it('says nothing about a projectable row', async () => {
    // Scoped to this row's own id: the audit reads the whole table, which in a
    // shared test database holds rows other files deliberately corrupted.
    const modelId = freshModelId('audit-healthy');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: RUN_PREFIX,
          version: '3',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: [],
          limits: { contextLength: 128_000 },
          pricing: { kind: 'tokens', anchor: { base: { input: '100', output: '200' }, tiers: [] } },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();

    await auditCatalogHealth({ db, telemetry: recorder.telemetry }, TEST_DAY_START);

    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });
});
