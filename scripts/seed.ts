/**
 * `pnpm db:seed` — the unified seed orchestrator.
 *
 * The composition root: it builds the real infra clients (Neon via the dev
 * driver, Upstash Redis), resolves the runtime OPAQUE KEK and TOTP encryption
 * secret, warms the fingerprint-keyed OPAQUE crypto cache, and drives the
 * audited in-process producers from `@hushbox/api/dev-seed`.
 *
 * It also re-exports the persona roster + derivations the E2E/mobile harnesses
 * import from `scripts/seed.js`, so the whole seed surface has one entry point.
 *
 * There is exactly ONE seed path (matching the legacy seed): every run seeds
 * everything, idempotently — every `TEST_PERSONAS` row + the mobile persona
 * (with correct verified flags and 2FA enrollment), the dev personas with
 * alice's rich billing history, the screenshot conversations, charlie's
 * conversation, the admin op-target states, authoritative wallet balances
 * for every persona, and the anonymous public-/stats usage spread with its
 * snapshot (written through the real cron entry). No flags, no profiles, no
 * branching.
 *
 * Model catalog: `model_catalog` is populated out-of-band by `catalog:refresh`
 * (the real, live OpenRouter refresh — the same job the hourly cron runs),
 * which the pipeline runs BEFORE `db:seed` (see `e2e:prepare` / `pnpm dev`).
 * Seeding therefore assumes the catalog is already populated: the dev
 * group-chat factory (`pickSeedTextModels`) and the app's model picker read
 * those exposed descriptors. There are no pinned, hand-authored descriptors —
 * the catalog is always real/live.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { deriveOpaqueKek } from '@hushbox/crypto';
import { LOCAL_NEON_DEV_CONFIG, createDb, wallets, type Database } from '@hushbox/db';
import { DEV_PASSWORD, createEnvUtilities, mapWithConcurrency } from '@hushbox/shared';
import {
  E2E_KEYSPACE_CEILING,
  applySelfReport,
  createBillingStores,
  createCatalogModelMetaResolver,
  createConsoleTelemetry,
  createDevConversation,
  createIdentityStores,
  createNoopSeedEmailPorts,
  createPublicStatsSnapshotEntry,
  createPublicStatsStores,
  mintSeedUser,
  seedAdminOpTargets,
  seedPaymentsHistory,
  seedGrowthCounts,
  seedPublicUsageRecords,
  seedUsageHistory,
  setAccountCreatedAt,
  setEmailVerified,
  setWalletBalance,
  upsertCatalog,
} from '@hushbox/api/dev-seed';
import { ALICE_PAYMENT_SPECS, ALICE_USAGE_SPECS, PUBLIC_USAGE_SPECS } from './lib/seed/fixtures.js';
import {
  GROWTH_COHORT_DAYS,
  buildGrowthCohortPlan,
  growthCohortFigures,
} from './lib/seed/cohorts.js';
import {
  E2E_GROWTH_SEED_DAYS,
  GROWTH_SEED_DAYS,
  buildGrowthSeedPlan,
  growthSeedFigures,
} from './lib/seed/growth.js';
import {
  DEV_PERSONAS,
  MOBILE_TEST_PERSONA,
  TEST_PERSONAS,
  devEmail,
  nanoUsdToDecimalString,
  seedUUID,
  testEmail,
} from './lib/seed/personas.js';
import {
  CHARLIE_CONV_MESSAGES,
  SEED_MODEL_ID,
  personasWithSampleData,
  seedBulkSampleConversations,
  seedDocumentShowcases,
  seedScreenshotConversations,
} from './lib/seed/conversations.js';
import {
  assertLocalDatabaseUrl,
  assertNoSeedArgs,
  createSeedRedis,
  requireEnv,
  resolveSeedSecret,
} from './lib/seed/preconditions.js';
import {
  assertSeededImageModelPresent,
  assertSeededVideoModelsPresent,
} from './lib/playwright/models.js';
import { seededImageModelUpsert } from './lib/playwright/seeded-image-model.js';
import { seededVideoModelUpserts } from './lib/playwright/seeded-video-model.js';
import { CACHE_VERSION, computeCryptoFingerprint } from './lib/seed/crypto-cache.js';
import { ensurePersonaCrypto } from './lib/seed/crypto-pool.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import type { GrowthCohortAccount } from './lib/seed/cohorts.js';
import type { Redis } from '@upstash/redis';
import type { DevPersona, SeededTestPersona } from './lib/seed/personas.js';
import type { SeedSecrets } from './lib/seed/preconditions.js';
import type { MintSeedUserDeps, SeedCryptoProvider, SeedUserPersona } from '@hushbox/api/dev-seed';

// Re-export the persona roster + derivations for the harnesses that import them
// from `scripts/seed.js` (e2e/auth.setup, e2e/helpers/personas, auth-2fa spec,
// mobile flows). Kept as local re-exports so the single import above is their
// one source.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CACHE_FILE = path.join(REPO_ROOT, 'scripts', '.cache', 'seed-crypto.json');
const CRYPTO_SRC_DIR = path.join(REPO_ROOT, 'packages', 'crypto', 'src');

/**
 * Dedicated admin-plane op-target persona for the dev profile: minted like
 * any dev persona, then placed in the states the admin ops act on —
 * chargeback-locked (`user.unlock`) with a negative purchased balance
 * (`wallet.credit`). Kept out of `DEV_PERSONAS` so demo flows never log in
 * as a locked user.
 */
