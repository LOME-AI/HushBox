/**
 * `pnpm catalog:refresh` — populate `model_catalog` from OpenRouter's live,
 * public metadata endpoints.
 *
 * This runs the SAME real `refreshCatalog` job the hourly production cron runs
 * (a live `globalThis.fetch` against OpenRouter's unauthenticated `/models`,
 * `/endpoints/zdr`, `/images/models`, `/videos/models`) — there are no pinned
 * or hand-authored descriptors. The cron does not fire under the local Worker
 * runtime, so local dev and E2E would otherwise start with an empty catalog;
 * this script is the dedicated dev-startup / `e2e:prepare` step that fills it
 * with real data.
 *
 * Fail-loud by design: an unreachable endpoint or a failed refresh exits
 * non-zero. With `--require-e2e-models`, it additionally runs
 * {@link assertE2eModelsPresent} over the freshly-refreshed catalog, holding
 * every live-catalog id the suite declares to what its own declaration promises,
 * and the catalog as a whole to obligations no declaration carries, such as
 * leaving a free-tier payer a model to send on (E2E passes the flag; plain
 * `pnpm dev` / `pnpm catalog:refresh` does not, so local dev just gets a live
 * catalog without the E2E-specific gate). The suite's synthetic ids are outside
 * this gate by construction: no live catalog carries them, and the seed writes
 * and checks them after this runs.
 */
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { EXCLUDE_REASONS } from '@hushbox/shared';
import {
  OPENROUTER_BASE_URL,
  createCatalogSightingRecorder,
  createConsoleTelemetry,
  refreshCatalog,
} from '@hushbox/api/dev-seed';
import { assertE2eModelsPresent } from './lib/playwright/models.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { assertLocalDatabaseUrl } from './lib/seed/preconditions.js';
import type { RefreshSummary } from '@hushbox/api/dev-seed';

/**
 * The one-line refresh summary, with a per-category exclusion breakdown so a
 * spike in `unknown-pricing-unit` (the real drift signal) is visible at a
 * glance. Only non-zero categories are listed, in {@link EXCLUDE_REASONS}
 * order:
 *   `388 discovered, 357 written, 0 unchanged, 31 excluded (14 token-priced-image, …)`
 */
export function formatRefreshSummary(summary: RefreshSummary): string {
  const breakdown = EXCLUDE_REASONS.filter((reason) => summary.excludedByReason[reason] > 0)
    .map((reason) => `${summary.excludedByReason[reason].toString()} ${reason}`)
    .join(', ');
  const excluded =
    breakdown.length > 0
      ? `${summary.excluded.toString()} excluded (${breakdown})`
      : `${summary.excluded.toString()} excluded`;
  return (
    `catalog:refresh: ${summary.discovered.toString()} discovered, ` +
    `${summary.written.toString()} written, ${summary.unchanged.toString()} unchanged, ` +
    `${excluded}.`
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`catalog:refresh: ${name} is required (run pnpm generate:env)`);
  }
  return value;
}

export async function runRefreshCatalog(requireE2eModels: boolean): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  assertLocalDatabaseUrl(databaseUrl);
  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  try {
    const result = await refreshCatalog({
      db,
      fetch: globalThis.fetch.bind(globalThis),
      gatewayBaseUrl: OPENROUTER_BASE_URL,
      telemetry: createConsoleTelemetry(),
      now: () => new Date(),
      recordSighting: createCatalogSightingRecorder(db),
      // Fan the image-endpoints N+1 out wider than production's 6-connection
      // cap so a cold refresh fills faster. Safe as a constant because the
      // local-target assertion above rejects every non-loopback database host,
      // so this script never runs against production in the first place.
      endpointConcurrency: 30,
    });
    if (result.isErr()) {
      throw new Error(`catalog:refresh: refresh failed — ${result.error.message}`);
    }
    console.log(formatRefreshSummary(result.value));
    if (requireE2eModels) {
      await assertE2eModelsPresent(db, result.value.excludedReasonById);
      // Pitched at the declarations rather than at the guard's checks, so a leg
      // added there does not falsify this sentence.
      console.log(
        'catalog:refresh: every live-catalog model id the E2E suite declares is backed ' +
          'by the catalog in the shape its declaration requires.'
      );
    }
  } finally {
    await db.$client.end();
  }
}

export const COMMAND_LINE = {
  command: 'pnpm catalog:refresh',
  summary: "Refreshes the model catalog from the provider's live metadata.",
  flags: [
    {
      flag: '--require-e2e-models',
      kind: 'boolean',
      summary: 'Fail unless every model the E2E suite names survived the refresh.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI wiring; the guard + refresh are tested/proven elsewhere */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (parsed === null) return;
    await runRefreshCatalog(parsed.flags['--require-e2e-models']);
  });
}
/* v8 ignore stop */
