import { z } from 'zod';
import { CATALOG_GENERATION_HEX_LENGTH, ModelDescriptor, isExposedModel } from '@hushbox/shared';
import { HOUR_MS } from '@hushbox/shared/durations';
import { unavailableError } from '../../../../lib/errors/index.js';
import { hashCanonicalJson } from '../../../../lib/idempotency/index.js';
import {
  createAppJobRegistry,
  enqueueOnlyRegistry,
  enqueueWithinTx,
  grantJobWakes,
  jobWakesOf,
  runWithJobWakes,
} from '../../../../lib/jobs/index.js';
import { ResultAsync, errAsync, okAsync } from '../../../../lib/result/index.js';
import { dispatchFamilyFor } from '../dispatch.js';
import { readLatestDescriptorRows } from './store.js';
import { DESCRIPTOR_VERSION } from './normalize.js';
import {
  CATALOG_REFRESH_JOB_TYPE,
  catalogRefreshEnqueueRegistration,
} from './refresh-job-declaration.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { StoredDescriptorRow } from './store.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

export interface ListDescriptorsDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
}

/**
 * How long a catalog row may go unsighted before the read stops selling it.
 * `last_seen_at` advances on every refresh that finds the model in a live
 * gateway fetch, so this is the gap the gateway must go without offering a
 * model before it is treated as delisted.
 *
 * A day — twenty-four passes of the hourly refresh — and deliberately generous,
 * because the two errors are not symmetric. Hiding a live model is a catalog
 * outage the product feels immediately; keeping a dead one costs a turn that
 * fails fast at the gateway and bills nothing. Twenty-four consecutive misses
 * also sit far above what any transient fetch failure, gateway incident or
 * deploy gap produces, and the margin is wide enough that the exact refresh
 * cadence is not load-bearing on this number.
 *
 * Read-side and lazy, so nothing sweeps and no column is written: a model the
 * gateway offers again is re-sighted by the next refresh and reappears with no
 * manual action.
 */
export const CATALOG_STALENESS_WINDOW_MS = 24 * HOUR_MS;

/**
 * The identity of one exposed-catalog read: the first
 * {@link CATALOG_GENERATION_HEX_LENGTH} hex characters of the SHA-256 of its
 * sorted (model id, `fetchedAt`) pairs. A refresh that rewrites
 * a row moves its `fetchedAt`; an admin enable or disable, a delisting, an
 * exclusion, or a re-admission whose content is unchanged changes which rows are
 * exposed and moves no `fetchedAt`, so the pairs are hashed rather than the
 * newest `fetchedAt` taken.
 */
export async function exposedCatalogGeneration(
  descriptors: readonly Pick<ModelDescriptor, 'id' | 'fetchedAt'>[]
): Promise<string> {
  const pairs = descriptors
    .map((descriptor) => [descriptor.id, descriptor.fetchedAt] as const)
    .toSorted(([left], [right]) => (left < right ? -1 : 1));
  const digest = await hashCanonicalJson(pairs);
  return digest.slice(0, CATALOG_GENERATION_HEX_LENGTH);
}

/**
 * The two hidden-row causes that are corruption in data we wrote ourselves,
 * rather than an operator decision or a derived verdict.
 */
export type RowDefect = 'descriptor-invalid' | 'family-unclassifiable';

/** One corrupt row, named, so a reporter can say which model it was. */
export interface CatalogRowDefect {
  readonly modelId: string;
  readonly defect: RowDefect;
}

/**
 * One catalog read: the exposed descriptors, and the rows dropped for
 * corruption on the way.
 *
 * The defects are RETURNED rather than reported, and that split is the point.
 * A malformed row is a permanent condition in data we wrote ourselves — it does
 * not change between two reads a second apart — so a read that alerted would
 * emit the same error once per visitor while the condition lasted. The catalog
 * changes only when a refresh writes it, so the refresh is where the condition
 * is reported — by the catalog-health audit in `list-models.ts`, which the
 * refresh runs — and the read stays silent.
 */