export const ADMIN_TARGET_PERSONA: DevPersona = {
  name: 'mallory',
  displayName: 'Mallory Quinn',
  emailVerified: true,
  hasSampleData: false,
  sampleConversationCount: 3,
  balanceNanoUsd: -2_500_000_000n,
};

/**
 * How many personas, sample conversations or cohort accounts the seed works on
 * at once, and so how many connections its pool opens. Measured from an empty
 * database: the persona loop's wall time meets its main-thread CPU time here,
 * the bulk-conversation loop is already flat from half of it, and doubling it
 * gains little for twice the connections. Re-measure to change it.
 */
export const SEED_CONCURRENCY = 16;

const utf8 = new TextEncoder();

function daysAgoDate(now: Date, daysAgo: number, hour = 0, minute = 0): Date {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function toTestSeedPersona(persona: SeededTestPersona): SeedUserPersona {
  const email = testEmail(persona.name);
  return {
    userId: seedUUID(email),
    email,
    username: persona.username,
    password: DEV_PASSWORD,
    emailVerified: persona.emailVerified,
    ...(persona.totpSecret === null ? {} : { totpSecret: persona.totpSecret }),
  };
}

function toDevSeedPersona(persona: DevPersona): SeedUserPersona {
  const email = devEmail(persona.name);
  return {
    userId: seedUUID(email),
    email,
    // `mintSeedUser` normalizes the username; the dev roster carries a display
    // name, mirroring the legacy seed's `normalizeUsername(displayName)`.
    username: persona.displayName,
    password: DEV_PASSWORD,
    emailVerified: persona.emailVerified,
  };
}

function devPersonaByName(name: string): DevPersona {
  const persona = DEV_PERSONAS.find((candidate) => candidate.name === name);
  /* v8 ignore next -- defensive: only ever called with a name known to be in DEV_PERSONAS */
  if (persona === undefined) throw new Error(`seed: dev persona "${name}" is not defined`);
  return persona;
}

function baseMintDeps(
  db: Database,
  secrets: SeedSecrets,
  personaCrypto: SeedCryptoProvider
): MintSeedUserDeps {
  return {
    db,
    stores: createIdentityStores(db),
    billingStores: createBillingStores(),
    opaqueKek: deriveOpaqueKek(utf8.encode(secrets.opaqueKekSecret)),
    totpEncryptionSecret: utf8.encode(secrets.totpEncryptionSecret),
    personaCrypto,
    ...createNoopSeedEmailPorts(),
  };
}

/**
 * Warms the parallel, fingerprint-keyed OPAQUE cache for a persona set and
 * returns the provider `mintSeedUser` calls. The provider is keyed by
 * `credentialIdentifier`, which is the persona's deterministic `userId`.
 */
async function warmPersonaCrypto(
  opaqueKekSecret: string,
  personas: readonly SeedUserPersona[]
): Promise<SeedCryptoProvider> {
  const requests = personas.map((persona) => ({
    credentialIdentifier: persona.userId,
    password: persona.password,
  }));
  const cryptoFingerprint = await computeCryptoFingerprint(CRYPTO_SRC_DIR);
  const cryptoByCredentialId = await ensurePersonaCrypto(requests, {
    cacheFile: CACHE_FILE,
    cacheVersion: CACHE_VERSION,
    cryptoFingerprint,
    opaqueKekSecret,
  });
  return ({ credentialIdentifier }) => {
    const bytes = cryptoByCredentialId.get(credentialIdentifier);
    if (bytes === undefined) {
      throw new Error(`seed: no cached crypto for "${credentialIdentifier}"`);
    }
    return Promise.resolve(bytes);
  };
}

async function mintAll(
  deps: MintSeedUserDeps,
  personas: readonly SeedUserPersona[]
): Promise<{ processed: number; created: number }> {
  const results = await mapWithConcurrency(personas, SEED_CONCURRENCY, (persona) =>
    mintSeedUser(deps, persona)
  );
  return { processed: personas.length, created: results.filter((result) => result.created).length };
}

async function purchasedWalletId(db: Database, userId: string): Promise<string> {
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.type, 'purchased')));
  if (row === undefined) throw new Error(`seed: purchased wallet not found for user ${userId}`);
  return row.id;
}

