// Sanctioned in-process seed surface consumed by `scripts/seed.ts`.
//
// The unified seed script composes the new backend's REAL data factories in
// process (pure dependency-injected functions — no Hono/Worker bindings). This
// barrel is the single package subpath (`@hushbox/api/dev-seed`) through which
// `@hushbox/scripts` reaches those factories, so seeding never deep-reaches into
// `apps/api` internals. It re-exports only the DI-shaped seed functions and
// their param/result types — from `factories.ts`, `wallet.ts`, `seed-user.ts`,
// and, for everything that writes a slice-owned table, that slice's published
// barrel (persona minting + rich billing-history producers); the Hono
// `routes.ts` dev surface is deliberately excluded.
//
// It also exposes the collaborators `scripts/seed.ts` needs to assemble
// `MintSeedUserDeps` / `SeedBillingDeps` without deep-reaching into slice
// internals or depending on `neverthrow`: the identity/billing store factories,
// and `createNoopSeedEmailPorts()` — a best-effort no-op email-port pair the
// script would otherwise have to build from `neverthrow` types it doesn't have.
//
// One TYPE from the dev route surface crosses here as well: `MockChargeBasis`,
// the payload of `GET /dev/mock-charge-basis`. It is declared once and imported
// by both the route that serves it and the E2E derivation that consumes it, so
// the wire shape has a single statement rather than two that must agree.

import { okAsync } from '../lib/result/index.js';
import type { WelcomeEmailPort } from '../slices/billing/index.js';
import type { VerificationEmailPort } from '../slices/identity/index.js';

export { createIdentityStores } from '../slices/identity/index.js';
export { createBillingStores } from '../slices/billing/index.js';

// The real, live catalog refresh, exposed to `scripts/refresh-catalog.ts` so
// dev startup and `e2e:prepare` populate `model_catalog` from OpenRouter's
// public metadata endpoints with the exact same job the hourly cron runs — no
// hand-authored descriptors. `OPENROUTER_BASE_URL` single-sources the gateway
// base URL; `createConsoleTelemetry` gives the script the Telemetry the refresh
// needs to alert on excluded models.
export {
  createCatalogSightingRecorder,
  refreshCatalog,
  OPENROUTER_BASE_URL,
} from '../slices/models/index.js';
export type { RefreshSummary } from '../slices/models/index.js';

// The catalog read every product surface derives from, and the gate that decides
// whether a payer below the paid tier may select a model — both exposed so the
// E2E catalog guard grades a declared model with the product's own verdict over
// the product's own pool instead of assembling a second one that can drift.
export { listDescriptors, trialEligibility } from '../slices/models/index.js';

// Single-writer catalog upsert, exposed so `scripts/seed.ts` injects ONE
// synthetic strict-image descriptor into `model_catalog` through the models
// slice's published API (never a raw insert from scripts) after the live
// `catalog:refresh`. It gives the E2E image fan-out a genuine second exposed
// strict-image id (see `scripts/lib/playwright/seeded-image-model.ts`).
export { DESCRIPTOR_VERSION, upsertCatalog } from '../slices/models/index.js';
export type { UpsertCatalogParams } from '../slices/models/index.js';
export { createConsoleTelemetry } from '../lib/telemetry/index.js';

/**
 * The best-effort email ports `mintSeedUser`/`completeRegistration` expect,
 * exposed so `scripts/seed.ts` builds them without touching `neverthrow`.
 */
interface SeedEmailPorts {
  readonly welcomeEmail: WelcomeEmailPort;
  readonly verificationEmail: VerificationEmailPort;
}

/**
 * No-op email ports for seeding — registration fires them outside the tx and
 * dev seeding never sends real mail. Mirrors the port construction in
 * `seed-user.integration.test.ts` (methods returning a success `ResultAsync`).
 */
export function createNoopSeedEmailPorts(): SeedEmailPorts {
  return {
    welcomeEmail: { sendWelcomeEmail: () => okAsync() },
    verificationEmail: { sendVerificationEmail: () => okAsync() },
  };
}

// The bound the seed's own tail enforces against the end-to-end stack's Redis
// database. It is declared beside the per-test reset whose cost it protects and
// reaches the seed through this door, so the seed never spells a second copy of
// a number the reset's own design fixes.
export { E2E_KEYSPACE_CEILING } from './e2e-keyspace-ceiling.js';

export { createDevConversation, createDevGroupChat } from './factories.js';

export { setWalletBalance } from './wallet.js';
export type { SetWalletBalanceResult } from './wallet.js';
export type { MockChargeBasis } from './mock-charge-basis.js';

export { seedAdminOpTargets } from './seed-admin-targets.js';

export { mintSeedUser } from './seed-user.js';
export type { SeedCryptoProvider, SeedUserPersona, MintSeedUserDeps } from './seed-user.js';
export { setEmailVerified } from '../slices/identity/index.js';

// The account-side half of the growth dashboard's seed. The acquisition row
// itself rides `mintSeedUser`'s persona and is written by the registration
// settlement; these two are what registration cannot express — the creation
// instant a cohort is dated to, which is a column default registration never
// supplies, and the channel answer, which is a separate act the account holder
// performs later and which this reaches through the same verb their prompt does.
export { applySelfReport, setAccountCreatedAt } from '../slices/identity/index.js';
export type { AcquisitionStamp } from '../slices/identity/index.js';

// Public /stats seeding: the anonymous usage-record producer, plus the SAME
// snapshot entry the daily cron runs (and its store/meta-resolver
// collaborators), so `scripts/seed.ts` materializes the snapshot through the
// real path — never hand-crafted snapshot jsonb.
export { seedPublicUsageRecords } from '../slices/billing/index.js';

export {
  createCatalogModelMetaResolver,
  createPublicStatsSnapshotEntry,
} from '../slices/billing/index.js';

export { createPublicStatsStores } from '../slices/billing/index.js';

export { seedPaymentsHistory, seedUsageHistory, usdToNanoUsd } from '../slices/billing/index.js';

// Growth dashboard seeding: the slice's own door, which counts through the real
// beacon and registration-start writers and then runs the real rollup, so the
// screen an operator would notice a broken rollup on is fed by that rollup.
export { seedGrowthCounts } from '../slices/growth/index.js';
export type {
  GrowthSeedCampaign,
  GrowthSeedEvent,
  GrowthSeedHour,
  GrowthSeedOutcome,
  GrowthSeedPlan,
  GrowthSeedStart,
  GrowthSeedView,
  GrowthSeedVisitor,
} from '../slices/growth/index.js';