interface ExposedCatalogRead {
  readonly descriptors: ModelDescriptor[];
  readonly defects: readonly CatalogRowDefect[];
  /** {@link exposedCatalogGeneration} of `descriptors`. */
  readonly generation: string;
}

/**
 * One row's read decision: expose it, hide it quietly, or hold it back as
 * written under another descriptor version, naming the refresh it needs.
 */
type RowOutcome =
  | { readonly kind: 'exposed'; readonly descriptor: ModelDescriptor }
  | { readonly kind: 'hidden'; readonly defect?: RowDefect }
  | { readonly kind: 'otherVersion'; readonly error: DomainError };

/** The one field read before the rest: what contract the row was written under. */
const StoredVersion = z.object({ version: z.string().min(1) });

/**
 * The version is read before the descriptor is parsed whole: a row written
 * under an older contract fails the current one, and a whole-contract parse
 * first would hide it as a corrupt row rather than name the refresh it needs.
 */
function rowOutcome(modelId: string, stored: StoredDescriptorRow): RowOutcome {
  const version = StoredVersion.safeParse(stored.descriptor);
  if (!version.success) {
    return { kind: 'hidden', defect: 'descriptor-invalid' };
  }
  if (version.data.version !== DESCRIPTOR_VERSION) {
    return {
      kind: 'otherVersion',
      error: unavailableError(
        `model catalog row '${modelId}' carries descriptor version ` +
          `'${version.data.version}' (expected '${DESCRIPTOR_VERSION}'); its rates are not ` +
          'the current billable schedule — run the catalog refresh to re-bake the catalog'
      ),
    };
  }
  const parsed = ModelDescriptor.safeParse(stored.descriptor);
  if (!parsed.success) {
    return { kind: 'hidden', defect: 'descriptor-invalid' };
  }
  if (dispatchFamilyFor(parsed.data) === undefined) {
    return { kind: 'hidden', defect: 'family-unclassifiable' };
  }
  if (!isExposedModel(parsed.data)) return { kind: 'hidden' };
  // Rank lives in the column, never the descriptor jsonb; inject it here so
  // downstream projections carry it (null column → undefined field).
  return {
    kind: 'exposed',
    descriptor: { ...parsed.data, popularityRank: stored.popularityRank ?? undefined },
  };
}

/** Enqueue-only: the read holds the registration's declaration and never its work. */
const CATALOG_REFRESH_ENQUEUE_REGISTRY = enqueueOnlyRegistry(
  createAppJobRegistry([catalogRefreshEnqueueRegistration])
);

/**
 * Enqueues the refresh that re-bakes the catalog at {@link DESCRIPTOR_VERSION}.
 * The dedupe key admits one pending or running row per version, so a refused
 * read while that row is pending or running enqueues nothing.
 *
 * Only a handle carrying the job-wake capability enqueues, which is what keeps
 * the conversation Durable Object out: its handle lives as long as the object,
 * no scope grants it the capability, and its read fails closed and enqueues
 * nothing (`docs/JOBS.md` §Enqueue). The Worker's request and cron handles carry
 * it.
 */
function requestCatalogRefresh(db: Database): ResultAsync<void, DomainError> {
  if (jobWakesOf(db) === undefined) return okAsync();
  return ResultAsync.fromPromise(
    runWithJobWakes(db, (collected) =>
      db.transaction((tx) =>
        enqueueWithinTx(grantJobWakes(tx, collected), CATALOG_REFRESH_ENQUEUE_REGISTRY, {
          type: CATALOG_REFRESH_JOB_TYPE,
          payload: { descriptorVersion: DESCRIPTOR_VERSION },
          dedupeKey: `${CATALOG_REFRESH_JOB_TYPE}:${DESCRIPTOR_VERSION}`,
        })
      )
    ),
    (cause) => unavailableError('model catalog refresh enqueue failed', cause)
  ).map(() => undefined);
}

/** One pass over the rows: what to expose, what is corrupt, and the first row held back. */
interface RowScan {
  readonly descriptors: ModelDescriptor[];
  readonly defects: CatalogRowDefect[];
  /** The refusal the first row written under another descriptor version names. */
  readonly otherVersion: DomainError | undefined;
}