/**
 * Alice's rich billing history — 14 backdated payments and 200 backdated usage
 * records — attributed to her first seeded conversation. Runs before the
 * authoritative balance set so the final displayed balance is clean.
 */
async function seedAliceBillingHistory(
  db: Database,
  aliceUserId: string,
  conversationId: string,
  now: Date
): Promise<void> {
  const walletId = await purchasedWalletId(db, aliceUserId);
  await seedPaymentsHistory(
    { db },
    {
      userId: aliceUserId,
      purchasedWalletId: walletId,
      payments: ALICE_PAYMENT_SPECS.map((spec, index) => ({
        stableKey: `alice-payment-${index.toString()}`,
        amountNanoUsd: spec.amountNanoUsd,
        cardType: spec.cardType,
        cardLastFour: spec.cardLastFour,
        helcimTransactionId: `hlcm-alice-${(index + 1).toString()}`,
        createdAt: daysAgoDate(now, spec.daysAgo),
      })),
    }
  );
  await seedUsageHistory(
    { db },
    {
      userId: aliceUserId,
      walletId,
      conversationId,
      records: ALICE_USAGE_SPECS.map((spec) => ({
        stableKey: `alice-usage-${spec.index.toString()}`,
        modelId: spec.model,
        providerName: spec.provider,
        modality: 'text' as const,
        billableCostNanoUsd: spec.costNanoUsd,
        tokens: {
          inputTokens: spec.inputTokens,
          outputTokens: spec.outputTokens,
          cachedInputTokens: spec.cachedTokens,
        },
        createdAt: daysAgoDate(now, spec.daysAgo, spec.hour, spec.minute),
      })),
    }
  );
}

/** Mints the E2E roster (all Playwright-project variants + mobile) with authoritative balances. */
async function seedTestPersonas(db: Database, redis: Redis, secrets: SeedSecrets): Promise<void> {
  const testPersonas: SeededTestPersona[] = [...TEST_PERSONAS, MOBILE_TEST_PERSONA];
  const personas = testPersonas.map((persona) => toTestSeedPersona(persona));
  const personaCrypto = await warmPersonaCrypto(secrets.opaqueKekSecret, personas);
  const deps = baseMintDeps(db, secrets, personaCrypto);

  // Authoritative persona state, set after each persona's own mint (same
  // mechanism as the dev roster): whatever an earlier run's specs did to these
  // rows, the persona record wins. Each persona is one chain; nothing a chain
  // writes is read by another persona's.
  //
  // Balances override the mint's $0.20 welcome credit so a live AI send — the
  // composer defaults to Smart Model, whose admission hold exceeds the welcome
  // credit — doesn't 402. A `0n` balance (test-bob) is set explicitly to zero
  // the welcome credit; the group-billing suite requires him broke.
  //
  // `emailVerified` is re-asserted for the same reason: the mint is
  // skip-if-exists and applies it only when it creates the row, so a spec that
  // verifies an unverified persona would otherwise leave it verified forever.
  const results = await mapWithConcurrency(
    testPersonas,
    SEED_CONCURRENCY,
    async (persona, index) => {
      const seedPersona = personas[index];
      /* v8 ignore next 2 -- the two arrays are built from one roster in one pass, so every index is present */
      if (seedPersona === undefined) throw new Error('seed: a test persona has no seed persona');
      const result = await mintSeedUser(deps, seedPersona);
      await setWalletBalance(db, redis, {
        email: testEmail(persona.name),
        walletType: 'purchased',
        balance: nanoUsdToDecimalString(persona.balanceNanoUsd),
      });
      await setEmailVerified(db, {
        email: testEmail(persona.name),
        verified: persona.emailVerified,
      });
      return result;
    }
  );
  const processed = results.length;
  const created = results.filter((result) => result.created).length;
  console.log(
    `seed[test personas]: ${processed.toString()} personas processed, ${created.toString()} newly created; ${testPersonas.length.toString()} wallet balances set.`
  );
}

