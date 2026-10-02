import { PUBLIC_USAGE_STATS_SCHEMA_VERSION, publicUsageStatsSchema } from '@hushbox/shared';
import {
  buildPublicUsageStats,
  readLatestPublicStatsSnapshot,
  savePublicStatsSnapshot,
} from './public-usage-stats.js';
import { listDescriptors, modelDisplayOf } from '../../../models/index.js';
import { runOrThrow } from '../../../../lib/jobs/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { ModelDescriptor, PublicUsageStats } from '@hushbox/shared';
import type { BuildPublicUsageStatsDeps, PublicStatsModelMeta } from './public-usage-stats.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { PublicStatsStores } from '../../ports/public-stats.js';
import type { ListDescriptorsDeps } from '../../../models/index.js';
import type { CronEntry } from '../../../../lib/jobs/index.js';

/**
 * The daily public usage-stats snapshot: the billing slice builds the
 * anonymized payload and appends one snapshot row. At-least-once duplicates
 * are harmless by design — the endpoint reads only the latest row — so the
 * entry carries no dedup.
 */

/** The displayed-id subset of the exposed catalog, named as the model picker names it. */
export function modelMetaFromDescriptors(
  descriptors: readonly ModelDescriptor[],
  modelIds: readonly string[]
): ReadonlyMap<string, PublicStatsModelMeta> {
  const wanted = new Set(modelIds);
  const meta = new Map<string, PublicStatsModelMeta>();
  for (const descriptor of descriptors) {
    if (!wanted.has(descriptor.id)) continue;
    const { name, provider } = modelDisplayOf(descriptor);
    meta.set(descriptor.id, { displayName: name, provider });
  }
  return meta;
}

/**
 * Bridges the models slice's published catalog read into billing's meta
 * seam — model_catalog is models-owned, so billing never queries it. Hidden
 * or since-removed models miss the map; the snapshot entry names them.
 */
export function createCatalogModelMetaResolver(
  deps: ListDescriptorsDeps
): BuildPublicUsageStatsDeps['resolveModelMeta'] {
  return (modelIds) =>
    listDescriptors(deps).map((descriptors) => modelMetaFromDescriptors(descriptors, modelIds));
}

interface PublicStatsSnapshotEntryDeps {
  readonly db: Database;
  readonly stores: PublicStatsStores;
  readonly now: () => Date;
  readonly resolveModelMeta: BuildPublicUsageStatsDeps['resolveModelMeta'];
}

/** Every model a stored payload names, as it named it. */
function modelMetaFromStats(stats: PublicUsageStats): ReadonlyMap<string, PublicStatsModelMeta> {
  const meta = new Map<string, PublicStatsModelMeta>();
  for (const windows of Object.values(stats.modalities)) {
    for (const window of Object.values(windows)) {
      for (const model of window.models) {
        meta.set(model.modelId, { displayName: model.displayName, provider: model.provider });
      }
    }
  }
  return meta;
}

/** The names the latest stored snapshot gave, or none when no snapshot is stored. */
function storedModelMeta(
  deps: PublicStatsSnapshotEntryDeps
): ResultAsync<ReadonlyMap<string, PublicStatsModelMeta>, DomainError> {
  return readLatestPublicStatsSnapshot(
    deps.stores,
    deps.db,
    PUBLIC_USAGE_STATS_SCHEMA_VERSION
  ).andThen((row) => {
    if (row === null) return okAsync(new Map<string, PublicStatsModelMeta>());
    const parsed = publicUsageStatsSchema.safeParse(row.stats);
    if (!parsed.success) {
      return errAsync(
        validationError('public stats: stored snapshot payload failed the public schema')
      );
    }
    return okAsync(modelMetaFromStats(parsed.data));
  });
}

/**
 * The catalog's names, and for a model the catalog no longer exposes, the name
 * the latest stored snapshot gave it — so a dropped model keeps its name from
 * one snapshot to the next. A model neither names renders as its raw id.
 */
function withStoredNames(
  deps: PublicStatsSnapshotEntryDeps
): BuildPublicUsageStatsDeps['resolveModelMeta'] {
  return (modelIds) =>
    deps.resolveModelMeta(modelIds).andThen((catalogMeta) => {
      const missing = modelIds.filter((id) => !catalogMeta.has(id));
      if (missing.length === 0) return okAsync(catalogMeta);
      return storedModelMeta(deps).map((stored) => {
        const meta = new Map(catalogMeta);
        for (const id of missing) {
          const previous = stored.get(id);
          if (previous !== undefined) meta.set(id, previous);
        }
        return meta;
      });
    });
}

export function createPublicStatsSnapshotEntry(deps: PublicStatsSnapshotEntryDeps): CronEntry {
  return {
    name: 'public-stats-snapshot',
    run: async (): Promise<void> => {
      const stats = await runOrThrow(
        buildPublicUsageStats({
          db: deps.db,
          stores: deps.stores,
          now: deps.now(),
          resolveModelMeta: withStoredNames(deps),
        })
      );
      await runOrThrow(savePublicStatsSnapshot(deps.stores, deps.db, stats));
    },
  };
}