function scanRows(latest: ReadonlyMap<string, StoredDescriptorRow>, nowMs: number): RowScan {
  const descriptors: ModelDescriptor[] = [];
  const defects: CatalogRowDefect[] = [];
  let otherVersion: DomainError | undefined;
  for (const [modelId, stored] of latest) {
    // The two unsellable authorities, both deliberately silent — an
    // operator decision and a derived admission verdict, neither data
    // corruption (BILLING.md §Catalog Admission 4: exposure filters on
    // `excludedReason IS NULL AND adminDisabledAt IS NULL`). Every exposure
    // and turn-time resolution surface derives from this read (`listModels`,
    // `createModelPricingResolver`/`snapshotResolver` snapshots), so the
    // gate holds everywhere at once.
    if (stored.adminDisabledAt !== null || stored.excludedReason !== null) continue;
    // The third unsellable authority, and the only derived-from-absence one:
    // a model the gateway has stopped offering is never marked by a refresh
    // (nothing iterates the ids a fetch did not return), so staleness is the
    // only evidence it is gone. Silent like the two above — a delisting is a
    // catalog lifecycle event, not a defect — and the row is kept, so the
    // model returns by itself when the gateway offers it again.
    if (nowMs - stored.lastSeenAt.getTime() > CATALOG_STALENESS_WINDOW_MS) continue;
    const outcome = rowOutcome(modelId, stored);
    if (outcome.kind === 'otherVersion') otherVersion ??= outcome.error;
    else if (outcome.kind === 'exposed') descriptors.push(outcome.descriptor);
    else if (outcome.defect !== undefined) defects.push({ modelId, defect: outcome.defect });
  }
  return { descriptors, defects, otherVersion };
}

/**
 * The catalog read every exposure and turn-time surface derives from: the
 * persisted descriptor of every exposed model, plus the rows dropped for
 * corruption. A stored descriptor that fails its own contract is skipped — one
 * corrupt row never takes down the whole catalog read, and a hidden model is the
 * safe failure mode.
 *
 * A row written under another descriptor version is never exposed: its rates
 * are not the current billable schedule (a v1 row carries PRE-fee provider
 * rates, a v2 row flat rates), and serving it would price turns on rates the
 * read cannot vouch for. The read serves the current rows beside one, and is
 * refused only when no current row is exposed; that refused read, on the
 * Worker, enqueues the refresh that re-bakes every row the refresh still admits.
 * A read beside current rows enqueues nothing: every refresh, the hourly poll
 * included, rewrites each row it admits at the running version (the version
 * rides in the stored content it compares), so after any completed refresh the
 * rows left at another version are models the gateway no longer offers, which
 * no refresh can rewrite. They stay held back until the staleness window hides
 * them.
 */
export function readExposedCatalog(
  deps: ListDescriptorsDeps,
  // The ambient clock by default: every caller but the list route reads the
  // catalog incidentally and has no clock of its own to thread.
  nowMs: number = Date.now()
): ResultAsync<ExposedCatalogRead, DomainError> {
  return readLatestDescriptorRows(deps.db)
    .andThen((latest) => {
      const { descriptors, defects, otherVersion } = scanRows(latest, nowMs);
      const read = { descriptors, defects };
      if (otherVersion === undefined || descriptors.length > 0) return okAsync(read);
      return requestCatalogRefresh(deps.db).andThen(() => errAsync(otherVersion));
    })
    .andThen((read) =>
      ResultAsync.fromSafePromise<string, DomainError>(
        exposedCatalogGeneration(read.descriptors)
      ).map((generation) => ({ ...read, generation }))
    );
}

/**
 * The exposed descriptors alone, for callers that need only the descriptors. A
 * turn builder reads the catalog through {@link readExposedCatalog} instead,
 * directly or through the pricing resolver built on it, for the generation it
 * stamps on the definition.
 */
export function listDescriptors(
  deps: ListDescriptorsDeps,
  nowMs: number = Date.now()
): ResultAsync<ModelDescriptor[], DomainError> {
  return readExposedCatalog(deps, nowMs).map((read) => read.descriptors);
}