/**
 * Mints the dev roster (+ mallory) and seeds its data: bulk per-persona sample
 * conversations (hasSampleData personas), screenshot conversations, charlie's
 * conversation, alice's billing history, admin op-target states, and
 * authoritative balances.
 */
async function seedDevData(db: Database, redis: Redis, secrets: SeedSecrets): Promise<void> {
  const now = new Date();
  const devRoster = [...DEV_PERSONAS, ADMIN_TARGET_PERSONA];
  const personas = devRoster.map((persona) => toDevSeedPersona(persona));
  const personaCrypto = await warmPersonaCrypto(secrets.opaqueKekSecret, personas);
  const deps = baseMintDeps(db, secrets, personaCrypto);
  const { processed, created } = await mintAll(deps, personas);

  const sampleConversations = await seedBulkSampleConversations(
    db,
    personasWithSampleData(devRoster),
    SEED_CONCURRENCY
  );

  const conversationIds = await seedScreenshotConversations(db);
  await createDevConversation(db, {
    ownerEmail: devEmail('charlie'),
    seedAiModel: SEED_MODEL_ID,
    id: seedUUID('charlie-conv-1'),
    // Legacy per-persona sample-conversation title: `${personaName} Conversation ${n}`.
    title: 'charlie Conversation 1',
    messages: [...CHARLIE_CONV_MESSAGES],
  });

  // Mallory is deliberately excluded (she is locked, so demo flows never log in
  // as her); the showcase is for the personas a developer actually uses.
  const showcaseConversations = await seedDocumentShowcases(db, DEV_PERSONAS);

  const alice = devPersonaByName('alice');
  const aliceConversationId = conversationIds[0];
  /* v8 ignore next 3 -- defensive: SCREENSHOT_CONVERSATIONS is a non-empty constant, so index 0 is always present */
  if (aliceConversationId === undefined) {
    throw new Error('seed: no screenshot conversation available for alice usage history');
  }
  await seedAliceBillingHistory(db, seedUUID(devEmail(alice.name)), aliceConversationId, now);

  // Admin-plane op-target states (verified by query inside the seeder):
  // chargeback-locked mallory, a dead job, a discarded job, and a revoked
  // share on charlie's conversation; mallory's negative balance lands in the
  // authoritative-balance loop below.
  await seedAdminOpTargets(db, {
    lockedUserEmail: devEmail(ADMIN_TARGET_PERSONA.name),
    conversationId: seedUUID('charlie-conv-1'),
  });

  // Authoritative final balances, set last so the payment/usage history does not
  // drift the displayed balance.
  for (const persona of devRoster) {
    await setWalletBalance(db, redis, {
      email: devEmail(persona.name),
      walletType: 'purchased',
      balance: nanoUsdToDecimalString(persona.balanceNanoUsd),
    });
  }
  console.log(
    `seed[dev]: ${processed.toString()} personas processed, ${created.toString()} newly created; ${sampleConversations.toString()} bulk sample + ${conversationIds.length.toString()} screenshot + 1 charlie + ${showcaseConversations.toString()} document showcase conversations; alice billing history; admin op-target states.`
  );
}

/**
 * Anonymous public-/stats data: backdated user-less `usage_records` from the
 * deterministic fixture spread, then a snapshot produced through the REAL
 * path — the same `public-stats-snapshot` cron entry the Worker runs daily,
 * composed from the real billing stores and the live-catalog meta resolver
 * (never hand-crafted snapshot jsonb). Image records carry the
 * deterministic-estimate flag, matching production image-charge semantics.
 */
async function seedPublicStats(db: Database): Promise<void> {
  const now = new Date();
  const { usageRecordsCreated } = await seedPublicUsageRecords(
    { db },
    {
      records: PUBLIC_USAGE_SPECS.map((spec) => ({
        stableKey: `public-usage-${spec.index.toString()}`,
        modelId: spec.model,
        providerName: spec.provider,
        modality: spec.modality,
        costNanoUsd: spec.costNanoUsd,
        isEstimated: spec.modality === 'image',
        createdAt: daysAgoDate(now, spec.daysAgo, spec.hour, spec.minute),
      })),
    }
  );
  const entry = createPublicStatsSnapshotEntry({
    db,
    stores: createPublicStatsStores(),
    now: () => new Date(),
    resolveModelMeta: createCatalogModelMetaResolver({ db, telemetry: createConsoleTelemetry() }),
  });
  await entry.run();
  console.log(
    `seed[public stats]: ${usageRecordsCreated.toString()} usage records created; snapshot written via the ${entry.name} cron entry.`
  );
}

