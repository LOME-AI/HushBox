import { EXCLUDE_REASONS } from '@hushbox/shared';
import { canonicalJson } from '../../../../lib/idempotency/index.js';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import { ResultAsync, err, ok, okAsync } from '../../../../lib/result/index.js';
import { readLatestDescriptorRows, upsertCatalog } from './store.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import { normalizeCatalog } from './normalize.js';
import { auditCatalogHealth } from './list-models.js';
import type { Database } from '@hushbox/db';
import type { ExcludeReason } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { RecordCatalogSighting } from '../../ports/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { GatewayCatalog } from './gateway-metadata.js';
import type { StoredDescriptorRow } from './store.js';
import type { CatalogEntry } from './normalize.js';
import type { Result } from '../../../../lib/result/index.js';

/**
 * The catalog refresh: fetch OpenRouter metadata (models + ZDR + image +
 * video), normalize, upsert one row per model skip-unchanged. Designed for an
 * hourly cron trigger (the caller passes `jitter` so a fleet of triggers
 * spreads out); an internal consumer, so no Idempotency-Key header — every
 * write goes through `idempotent.byUpsert` on UNIQUE(model_id), which also
 * makes concurrent refreshes converge.
 */

export interface RefreshJitter {
  readonly maxMs: number;
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface RefreshCatalogDeps {
  readonly db: Database;
  readonly fetch: typeof globalThis.fetch;
  readonly gatewayBaseUrl: string;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
  /** The soft-delete write: marks, unmarks, and advances `last_seen_at` on rows
   * the descriptor upsert does not rewrite. */
  readonly recordSighting: RecordCatalogSighting;
  readonly jitter?: RefreshJitter;
  /** Image-endpoints N+1 fan-out width. Callers set it from the environment
   * (`createEnvUtilities(env).isProduction ? 6 : 30`) — dev raises it so a cold
   * `catalog:refresh` fills faster; production keeps the 6-connection cap.
   * Omitted → the gateway default (the 6-connection cap). */
  readonly endpointConcurrency?: number;
}

/**
 * How this refresh's exclusions compare with the rows already stored. Measured
 * from the pre-refresh snapshot and the normalized entries, never from the
 * writes, so nothing here can decide what gets written.
 *
 * The comparison is what makes exclusion counts readable at all: the gateway
 * always offers far more models than we sell, so `excluded` is a large steady
 * number every hour and says nothing about health. What a catalog is losing is
 * only visible against what it held.
 */
interface PriorCatalogState {
  /** Stored rows carrying no exclusion mark before this refresh. */
  readonly previouslyIncluded: number;
  /** Models this refresh excludes that were not excluded before it. */
  readonly newlyExcluded: number;
}

export interface RefreshSummary extends PriorCatalogState {
  readonly discovered: number;
  readonly written: number;
  readonly unchanged: number;
  /** Total models excluded, summing {@link RefreshSummary.excludedByReason}. */
  readonly excluded: number;
  /** Per-reason exclusion breakdown; every {@link ExcludeReason} has an entry
   * (zero when none), so a caller can render only the non-zero categories and
   * still trust a `0` for the rest. */
  readonly excludedByReason: Record<ExcludeReason, number>;
  /**
   * Which model this refresh excluded, and why — the counts above say how many.
   * The only place a caller holding one id can learn that the gateway did offer
   * it and this refresh turned it down: an excluded model that was never
   * admissible gets no row (see {@link markExcluded}), so the decision survives
   * nowhere else once the refresh returns.
   */
  readonly excludedReasonById: ReadonlyMap<string, ExcludeReason>;
}

/** The dispositions {@link persistCatalog} counts from its own writes. */
type RefreshCounts = Omit<RefreshSummary, keyof PriorCatalogState>;

/** A fresh per-reason counter with every {@link ExcludeReason} initialized to 0. */
function emptyExcludedByReason(): Record<ExcludeReason, number> {
  const counts = {} as Record<ExcludeReason, number>;
  for (const reason of EXCLUDE_REASONS) counts[reason] = 0;
  return counts;
}

function jitterDelay(jitter: RefreshJitter | undefined): ResultAsync<void, DomainError> {
  if (jitter === undefined) return okAsync();
  const delayMs = Math.floor(jitter.random() * jitter.maxMs);
  return ResultAsync.fromSafePromise(jitter.sleep(delayMs));
}

/** Content equality for skip-unchanged: the stored wire descriptor minus the
 * per-write stamp (`fetchedAt`). `version` is part of the content, so a
 * stored row on an older descriptor version never matches and is rewritten. */
function storedContentMatches(
  stored: StoredDescriptorRow | undefined,
  contentJson: string
): boolean {
  if (stored === undefined) return false;
  if (typeof stored.descriptor !== 'object' || stored.descriptor === null) return false;
  const storedContent = Object.fromEntries(
    Object.entries(stored.descriptor).filter(([key]) => key !== 'fetchedAt')
  );
  return canonicalJson(storedContent) === contentJson;
}

/** Skip the write only when BOTH the descriptor content and the popularity rank
 * are unchanged — rank lives in its own column, not the content hash, so a
 * rank-only change (identical descriptor) still needs a write. */
function shouldSkipWrite(
  stored: StoredDescriptorRow | undefined,
  contentJson: string,
  newRank: number | null
): boolean {
  return storedContentMatches(stored, contentJson) && (stored?.popularityRank ?? null) === newRank;
}

/** A fail-closed exclusion (unclassifiable modality, unknown pricing unit,
 * missing release date, a media row that describes no aspect-ratio domain, a
 * language row whose stated token limit is not a whole positive count) is an
 * EXPECTED catalog-exclusion condition — a model
 * "excluded with an alert" — so it is a structured `warn` on the telemetry
 * port (allowlisted fields, not retained in production), never a Sentry page
 * (founder ruling: the OpenRouter taxonomy legitimately grows shapes we don't
 * price, and paging on each every hour would be noise).
 * Expected-lifecycle / known-shape exclusions — `deprecated`,
 * `token-priced-image`, `token-priced-video`, `megapixel-priced-image`,
 * `missing-pricing` (empty-endpoint preview models), `non-zdr` (only
 * ZDR-reachable models are persisted), `non-conversational` (specialty
 * code-tooling and moderation models), and the commercial reasons
 * `zero-priced` / `below-price-floor` / `too-old` (a model that cannot be sold
 * profitably is an expected outcome, not a defect) — do not even alert; they
 * are only counted. The log messages are compile-time literals (SafeLogFields rule):
 * the model id is a field. */
function alertExcluded(telemetry: Telemetry, modelId: string, reason: ExcludeReason): void {
  if (reason === 'unknown-pricing-unit') {
    telemetry.warn('gateway model has an unknown pricing unit — model excluded', {
      modelName: modelId,
      errorCode: 'model_pricing_unit_unknown',
    });
    return;
  }
  if (reason === 'unclassifiable-modality') {
    telemetry.warn('gateway model modality has no call-shape family — model excluded', {
      modelName: modelId,
      errorCode: 'model_type_unknown',
    });
    return;
  }
  if (reason === 'missing-release-date') {
    telemetry.warn('gateway model has no release date — model excluded', {
      modelName: modelId,
      errorCode: 'model_release_date_missing',
    });
    return;
  }
  if (reason === 'missing-aspect-ratio') {
    telemetry.warn('gateway media model declares no aspect ratio — model excluded', {
      modelName: modelId,
      errorCode: 'model_aspect_ratio_missing',
    });
    return;
  }
  if (reason === 'unrepresentable-token-limit') {
    telemetry.warn('gateway model states a token limit that is not whole — model excluded', {
      modelName: modelId,
      errorCode: 'model_token_limit_unrepresentable',
    });
  }
}

/** A video resolution priced by SUBSTITUTION (no stated rate, the model's max
 * known rate stood in) is an EXPECTED price-fallback — a structured `warn` on
 * the telemetry port (allowlisted fields, not retained in production), never a
 * Sentry page (same founder ruling as {@link alertExcluded}). One line per
 * (model, resolution) so the substituted count is visible: `SafeLogFields` has
 * no resolution field, and inventing one would leak past the allowlist. */
function alertPricingFallbacks(
  telemetry: Telemetry,
  modelId: string,
  resolutions: readonly string[] | undefined
): void {
  const count = resolutions?.length ?? 0;
  for (let index = 0; index < count; index += 1) {
    telemetry.warn('video model resolution priced by fallback — verify pricing', {
      modelName: modelId,
      errorCode: 'model_video_resolution_fallback',
    });
  }
}

/**
 * A gateway list walked short is the same class of event as an excluded row:
 * the refresh proceeds on what it has, and the fact is a structured `warn` on
 * the telemetry port (allowlisted fields, not retained in production), never a
 * Sentry page. Entries past the cut leave no other trace — a truncated
 * language list shortens the catalog and skews the popularity rank it is
 * ordered by, and a truncated ZDR list reads downstream as models the gateway
 * offers no ZDR for, which is the quiet `non-zdr` exclusion rather than a
 * signal. An hourly poller runs this, so a persistent cause repeats hourly.
 *
 * One code per list per reason: an alert fires on a code, and the four lists
 * differ in what their truncation costs.
 */
function alertWalkCutoffs(telemetry: Telemetry, catalog: GatewayCatalog): void {
  if (catalog.modelsWalkCutoff === 'unfollowable-next-link') {
    telemetry.warn('gateway model list ended at a next link it cannot follow — list truncated', {
      errorCode: 'model_catalog_next_link_unfollowable',
    });
  }
  if (catalog.modelsWalkCutoff === 'page-budget-spent') {
    telemetry.warn('gateway model list still had pages at the page budget — list truncated', {
      errorCode: 'model_catalog_page_budget_spent',
    });
  }
  if (catalog.zdrWalkCutoff === 'unfollowable-next-link') {
    telemetry.warn('gateway ZDR list ended at a next link it cannot follow — list truncated', {
      errorCode: 'model_catalog_zdr_next_link_unfollowable',
    });
  }
  if (catalog.zdrWalkCutoff === 'page-budget-spent') {
    telemetry.warn('gateway ZDR list still had pages at the page budget — list truncated', {
      errorCode: 'model_catalog_zdr_page_budget_spent',
    });
  }
  if (catalog.imageModelsWalkCutoff === 'unfollowable-next-link') {
    telemetry.warn(
      'gateway image model list ended at a next link it cannot follow — list truncated',
      { errorCode: 'model_catalog_image_next_link_unfollowable' }
    );
  }
  if (catalog.imageModelsWalkCutoff === 'page-budget-spent') {
    telemetry.warn('gateway image model list still had pages at the page budget — list truncated', {
      errorCode: 'model_catalog_image_page_budget_spent',
    });
  }
  if (catalog.videoModelsWalkCutoff === 'unfollowable-next-link') {
    telemetry.warn(
      'gateway video model list ended at a next link it cannot follow — list truncated',
      { errorCode: 'model_catalog_video_next_link_unfollowable' }
    );
  }
  if (catalog.videoModelsWalkCutoff === 'page-budget-spent') {
    telemetry.warn('gateway video model list still had pages at the page budget — list truncated', {
      errorCode: 'model_catalog_video_page_budget_spent',
    });
  }
}

/**
 * The models the gateway listed but whose per-model detail this refresh could
 * not read, one line each.
 *
 * These are invisible to every other watcher on this path. A model excluded
 * here never reaches the normalizer — it is absent from the fetched catalog
 * altogether — so no {@link ExcludeReason} counter holds it, it is not part of
 * `discovered`, and {@link alertMassExclusion} cannot see it. Its stored row
 * simply stops being re-sighted and ages out through delisting, which is a
 * catalog shrinking in silence: the outcome this alert exists to break.
 *
 * Per model, because the id is the only thing an operator can act on, and a
 * `warn` rather than a Sentry page under the same founder ruling that keeps
 * {@link alertExcluded}'s per-item conditions quiet. Two codes, because the two
 * causes need different hands: an unreachable endpoint document is the
 * gateway's and self-heals, while one that will not parse is ours and never
 * does — it needs the wire schema changed.
 */
function alertUnreadableDetail(telemetry: Telemetry, catalog: GatewayCatalog): void {
  for (const excluded of catalog.excludedModels) {
    if (excluded.reason === 'validation') {
      telemetry.warn('gateway model detail could not be parsed — model excluded', {
        modelName: excluded.id,
        errorCode: 'model_catalog_model_detail_invalid',
      });
      continue;
    }
    telemetry.warn('gateway model detail could not be fetched — model excluded', {
      modelName: excluded.id,
      errorCode: 'model_catalog_model_detail_unavailable',
    });
  }
}

/**
 * The share of the previously included catalog one refresh may newly exclude
 * before the loss is read as a broken gateway response rather than churn.
 *
 * Half, because the alert has to sit above what legitimately moves in one hour
 * and below what the defect does. Above: a single large provider losing ZDR
 * reachability, or a deploy retuning the price floor or the age cutoff, can
 * each retire a large minority of the catalog at once, and none of those is a
 * fault worth waking a human for. Below: a retention list truncated mid-walk
 * with no next link to signal it — the silent case a walk-cutoff alert cannot
 * see — can drop roughly the back half of the list, so a threshold nearer 1
 * would catch only the fully-empty response. Half is also the point at which
 * "most of what we were selling vanished in one refresh" is literally true,
 * which is the statement the human on the other end has to act on.
 */
const MASS_EXCLUSION_SHARE = 0.5;

/**
 * The watcher on {@link RefreshSummary}: a refresh that hides an implausible
 * share of the catalog both warns and pages Sentry. The per-item conditions
 * {@link alertExcluded} reports stay quiet by founder ruling; the aggregate
 * consequence — most or all of what we were selling gone in one refresh — is
 * the one a human has to act on. The refresh itself stays untouched — every
 * write it made has already happened when this runs, and a mass exclusion is
 * reported, never blocked (a catalog mass-exclusion circuit breaker was
 * rejected on design grounds; the summary is the detection).
 *
 * At most one line per refresh, most specific first: an empty retention list
 * explains a total blackout, so the share alert would only restate it. Both
 * name the count of models that were sellable before this refresh and are not
 * after it, which is the number a human needs to size the outage.
 */
export function alertMassExclusion(telemetry: Telemetry, summary: RefreshSummary): void {
  if (summary.discovered > 0 && summary.excludedByReason['non-zdr'] === summary.discovered) {
    telemetry.warn('gateway retention list excluded every discovered model — nothing is sellable', {
      droppedCount: summary.newlyExcluded,
      errorCode: FINGERPRINT_CODES.modelCatalogRetentionListEmpty,
    });
    telemetry.captureError(
      new Error('gateway retention list excluded every discovered model'),
      FINGERPRINT_CODES.modelCatalogRetentionListEmpty
    );
    return;
  }
  if (
    summary.previouslyIncluded > 0 &&
    summary.newlyExcluded >= summary.previouslyIncluded * MASS_EXCLUSION_SHARE
  ) {
    telemetry.warn('catalog refresh newly excluded most of the models it was selling', {
      droppedCount: summary.newlyExcluded,
      errorCode: FINGERPRINT_CODES.modelCatalogMassExclusion,
    });
    telemetry.captureError(
      new Error('catalog refresh newly excluded most of the models it was selling'),
      FINGERPRINT_CODES.modelCatalogMassExclusion
    );
  }
}

type ModelDisposition = 'written' | 'unchanged' | 'excluded';

/**
 * Soft-delete an id the admission rules rejected (BILLING.md §Catalog Admission
 * 4). Marked, never created: a model that was never admissible has no row and no
 * buildable descriptor to write one from, so there is nothing to write. Every
 * reason still reaches the column, because any of them can newly apply to a
 * model that already has a row — which is exactly what this marks.
 */
async function markExcluded(
  deps: RefreshCatalogDeps,
  modelId: string,
  reason: ExcludeReason,
  latest: ReadonlyMap<string, StoredDescriptorRow>
): Promise<Result<void, DomainError>> {
  if (!latest.has(modelId)) return ok();
  const marked = await deps.recordSighting({
    modelId,
    seenAt: deps.now(),
    excludedReason: reason,
  });
  return marked.isErr() ? err(marked.error) : ok();
}

/** Persist one admitted model: rewrite the descriptor, or — when the content and
 * rank are unchanged — only re-sight the row, which advances `last_seen_at` and
 * clears any stale mark so a model can return without a descriptor change. */
async function persistAdmitted(
  deps: RefreshCatalogDeps,
  entry: Extract<CatalogEntry, { kind: 'normalized' }>,
  latest: Map<string, StoredDescriptorRow>,
  newRank: number | null
): Promise<Result<ModelDisposition, DomainError>> {
  const stored = latest.get(entry.modelId);
  if (shouldSkipWrite(stored, canonicalJson(entry.content), newRank)) {
    const seen = await deps.recordSighting({
      modelId: entry.modelId,
      seenAt: deps.now(),
      excludedReason: null,
    });
    return seen.isErr() ? err(seen.error) : ok('unchanged');
  }
  const fetchedAt = deps.now();
  const upsert = await upsertCatalog(deps.db, {
    modelId: entry.modelId,
    content: entry.content,
    fetchedAt,
    popularityRank: newRank,
  });
  if (upsert.isErr()) return err(upsert.error);
  // Belt-and-suspenders: dedupe already makes every id unique here, but keep
  // the in-memory latest coherent so a repeated id compares against the
  // just-written content and rank, never the stale pre-refresh row.
  latest.set(entry.modelId, {
    catalogId: '',
    descriptor: { ...entry.content, fetchedAt: fetchedAt.getTime() },
    // The upsert never touches the kill switch; carry the pre-refresh value.
    adminDisabledAt: stored?.adminDisabledAt ?? null,
    // Writing a descriptor is an admission, so the upsert cleared the mark.
    excludedReason: null,
    popularityRank: newRank,
    lastSeenAt: fetchedAt,
  });
  return ok('written');
}

/** Read off the pre-refresh snapshot before any of this refresh's writes touch
 * it — `persistAdmitted` mutates `latest` as it goes, so the comparison has to
 * be taken while it still describes the previous catalog. */
function priorCatalogState(
  entries: readonly CatalogEntry[],
  latest: ReadonlyMap<string, StoredDescriptorRow>
): PriorCatalogState {
  let previouslyIncluded = 0;
  for (const row of latest.values()) {
    if (row.excludedReason === null) previouslyIncluded += 1;
  }
  let newlyExcluded = 0;
  for (const entry of entries) {
    if (entry.kind === 'excluded' && latest.get(entry.modelId)?.excludedReason === null) {
      newlyExcluded += 1;
    }
  }
  return { previouslyIncluded, newlyExcluded };
}

async function persistCatalog(
  deps: RefreshCatalogDeps,
  entries: readonly CatalogEntry[],
  latest: Map<string, StoredDescriptorRow>,
  rankByModelId: ReadonlyMap<string, number>
): Promise<Result<RefreshCounts, DomainError>> {
  const counts: Record<ModelDisposition, number> = { written: 0, unchanged: 0, excluded: 0 };
  const excludedByReason = emptyExcludedByReason();
  const excludedReasonById = new Map<string, ExcludeReason>();
  for (const entry of entries) {
    if (entry.kind === 'excluded') {
      alertExcluded(deps.telemetry, entry.modelId, entry.reason);
      counts.excluded += 1;
      excludedByReason[entry.reason] += 1;
      excludedReasonById.set(entry.modelId, entry.reason);
      const marked = await markExcluded(deps, entry.modelId, entry.reason, latest);
      if (marked.isErr()) return err(marked.error);
      continue;
    }
    alertPricingFallbacks(deps.telemetry, entry.modelId, entry.pricingFallbacks);
    const persisted = await persistAdmitted(
      deps,
      entry,
      latest,
      rankByModelId.get(entry.modelId) ?? null
    );
    if (persisted.isErr()) return err(persisted.error);
    counts[persisted.value] += 1;
  }
  return ok({ discovered: entries.length, ...counts, excludedByReason, excludedReasonById });
}

export function refreshCatalog(deps: RefreshCatalogDeps): ResultAsync<RefreshSummary, DomainError> {
  return jitterDelay(deps.jitter)
    .andThen(() =>
      fetchGatewayCatalog({
        baseUrl: deps.gatewayBaseUrl,
        fetch: deps.fetch,
        ...(deps.endpointConcurrency === undefined
          ? {}
          : { endpointConcurrency: deps.endpointConcurrency }),
      })
    )
    .andThen((catalog) => {
      alertWalkCutoffs(deps.telemetry, catalog);
      alertUnreadableDetail(deps.telemetry, catalog);
      const entries = normalizeCatalog(catalog.models, catalog.zdrModelIds, deps.now().getTime());
      // Rank is carried only on language models (the sorted `/models` set) and
      // rides the column, not the descriptor — collect it here for persistence.
      const rankByModelId = new Map<string, number>();
      for (const model of catalog.models) {
        if (model.source === 'language' && model.popularityRank !== undefined) {
          rankByModelId.set(model.id, model.popularityRank);
        }
      }
      return readLatestDescriptorRows(deps.db).andThen((latest) => {
        const prior = priorCatalogState(entries, latest);
        return new ResultAsync(persistCatalog(deps, entries, latest, rankByModelId)).map(
          async (counts) => {
            // The catalog it just wrote is the only thing that can have changed
            // a row's health, so this is where a corrupt row is reported —
            // reporting on the read instead emitted the same error once per
            // visitor. Best-effort telemetry about the refresh, never part of it.
            await auditCatalogHealth(deps, deps.now().getTime());
            return { ...counts, ...prior };
          }
        );
      });
    });
}