/**
 * The growth dashboard, seeded through the REAL counting path: every member is
 * written by the same beacon and registration-start writers the running system
 * writes through, and every hour is then reduced by the same rollup the cron
 * runs. Nothing here writes a growth table — they are rollup output, and
 * hand-populating one would make a broken rollup look exactly like a working
 * one on the screen an operator would notice it from.
 */
async function seedGrowth(db: Database, redis: Redis): Promise<void> {
  // The window is the stack's, not the seed's: the history exists so a human
  // opening the dashboard under `pnpm dev` sees populated charts, and the
  // end-to-end stack has no such reader while it does pay for every key once
  // per test through the rate-limit reset.
  const { isE2E } = createEnvUtilities(process.env);
  const plan = buildGrowthSeedPlan(new Date(), isE2E ? E2E_GROWTH_SEED_DAYS : GROWTH_SEED_DAYS);
  const figures = growthSeedFigures(plan);
  const outcome = await seedGrowthCounts({ db, redis }, plan);
  console.log(
    `seed[growth]: ${outcome.beaconsCounted.toString()} beacons and ${outcome.startsCounted.toString()} registration starts counted for ${figures.totalVisitors.toString()} visitors over ${figures.days.toString()} days; ${outcome.hoursRolled.toString()} hours rolled through the real rollup; ${outcome.campaignsMinted.toString()} campaigns minted.`
  );
  if (outcome.overflowLatched.length > 0) {
    console.warn(
      `seed[growth]: ${outcome.overflowLatched.length.toString()} set(s) hit a ceiling, so those figures are floors rather than counts.`
    );
  }
  // The only warning the mint gate gives before it starts refusing beacons: a
  // full budget is one visitor short of a refusal, and the door throws on a
  // refusal, so an operator who never sees this line learns nothing until the
  // seed fails outright.
  if (outcome.addressBudgetsFilled > 0) {
    console.warn(
      `seed[growth]: ${outcome.addressBudgetsFilled.toString()} address(es) gave up their whole daily identity budget, so the plan is one visitor away from beacons being refused; spread it over more addresses.`
    );
  }
  // A stored landing count standing above what this run just counted cannot
  // have come from the plan: it says the counting store lost members the rows
  // outlived. The scheduled rollup reports the same condition to an operator
  // through the Telemetry port; the seed has only this line, and without it a
  // run that silently lowered a row tells whoever ran it nothing.
  if (outcome.landingsClamped.length > 0) {
    console.warn(
      `seed[growth]: lowered the landing count of ${outcome.landingsClamped.length.toString()} row(s) to the visitors this run read, so the counting store has lost members those rows outlived: ${outcome.landingsClamped.join(', ')}.`
    );
  }
  // A Worker started before this run holds the active-campaign list for that
  // key's own lifetime, so a real visit naming a freshly minted seed tag folds
  // to the unknown sentinel until it expires. Cosmetic, and only in that window.
  console.log(
    'seed[growth]: a Worker started before this run may fold a visit naming a fresh seed tag to `unknown` until its campaign cache expires.'
  );
}

/**
 * One cohort account as the mint takes it. The acquisition stamp rides the
 * persona, so the row is written by the registration settlement rather than
 * inserted beside the account it belongs to.
 */
function toCohortSeedPersona(account: GrowthCohortAccount): SeedUserPersona {
  return {
    userId: seedUUID(account.email),
    email: account.email,
    username: account.username,
    password: DEV_PASSWORD,
    emailVerified: account.emailVerified,
    acquisition: { campaign: account.campaign, platform: account.platform },
  };
}

/**
 * The channel answer, recorded through the same verb the account holder's own
 * prompt sends — first-answer-wins at the row, so a re-run finds the answer
 * already standing and changes nothing.
 */
async function answerChannelPrompt(
  db: Database,
  stores: ReturnType<typeof createIdentityStores>,
  account: GrowthCohortAccount,
  userId: string
): Promise<void> {
  const channel = account.selfReportedChannel;
  if (channel === null) return;
  const applied = await applySelfReport(
    { store: stores.users, db, userId },
    { action: 'answer', channel, context: account.selfReportedContext },
    account.createdAt
  );
  if (applied.isErr()) {
    throw new Error(`seed: the channel answer for ${account.email} failed — ${applied.error.code}`);
  }
}

/** One paying account's first card payment, backdated through billing's own producer. */
async function payForCohortAccount(
  db: Database,
  account: GrowthCohortAccount,
  userId: string
): Promise<void> {
  const payment = account.payment;
  if (payment === null) return;
  await seedPaymentsHistory(
    { db },
    {
      userId,
      purchasedWalletId: await purchasedWalletId(db, userId),
      payments: [
        {
          stableKey: `cohort-payment-${account.email}`,
          amountNanoUsd: payment.amountNanoUsd,
          cardType: 'visa',
          cardLastFour: '4242',
          helcimTransactionId: `hlcm-${account.username}`,
          createdAt: payment.at,
        },
      ],
    }
  );
}

/**
 * The title every cohort account's own conversation carries, so a reader of the
 * seeded data can tell these apart from the curated demo conversations.
 */
const COHORT_CONVERSATION_TITLE = 'First chat';

/**
 * The turns one cohort account sent, in a conversation of its own, written
 * through billing's own backdating producer with the account named as the
 * SENDER. The sender is the whole point: the ladder's activated and
 * week-one-return rungs both ask whether a usage record names the account that
 * way, and a payer alone leaves both rungs reading zero.
 *
 * The live path cannot mint these — it stamps `now`. The week-one-return rung
 * asks for a turn seven days past the account's own backdated creation instant,
 * which `now` satisfies for every account older than a week and for none
 * younger, so the rung would track cohort age rather than show a gradient. The
 * activated rung is date-free and `now` would serve it.
 */
async function sendTurnsForCohortAccount(
  db: Database,
  account: GrowthCohortAccount,
  userId: string
): Promise<void> {
  if (account.usage.length === 0) return;
  const conversationId = seedUUID(`cohort-conversation-${account.email}`);
  await createDevConversation(db, {
    ownerEmail: account.email,
    seedAiModel: SEED_MODEL_ID,
    id: conversationId,
    title: COHORT_CONVERSATION_TITLE,
  });
  await seedUsageHistory(
    { db },
    {
      userId,
      walletId: await purchasedWalletId(db, userId),
      conversationId,
      records: account.usage.map((turn, index) => ({
        stableKey: `cohort-usage-${account.email}-${index.toString()}`,
        modelId: SEED_MODEL_ID,
        providerName: 'anthropic',
        modality: 'text' as const,
        billableCostNanoUsd: turn.billableCostNanoUsd,
        senderUserId: userId,
        tokens: { inputTokens: 400, outputTokens: 200 },
        createdAt: turn.at,
      })),
    }
  );
}

/**
 * The account-side half of the growth dashboard: the cohort grid, the
 * self-reported sources panel and the ladder's account steps all read the
 * acquisition table joined to accounts by creation week, and none of them
 * reads a growth table at all.
 *
 * Every account is registered through the real registration settlement, which
 * is what writes its acquisition row; the channel answer goes through the same
 * verb the account holder's prompt sends. Only the creation instant is written
 * from outside a flow, because no flow can express it — the column is a
 * default stamped by the transaction that inserts the row, and the panels
 * bucket by it.
 *
 * Runs after the growth seed, which mints the campaigns these rows reference:
 * the acquisition campaign is a foreign key, so a tag with no row fails the
 * write rather than mislabelling one.
 */
async function seedAcquisitionCohorts(db: Database, secrets: SeedSecrets): Promise<void> {
  const plan = buildGrowthCohortPlan(new Date());
  const figures = growthCohortFigures(plan);
  const personas = plan.map((account) => toCohortSeedPersona(account));
  const personaCrypto = await warmPersonaCrypto(secrets.opaqueKekSecret, personas);
  const deps = baseMintDeps(db, secrets, personaCrypto);
  const stores = createIdentityStores(db);

  // One chain per account, run side by side: every step writes that account's
  // own rows, so accounts share nothing but the campaigns the growth seed minted.
  const results = await mapWithConcurrency(plan, SEED_CONCURRENCY, async (account, index) => {
    const persona = personas[index];
    /* v8 ignore next 2 -- the two arrays are built from one plan in one pass, so every index is present */
    if (persona === undefined) throw new Error('seed: a cohort account has no persona');
    const result = await mintSeedUser(deps, persona);
    // Written every run, not only on the run that created the row: the value is
    // the account's own day, so a re-run rewrites what is already there rather
    // than moving it.
    await setAccountCreatedAt(db, { email: account.email, createdAt: account.createdAt });
    // Re-asserted on the same terms as the two rosters above: the mint is
    // skip-if-exists, so the flag it applies on the run that created the row
    // would otherwise be the only one that row ever carries, and an account
    // already seeded would stop matching the plan that describes it.
    await setEmailVerified(db, { email: account.email, verified: account.emailVerified });
    await answerChannelPrompt(db, stores, account, persona.userId);
    await payForCohortAccount(db, account, persona.userId);
    await sendTurnsForCohortAccount(db, account, persona.userId);
    return result;
  });
  const created = results.filter((result) => result.created).length;

  console.log(
    `seed[cohorts]: ${figures.accounts.toString()} accounts across ${GROWTH_COHORT_DAYS.toString()} days (${created.toString()} newly created), ${figures.verified.toString()} verified, ${figures.answered.toString()} answering the channel question, ${figures.activated.toString()} sending a turn, ${figures.returned.toString()} coming back after their first week, ${figures.paid.toString()} paying; campaigns ${figures.campaignTags.join(', ')}.`
  );
}

/**
 * Injects the one synthetic strict-image catalog row through the models slice's
 * published `upsertCatalog` (single-writer boundary — never a raw insert). The
 * live `catalog:refresh` exposes only one ZDR strict-image model, so this second
 * exposed id is what lets the multi-model image fan-out select two distinct
 * models. Asserted present afterward so a broken descriptor fails the seed loud,
 * not mid-test. The seed's local-DB guard keeps this row out of production.
 */
async function seedSyntheticImageModel(db: Database): Promise<void> {
  const result = await upsertCatalog(db, seededImageModelUpsert(new Date()));
  if (result.isErr()) {
    throw new Error(`seed: synthetic image model upsert failed — ${result.error.message}`);
  }
  await assertSeededImageModelPresent(db);
  console.log('seed[catalog]: synthetic strict-image model upserted.');
}

/**
 * The video twin of {@link seedSyntheticImageModel}, needed more than it is:
 * no video model the gateway offers is zero-data-retention reachable, so the
 * live refresh admits none and these rows are the whole video catalog the app
 * and the specs see, not merely a second id beside a live one.
 */
async function seedSyntheticVideoModels(db: Database): Promise<void> {
  const upserts = seededVideoModelUpserts(new Date());
  for (const params of upserts) {
    const result = await upsertCatalog(db, params);
    if (result.isErr()) {
      throw new Error(`seed: synthetic video model upsert failed — ${result.error.message}`);
    }
  }
  await assertSeededVideoModelsPresent(db);
  console.log(
    `seed[catalog]: ${upserts.length.toString()} synthetic strict-video models upserted.`
  );
}

/**
 * What the keyspace census reports when it sampled no key at all, which is the
 * honest answer for an empty database and for one whose every scan page came
 * back empty. It is a sentinel rather than an empty string because the census
 * is read by a human out of a seed log, where a blank reads as a bug in the
 * check.
 */
export const NO_KEYS_SAMPLED = '(no keys sampled)';

/** How many keys one census samples to name the family the keyspace is made of. */
const KEYSPACE_SAMPLE_SIZE = 1000;

/**
 * How many `SCAN` pages one census takes. A page may come back empty with a
 * cursor that has not returned to its start, so the sample size alone does not
 * bound the walk; this does, and it is what keeps a check that runs against a
 * re-inflated keyspace from walking all of it to describe it.
 */
export const KEYSPACE_SAMPLE_PAGES = 4;

/** The Redis surface a keyspace census reads, and nothing wider. */
export interface KeyspaceReader {
  dbsize: () => Promise<number>;
  scan: (cursor: string, options: { count: number }) => Promise<[string, string[]]>;
}

/** What a census saw: the database's own count, and what its sample was made of. */
interface KeyspaceCensus {
  readonly keys: number;
  readonly sampled: number;
  readonly dominantFamily: string;
}

/**
 * The family a key belongs to: its leading segments, less the last one, capped
 * at two.
 *
 * Both limits are about what a family may not carry. Dropping the last segment
 * drops the value a key is keyed on — the wallet id in an admission snapshot's
 * key. Capping at two drops what sits deeper: a growth key's third segment is
 * its time bucket, and a bucket printed into a seed log is a clock reading.
 * Two segments is also as much as the reading needs, since what a reader is
 * asking is which subsystem the keyspace is made of.
 */
export function keyFamily(key: string): string {
  const segments = key.split(':');
  if (segments.length < 2) return key;
  return segments.slice(0, Math.min(2, segments.length - 1)).join(':');
}

/**
 * The family most of the sampled keys belong to; the first family seen wins a
 * tie, so one sample always yields one answer.
 */
export function dominantKeyFamily(keys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const family = keyFamily(key);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  let dominant = NO_KEYS_SAMPLED;
  let best = 0;
  for (const [family, count] of counts) {
    if (count > best) {
      dominant = family;
      best = count;
    }
  }
  return dominant;
}

async function censusKeyspace(redis: KeyspaceReader): Promise<KeyspaceCensus> {
  const keys = await redis.dbsize();
  const sample: string[] = [];
  let cursor = '0';
  for (let page = 0; page < KEYSPACE_SAMPLE_PAGES; page += 1) {
    const [next, found] = await redis.scan(cursor, { count: KEYSPACE_SAMPLE_SIZE });
    sample.push(...found);
    cursor = next;
    if (cursor === '0' || sample.length >= KEYSPACE_SAMPLE_SIZE) break;
  }
  return { keys, sampled: sample.length, dominantFamily: dominantKeyFamily(sample) };
}

/**
 * The gate on the end-to-end stack's Redis: the seed refuses to finish over a
 * keyspace larger than the reset that runs before every test is designed for.
 *
 * It reads the count from the database rather than from anything the seed
 * believes it wrote, because the regression it refuses is precisely a seed
 * whose keys nobody counted. The family is what makes the count actionable —
 * a few hundred admission snapshots are a seed that has just run, the same
 * count under a subsystem's family is history somebody seeded.
 *
 * `ceiling` is a parameter so the gate can be proven to refuse against the real
 * database without anyone writing a regression's worth of keys into a shared
 * one; the seed itself always passes the declared bound.
 */
export async function assertE2eKeyspaceWithinCeiling(
  redis: KeyspaceReader,
  ceiling: number = E2E_KEYSPACE_CEILING
): Promise<void> {
  const census = await censusKeyspace(redis);
  const tail = `dominant family across ${census.sampled.toString()} sampled key(s): ${census.dominantFamily}`;
  if (census.keys > ceiling) {
    throw new Error(
      `seed[keyspace]: the end-to-end Redis database holds ${census.keys.toString()} keys, over its ceiling of ${ceiling.toString()}; ${tail}. ` +
        'Scope whatever seeds that family to the development stack: the end-to-end stack holds only what the suite reads.'
    );
  }
  console.log(
    `seed[keyspace]: ${census.keys.toString()} key(s) in the end-to-end Redis database, within its ceiling of ${ceiling.toString()}; ${tail}.`
  );
}

/** The one seed path: seeds everything, idempotently (legacy-parity single pass). */
export async function runSeed(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  assertLocalDatabaseUrl(databaseUrl);
  const secrets: SeedSecrets = {
    opaqueKekSecret: resolveSeedSecret('OPAQUE_KEK'),
    totpEncryptionSecret: resolveSeedSecret('TOTP_ENCRYPTION_SECRET'),
  };
  // One connection per chain in flight: a chain holds at most one at a time,
  // and a waiter queued past the pool dies at the client's acquire deadline.
  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG, poolSize: SEED_CONCURRENCY });
  try {
    // `model_catalog` is populated out-of-band by `catalog:refresh` before this
    // runs (see `e2e:prepare` / `pnpm dev`): the dev conversation factories and
    // the app's model picker read those exposed descriptors, and the E2E
    // per-test dev routes depend on them. Test personas first, dev data second
    // (the order the combined seed has always used); balances are set after
    // each persona's mint so the authoritative values land last.
    const redis = createSeedRedis();
    await seedSyntheticImageModel(db);
    await seedSyntheticVideoModels(db);
    await seedTestPersonas(db, redis, secrets);
    await seedDevData(db, redis, secrets);
    await seedGrowth(db, redis);
    await seedAcquisitionCohorts(db, secrets);
    // Public stats last: its snapshot is recomputed from every `usage_records`
    // row there is, so a cohort turn written after it would reach the snapshot
    // only on the NEXT seed — the first seed of a database and a re-seed of it
    // would then publish different figures from the same plan.
    await seedPublicStats(db);
    // Last, and only over the stack that pays for a key once per test: the
    // development database legitimately holds the growth history this refuses.
    if (createEnvUtilities(process.env).isE2E) {
      await assertE2eKeyspaceWithinCeiling(redis);
    }
  } finally {
    await db.$client.end();
  }
}

/* v8 ignore start -- CLI wiring; the pure helpers are unit-tested, seeding proven by the E2E run */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    assertNoSeedArgs(process.argv.slice(2));
    await runSeed();
  });
}
/* v8 ignore stop */

export {
  BASE_TEST_PERSONAS,
  E2E_PROJECT_NAMES,
  TEST_2FA_TOTP_SECRET,
  testPersonaName,
  type E2EProjectName,
  TEST_PERSONAS,
  DEV_PERSONAS,
  MOBILE_TEST_PERSONA,
  seedUUID,
  pooledPersonaName,
} from './lib/seed/personas.js';
