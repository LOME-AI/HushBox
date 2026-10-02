import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROWTH_SEED_CAMPAIGNS, GROWTH_SEED_DAYS } from './lib/seed/growth.js';
import { buildGrowthCohortPlan } from './lib/seed/cohorts.js';

// `runSeed` orchestrates the audited `@hushbox/api/dev-seed` producers against a
// real local Postgres/Redis. Here the true external seams (DB client, Redis, the
// dev-seed producers, the OPAQUE crypto pool) are mocked so the orchestration
// logic — persona mapping, wallet-balance formatting, the screenshot/group-chat
// fan-out — is exercised deterministically without touching infrastructure.

const endSpy = vi.fn();
let walletRows: { id: string }[] = [{ id: 'wallet-1' }];
let cryptoResult: Uint8Array | undefined = new Uint8Array([1, 2, 3]);

const fakeDb = {
  select: () => ({ from: () => ({ where: () => Promise.resolve(walletRows) }) }),
  $client: { end: endSpy },
};

vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  return { ...actual, createDb: vi.fn(() => fakeDb) };
});

// The census the seed's tail runs is the one thing here that reads Redis back:
// every other Redis caller in `seed.ts` goes through a mocked dev-seed producer.
// An empty database is what a mocked seed leaves behind, so that is what it answers.
vi.mock('@upstash/redis', () => ({
  Redis: class {
    dbsize(): Promise<number> {
      return Promise.resolve(0);
    }
    scan(): Promise<[string, string[]]> {
      return Promise.resolve(['0', []]);
    }
  },
}));

interface MintDeps {
  opaqueKek: Uint8Array;
  totpEncryptionSecret: Uint8Array;
  personaCrypto: (r: { credentialIdentifier: string }) => Promise<Uint8Array>;
}

/** One mark in the log of producer calls: a call starting, or its promise settling. */
interface ProducerMark {
  readonly mark: 'start' | 'end';
  readonly producer: string;
  /** The emails, user ids and conversation ids the call was made for. */
  readonly keys: readonly string[];
}

/**
 * Every tracked producer call the mocked seed makes, in the order its start and
 * its end happened. Each tracked call yields once between the two, so calls the
 * seed runs side by side interleave here and calls it awaits in turn do not.
 */
const marks: ProducerMark[] = [];

function tracked<A extends unknown[], R>(
  producer: string,
  keysOf: (...args: A) => readonly string[],
  body: (...args: A) => R | Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const keys = keysOf(...args);
    marks.push({ mark: 'start', producer, keys });
    await Promise.resolve();
    const result = await body(...args);
    marks.push({ mark: 'end', producer, keys });
    return result;
  };
}

const mintSeedUser = vi.fn(
  tracked(
    'mintSeedUser',
    (_deps: MintDeps, persona: { userId: string; email: string }) => [
      persona.email,
      persona.userId,
    ],
    async (deps: MintDeps, persona: { userId: string; email: string }) => {
      // Exercise the warmed-crypto provider closure the real mint would call.
      await deps.personaCrypto({ credentialIdentifier: persona.userId });
      return { created: true };
    }
  )
);

const publicSnapshotRun = vi.fn(() => Promise.resolve());

/** What the growth seed door waits on before it answers; already settled unless a case holds it. */
let growthHeld: Promise<void> = Promise.resolve();

/** What the growth seed door answers with. Reassigned per case, so the orchestration's own reporting is exercised. */
let growthOutcome = {
  campaignsMinted: 3,
  beaconsCounted: 3000,
  startsCounted: 150,
  hoursRolled: 90,
  overflowLatched: [] as readonly string[],
  addressBudgetsFilled: 0,
  landingsClamped: [] as readonly string[],
};

// A factory REPLACES the module, so anything `seed.ts` reaches for — directly or
// through an unmocked helper like `lib/playwright/seeded-image-model.ts` — must appear
// here or the access throws. `DESCRIPTOR_VERSION` is taken from the real module
// rather than restated, so the catalog rows the seed writes stay pinned to the
// one contract version.
vi.mock('@hushbox/api/dev-seed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/api/dev-seed')>();
  return {
    DESCRIPTOR_VERSION: actual.DESCRIPTOR_VERSION,
    E2E_KEYSPACE_CEILING: actual.E2E_KEYSPACE_CEILING,
    createBillingStores: vi.fn(() => ({})),
    createIdentityStores: vi.fn(() => ({})),
    createNoopSeedEmailPorts: vi.fn(() => ({ emailSender: {}, pushSender: {} })),
    createDevConversation: vi.fn(
      tracked(
        'createDevConversation',
        (_db: unknown, params: { id: string; ownerEmail: string; title?: string }) => [
          params.id,
          params.ownerEmail,
          params.title ?? '',
        ],
        () => {}
      )
    ),
    createDevGroupChat: vi.fn(
      tracked(
        'createDevGroupChat',
        (_db: unknown, params: { id: string }) => [params.id],
        () => {}
      )
    ),
    mintSeedUser,
    seedAdminOpTargets: vi.fn(async () => {}),
    seedPaymentsHistory: vi.fn(
      tracked(
        'seedPaymentsHistory',
        (_deps: unknown, params: { userId: string }) => [params.userId],
        () => {}
      )
    ),
    seedGrowthCounts: vi.fn(
      tracked(
        'seedGrowthCounts',
        (_deps: unknown, _plan: unknown) => [],
        async () => {
          await growthHeld;
          return growthOutcome;
        }
      )
    ),
    seedPublicUsageRecords: vi.fn(() => Promise.resolve({ usageRecordsCreated: 252 })),
    seedUsageHistory: vi.fn(
      tracked(
        'seedUsageHistory',
        (_deps: unknown, params: { userId: string }) => [params.userId],
        () => {}
      )
    ),
    applySelfReport: vi.fn(
      tracked(
        'applySelfReport',
        (deps: { userId: string }) => [deps.userId],
        () => ({ isErr: () => false })
      )
    ),
    setAccountCreatedAt: vi.fn(
      tracked(
        'setAccountCreatedAt',
        (_db: unknown, params: { email: string }) => [params.email],
        () => {}
      )
    ),
    setEmailVerified: vi.fn(
      tracked(
        'setEmailVerified',
        (_db: unknown, params: { email: string }) => [params.email],
        () => {}
      )
    ),
    setWalletBalance: vi.fn(
      tracked(
        'setWalletBalance',
        (_db: unknown, _redis: unknown, params: { email: string }) => [params.email],
        () => {}
      )
    ),
    upsertCatalog: vi.fn(() => ({ isErr: () => false })),
    createConsoleTelemetry: vi.fn(() => ({})),
    createPublicStatsStores: vi.fn(() => ({})),
    createCatalogModelMetaResolver: vi.fn(() => vi.fn()),
    createPublicStatsSnapshotEntry: vi.fn(() => ({
      name: 'public-stats-snapshot',
      run: publicSnapshotRun,
    })),
  };
});

// The synthetic-media post-seed guards read `model_catalog` against the real DB;
// stubbed here so `runSeed`'s orchestration is exercised without a catalog
// fixture (the guards themselves are unit-tested in `lib/playwright/models-assert.test.ts`).
// This factory REPLACES the module, so every guard `seed.ts` imports must appear
// here or the call site sees `undefined`.
vi.mock('./lib/playwright/models.js', () => ({
  assertSeededImageModelPresent: vi.fn(() => Promise.resolve()),
  assertSeededVideoModelsPresent: vi.fn(() => Promise.resolve()),
}));

vi.mock('./lib/seed/crypto-pool.js', () => ({
  ensurePersonaCrypto: vi.fn(() => Promise.resolve({ get: () => cryptoResult })),
}));

vi.mock('./lib/seed/crypto-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/seed/crypto-cache.js')>();
  return { ...actual, computeCryptoFingerprint: vi.fn(() => Promise.resolve('fp')) };
});

const devSeed = await import('@hushbox/api/dev-seed');
const { deriveOpaqueKek } = await import('@hushbox/crypto');
const { DEV_EMAIL_DOMAIN, Mode, TEST_EMAIL_DOMAIN, resolveRaw } = await import('@hushbox/shared');
const { envConfig } = await import('@hushbox/shared/env.config');
const { ensurePersonaCrypto } = await import('./lib/seed/crypto-pool.js');
const { DOCUMENT_SHOWCASE_TITLE } = await import('./lib/seed/documents.js');
const { buildPersonaSampleConversations } = await import('./lib/seed/conversations.js');
const {
  ADMIN_TARGET_PERSONA,
  DEV_PERSONAS,
  MOBILE_TEST_PERSONA,
  SEED_CONCURRENCY,
  TEST_PERSONAS,
  runSeed,
  seedUUID,
} = await import('./seed.js');

const ENV_KEYS = [
  'DATABASE_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'OPAQUE_KEK',
  'TOTP_ENCRYPTION_SECRET',
  'E2E',
] as const;

const OPAQUE_KEK_VALUE = 'k'.repeat(40);
const TOTP_ENCRYPTION_SECRET_VALUE = 't'.repeat(40);
const utf8 = new TextEncoder();

/**
 * The items in a canonical order, for comparing as multisets what the seed
 * produces side by side and so in no fixed order.
 */
function contents<T>(items: readonly T[]): T[] {
  const key = (item: T): string => JSON.stringify([item]);
  return items.toSorted((left, right) => key(left).localeCompare(key(right)));
}

function mintDeps(): MintDeps {
  const call = mintSeedUser.mock.calls[0];
  if (call === undefined) throw new Error('mintSeedUser was not called');
  return call[0];
}

/** The development-mode literal a registry entry carries; the seed falls back to it. */
function developmentValue(config: Parameters<typeof resolveRaw>[0]): string {
  const value = resolveRaw(config, Mode.Development);
  if (typeof value !== 'string') throw new Error('development-mode value is not a literal');
  return value;
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['DATABASE_URL'] = 'postgres://postgres:postgres@localhost:5432/hushbox';
  process.env['UPSTASH_REDIS_REST_URL'] = 'http://localhost:8079';
  process.env['UPSTASH_REDIS_REST_TOKEN'] = 'token';
  process.env['OPAQUE_KEK'] = OPAQUE_KEK_VALUE;
  process.env['TOTP_ENCRYPTION_SECRET'] = TOTP_ENCRYPTION_SECRET_VALUE;
  // Pinned rather than inherited: the seed's growth window is decided by the
  // env mode, so a case asserting the development window has to know it is in
  // one whatever the shell handed this process.
  Reflect.deleteProperty(process.env, 'E2E');
  walletRows = [{ id: 'wallet-1' }];
  cryptoResult = new Uint8Array([1, 2, 3]);
  growthOutcome = {
    campaignsMinted: 3,
    beaconsCounted: 3000,
    startsCounted: 150,
    hoursRolled: 90,
    overflowLatched: [],
    addressBudgetsFilled: 0,
    landingsClamped: [],
  };
  growthHeld = Promise.resolve();
  marks.length = 0;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe('runSeed', () => {
  it('seeds everything in one pass: personas, balances, conversations, history, admin targets', async () => {
    await runSeed();

    // Both rosters minted personas and got authoritative balances.
    expect(mintSeedUser).toHaveBeenCalled();
    expect(devSeed.setWalletBalance).toHaveBeenCalled();
    // The screenshot fan-out hit both the solo and group factories.
    expect(devSeed.createDevConversation).toHaveBeenCalled();
    expect(devSeed.createDevGroupChat).toHaveBeenCalled();
    // Alice's billing history and admin op-targets were seeded.
    // Alice's rich history, plus one backdated payment per paying cohort account.
    expect(devSeed.seedPaymentsHistory).toHaveBeenCalledTimes(
      1 + buildGrowthCohortPlan(new Date()).filter((account) => account.payment !== null).length
    );
    // Alice's rich history, plus the turns of every cohort account that sent one.
    expect(devSeed.seedUsageHistory).toHaveBeenCalledTimes(
      1 + buildGrowthCohortPlan(new Date()).filter((account) => account.usage.length > 0).length
    );
    expect(devSeed.seedAdminOpTargets).toHaveBeenCalledTimes(1);
    // The connection is always closed.
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('seeds a document-showcase conversation for every dev persona', async () => {
    await runSeed();
    const conversations = (
      devSeed.createDevConversation as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[1] as { id: string; ownerEmail: string; title: string });
    const showcases = conversations.filter(
      (conversation) => conversation.title === DOCUMENT_SHOWCASE_TITLE
    );
    expect(showcases.map((showcase) => showcase.ownerEmail)).toEqual(
      DEV_PERSONAS.map((persona) => `${persona.name}@${DEV_EMAIL_DOMAIN}`)
    );
  });

  it('upserts the synthetic strict-image catalog row through the slice barrel', async () => {
    await runSeed();
    const call = (devSeed.upsertCatalog as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = call?.[1] as { modelId: string; content: { outputs: string[] } };
    expect(params.modelId).toBe('hushbox-e2e/mock-image-2');
    expect(params.content.outputs).toEqual(['image']);
  });

  it('upserts every synthetic strict-video catalog row through the slice barrel', async () => {
    await runSeed();
    // One image row (a second id beside the live image model) plus the whole
    // video catalog, which is synthetic end to end.
    expect(devSeed.upsertCatalog).toHaveBeenCalledTimes(3);
    const calls = (devSeed.upsertCatalog as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const videoParams = calls
      .slice(1)
      .map((call) => call[1] as { modelId: string; content: { outputs: string[] } });
    expect(videoParams.map((params) => params.modelId)).toEqual([
      'hushbox-e2e/mock-video-1',
      'hushbox-e2e/mock-video-2',
    ]);
    expect(videoParams.every((params) => params.content.outputs[0] === 'video')).toBe(true);
  });

  it('fails loud when the synthetic image model upsert errors', async () => {
    (devSeed.upsertCatalog as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      isErr: () => true,
      error: { message: 'catalog write failed' },
    });
    await expect(runSeed()).rejects.toThrow('synthetic image model upsert failed');
    // The connection is still closed on the failure path.
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('fails loud when the synthetic video model upsert errors', async () => {
    (devSeed.upsertCatalog as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ isErr: () => false })
      .mockReturnValueOnce({ isErr: () => true, error: { message: 'catalog write failed' } });
    await expect(runSeed()).rejects.toThrow('synthetic video model upsert failed');
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('seeds the growth dashboard through the slice’s counting-path door', async () => {
    await runSeed();

    expect(devSeed.seedGrowthCounts).toHaveBeenCalledTimes(1);
    const call = (devSeed.seedGrowthCounts as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const plan = call?.[1] as {
      campaigns: { tag: string }[];
      hours: { at: Date; visitors: unknown[] }[];
    };
    expect(plan.hours).toHaveLength(GROWTH_SEED_DAYS);
    expect(plan.campaigns).toEqual(GROWTH_SEED_CAMPAIGNS);
    // Oldest first: the door counts and rolls in the order the plan gives.
    expect(plan.hours[0]?.at.getTime()).toBeLessThan(plan.hours.at(-1)?.at.getTime() ?? 0);
  });

  it('seeds the end-to-end stack no growth history at all', async () => {
    // The E2E suite reads none of it, and every key it writes is keyspace the
    // per-test rate-limit reset crosses.
    process.env['E2E'] = 'true';

    await runSeed();

    const call = (devSeed.seedGrowthCounts as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const plan = call?.[1] as { hours: unknown[] };
    expect(plan.hours).toEqual([]);
  });

  it('gates the keyspace at the tail of an end-to-end seed', async () => {
    const log = vi.spyOn(console, 'log');
    process.env['E2E'] = 'true';

    await runSeed();

    expect(log.mock.calls.flat().join(' ')).toContain('seed[keyspace]');
  });

  it('leaves the keyspace ungated over the development stack, which holds history by design', async () => {
    const log = vi.spyOn(console, 'log');

    await runSeed();

    expect(log.mock.calls.flat().join(' ')).not.toContain('seed[keyspace]');
  });

  it('warns when a seeded set was cut off by a ceiling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    growthOutcome = { ...growthOutcome, overflowLatched: ['d:visitors'] };

    await runSeed();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hit a ceiling'));
  });

  it('warns when an address gave up its whole daily identity budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    growthOutcome = { ...growthOutcome, addressBudgetsFilled: 2 };

    await runSeed();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('daily identity budget'));
  });

  it('warns when a re-roll had to lower a stored landing count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    growthOutcome = { ...growthOutcome, landingsClamped: ['day 2026-02-11 /pricing'] };

    await runSeed();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('day 2026-02-11 /pricing'));
  });

  it('says nothing about lowered landing counts when the re-roll lowered none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSeed();

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('landing count'));
  });

  it('says nothing about identity budgets when no address filled one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSeed();

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('daily identity budget'));
  });

  it('seeds anonymous public usage records and snapshots through the real cron entry', async () => {
    await runSeed();

    expect(devSeed.seedPublicUsageRecords).toHaveBeenCalledTimes(1);
    const call = (devSeed.seedPublicUsageRecords as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const { records } = call?.[1] as {
      records: { stableKey: string; modality: string; isEstimated: boolean }[];
    };
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.stableKey.startsWith('public-usage-'))).toBe(true);
    // Image records carry the deterministic-estimate flag; text records do not.
    expect(records.some((record) => record.modality === 'image' && record.isEstimated)).toBe(true);
    expect(records.some((record) => record.modality === 'text' && !record.isEstimated)).toBe(true);

    // The snapshot is produced by the SAME entry the daily cron runs, composed
    // from the real billing stores and the catalog meta resolver.
    expect(devSeed.createPublicStatsSnapshotEntry).toHaveBeenCalledTimes(1);
    expect(devSeed.createCatalogModelMetaResolver).toHaveBeenCalledTimes(1);
    expect(devSeed.createPublicStatsStores).toHaveBeenCalledTimes(1);
    expect(publicSnapshotRun).toHaveBeenCalledTimes(1);
  });

  it('sets authoritative balances for both the test and dev rosters', async () => {
    await runSeed();
    const emails = (devSeed.setWalletBalance as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[2] as { email: string }).email
    );
    expect(emails.some((email) => email.endsWith('@test.hushbox.ai'))).toBe(true);
    expect(emails.some((email) => email.endsWith('@dev.hushbox.ai'))).toBe(true);
  });

  it('re-asserts every test persona emailVerified flag from the roster', async () => {
    await runSeed();
    const calls = (devSeed.setEmailVerified as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[1] as { email: string; verified: boolean }
    );
    expect(contents(calls)).toEqual(
      contents([
        ...[...TEST_PERSONAS, MOBILE_TEST_PERSONA].map((persona) => ({
          email: `${persona.name}@${TEST_EMAIL_DOMAIN}`,
          verified: persona.emailVerified,
        })),
        // The cohort accounts are re-asserted on the same terms and in the same
        // pass: the mint is skip-if-exists, so a flag it applied on the run that
        // created the row is the only one the row would ever carry.
        ...buildGrowthCohortPlan(new Date()).map((account) => ({
          email: account.email,
          verified: account.emailVerified,
        })),
      ])
    );
    // The roster carries at least one deliberately unverified persona — the one
    // an E2E verify-email journey flips and a re-seed has to put back.
    expect(calls.some((call) => !call.verified)).toBe(true);
  });

  it('formats a whole-dollar balance without a fraction and a negative balance with a sign', async () => {
    await runSeed();
    const balances = (
      devSeed.setWalletBalance as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => (call[2] as { balance: string }).balance);
    // The roster carries at least one whole-dollar balance and mallory's negative
    // (chargeback) balance — both formatting branches of nanoUsdToDecimalString.
    expect(balances.some((b) => !b.includes('.') && !b.startsWith('-'))).toBe(true);
    expect(balances.some((b) => b.startsWith('-'))).toBe(true);
  });

  it('hands mintSeedUser the KEK derived from OPAQUE_KEK', async () => {
    await runSeed();
    expect(mintDeps().opaqueKek).toEqual(deriveOpaqueKek(utf8.encode(OPAQUE_KEK_VALUE)));
  });

  it('hands mintSeedUser the TOTP_ENCRYPTION_SECRET bytes', async () => {
    await runSeed();
    expect(mintDeps().totpEncryptionSecret).toEqual(utf8.encode(TOTP_ENCRYPTION_SECRET_VALUE));
  });

  it('keys the persona crypto pool on OPAQUE_KEK', async () => {
    await runSeed();
    const options = vi.mocked(ensurePersonaCrypto).mock.calls[0]?.[1];
    expect(options?.opaqueKekSecret).toBe(OPAQUE_KEK_VALUE);
  });

  it('falls back to the development-mode config value when OPAQUE_KEK is unset', async () => {
    delete process.env['OPAQUE_KEK'];
    await runSeed();
    const configured = developmentValue(envConfig.OPAQUE_KEK);
    expect(mintDeps().opaqueKek).toEqual(deriveOpaqueKek(utf8.encode(configured)));
  });

  it('falls back to the development-mode config value when TOTP_ENCRYPTION_SECRET is unset', async () => {
    delete process.env['TOTP_ENCRYPTION_SECRET'];
    await runSeed();
    const configured = developmentValue(envConfig.TOTP_ENCRYPTION_SECRET);
    expect(mintDeps().totpEncryptionSecret).toEqual(utf8.encode(configured));
  });

  it('closes the connection even when seeding throws', async () => {
    walletRows = [];
    await expect(runSeed()).rejects.toThrow('purchased wallet not found');
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects when a required env var is missing', async () => {
    delete process.env['DATABASE_URL'];
    await expect(runSeed()).rejects.toThrow('DATABASE_URL is required');
  });

  it('rejects when the warmed crypto cache is missing a persona', async () => {
    cryptoResult = undefined;
    await expect(runSeed()).rejects.toThrow('no cached crypto');
  });
});

describe('the account-side cohort seed', () => {
  /** The plan `runSeed` builds, rebuilt here from the same run day. */
  function plan(): ReturnType<typeof buildGrowthCohortPlan> {
    return buildGrowthCohortPlan(new Date());
  }

  function mintedCohortPersonas(): { email: string; acquisition?: { campaign: string } }[] {
    return mintSeedUser.mock.calls
      .map((call) => call[1] as unknown as { email: string; acquisition?: { campaign: string } })
      .filter((persona) => persona.email.startsWith('cohort-'));
  }

  it('registers every planned account, carrying the acquisition stamp registration writes', async () => {
    await runSeed();

    const minted = mintedCohortPersonas();
    expect(
      contents(
        minted.map((persona) => ({ email: persona.email, campaign: persona.acquisition?.campaign }))
      )
    ).toEqual(
      contents(plan().map((account) => ({ email: account.email, campaign: account.campaign })))
    );
  });

  it('dates every account back to the instant its cohort belongs at', async () => {
    await runSeed();

    const dated = (
      devSeed.setAccountCreatedAt as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[1] as { email: string; createdAt: Date });
    expect(contents(dated)).toEqual(
      contents(plan().map((account) => ({ email: account.email, createdAt: account.createdAt })))
    );
  });

  it('answers the channel question through the verb the prompt itself sends', async () => {
    await runSeed();

    const answers = (devSeed.applySelfReport as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[1] as { action: string; channel: string; context: string }
    );
    expect(contents(answers)).toEqual(
      contents(
        plan()
          .filter((account) => account.selfReportedChannel !== null)
          .map((account) => ({
            action: 'answer',
            channel: account.selfReportedChannel,
            context: account.selfReportedContext,
          }))
      )
    );
  });

  it('seeds a backdated completed payment for every paying account', async () => {
    await runSeed();

    const cohortPayments = (
      devSeed.seedPaymentsHistory as unknown as ReturnType<typeof vi.fn>
    ).mock.calls
      .map((call) => call[1] as { payments: { stableKey: string; createdAt: Date }[] })
      .flatMap((params) => params.payments)
      .filter((payment) => payment.stableKey.startsWith('cohort-'));
    expect(contents(cohortPayments.map((payment) => payment.createdAt))).toEqual(
      contents(
        plan()
          .filter((account) => account.payment !== null)
          .map((account) => account.payment?.at)
      )
    );
  });

  it('opens a conversation of its own for every account that sent a turn', async () => {
    await runSeed();

    const titles = (devSeed.createDevConversation as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as { ownerEmail: string; title?: string })
      .filter((conversation) => conversation.ownerEmail.startsWith('cohort-'));
    expect(contents(titles.map((conversation) => conversation.ownerEmail))).toEqual(
      contents(
        plan()
          .filter((account) => account.usage.length > 0)
          .map((account) => account.email)
      )
    );
  });

  it('names the account itself as the sender of every turn it seeds', async () => {
    await runSeed();

    const cohortTurns = (devSeed.seedUsageHistory as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as { records: { stableKey: string; senderUserId?: string }[] })
      .flatMap((params) => params.records)
      .filter((record) => record.stableKey.startsWith('cohort-'));
    const senders = new Map(
      mintSeedUser.mock.calls
        .map((call) => call[1] as unknown as { email: string; userId: string })
        .map((persona) => [persona.email, persona.userId])
    );
    expect(contents(cohortTurns.map((record) => record.senderUserId))).toEqual(
      contents(plan().flatMap((account) => account.usage.map(() => senders.get(account.email))))
    );
  });

  it('backdates every seeded turn to the instant the plan names for it', async () => {
    await runSeed();

    const cohortTurns = (devSeed.seedUsageHistory as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as { records: { stableKey: string; createdAt: Date }[] })
      .flatMap((params) => params.records)
      .filter((record) => record.stableKey.startsWith('cohort-'));
    expect(contents(cohortTurns.map((record) => record.createdAt))).toEqual(
      contents(plan().flatMap((account) => account.usage.map((turn) => turn.at)))
    );
  });

  it('fails loud when the channel answer cannot be recorded', async () => {
    (devSeed.applySelfReport as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      isErr: () => true,
      error: { code: 'UNAVAILABLE' },
    });
    await expect(runSeed()).rejects.toThrow('channel answer');
  });
});

describe('the seed’s bounded concurrency', () => {
  const testEmails = new Set(
    [...TEST_PERSONAS, MOBILE_TEST_PERSONA].map((persona) => `${persona.name}@${TEST_EMAIL_DOMAIN}`)
  );
  const devEmails = new Set(
    [...DEV_PERSONAS, ADMIN_TARGET_PERSONA].map((persona) => `${persona.name}@${DEV_EMAIL_DOMAIN}`)
  );
  const aliceEmail = `alice@${DEV_EMAIL_DOMAIN}`;
  const bulkIds = new Set(
    DEV_PERSONAS.filter((persona) => persona.hasSampleData).flatMap((persona) =>
      buildPersonaSampleConversations(persona.name, persona.sampleConversationCount).map(
        (conversation) => conversation.id
      )
    )
  );

  function cohortEmails(): Set<string> {
    return new Set(buildGrowthCohortPlan(new Date()).map((account) => account.email));
  }

  function isMark(
    candidate: ProducerMark,
    mark: ProducerMark['mark'],
    producer: string,
    key: (keys: readonly string[]) => boolean
  ): boolean {
    return candidate.mark === mark && candidate.producer === producer && key(candidate.keys);
  }

  function inSet(set: ReadonlySet<string>): (keys: readonly string[]) => boolean {
    return (keys) => keys.some((key) => set.has(key));
  }

  function firstIndex(
    mark: ProducerMark['mark'],
    producer: string,
    key: (keys: readonly string[]) => boolean
  ): number {
    const index = marks.findIndex((candidate) => isMark(candidate, mark, producer, key));
    if (index === -1) throw new Error(`no ${mark} mark for ${producer}`);
    return index;
  }

  function lastIndex(
    mark: ProducerMark['mark'],
    producer: string,
    key: (keys: readonly string[]) => boolean
  ): number {
    const index = marks.findLastIndex((candidate) => isMark(candidate, mark, producer, key));
    if (index === -1) throw new Error(`no ${mark} mark for ${producer}`);
    return index;
  }

  /** The most calls of one producer, for the matching keys, that were started and not yet settled at once. */
  function peakInFlight(producer: string, key: (keys: readonly string[]) => boolean): number {
    let inFlight = 0;
    let peak = 0;
    for (const candidate of marks) {
      if (candidate.producer !== producer || !key(candidate.keys)) continue;
      inFlight += candidate.mark === 'start' ? 1 : -1;
      peak = Math.max(peak, inFlight);
    }
    return peak;
  }

  /** One step of a chain: the producer called and a key its call carries. */
  interface ChainStep {
    readonly producer: string;
    readonly key: string;
  }

  function step(producer: string, key: string): ChainStep {
    return { producer, key };
  }

  /**
   * Whether every step settled before the next one started. Start marks alone
   * cannot tell steps awaited in turn from steps started together, because a
   * call records its start the moment it is made.
   */
  function settledInTurn(steps: readonly ChainStep[]): boolean {
    return steps.every((current, index) => {
      const next = steps[index + 1];
      if (next === undefined) return true;
      return (
        lastIndex('end', current.producer, (keys) => keys.includes(current.key)) <
        firstIndex('start', next.producer, (keys) => keys.includes(next.key))
      );
    });
  }

  it('mints test personas side by side, never more at once than the seed’s bound', async () => {
    await runSeed();

    const peak = peakInFlight('mintSeedUser', inSet(testEmails));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SEED_CONCURRENCY);
  });

  it('sets a test persona’s balance without waiting for every other test persona to be minted', async () => {
    await runSeed();

    expect(firstIndex('start', 'setWalletBalance', inSet(testEmails))).toBeLessThan(
      lastIndex('start', 'mintSeedUser', inSet(testEmails))
    );
  });

  it('runs each test persona’s mint, balance and verified flag in that order', async () => {
    await runSeed();

    const outOfOrder = [...testEmails].filter(
      (email) =>
        !settledInTurn([
          step('mintSeedUser', email),
          step('setWalletBalance', email),
          step('setEmailVerified', email),
        ])
    );
    expect(outOfOrder).toEqual([]);
  });

  it('creates alice’s bulk sample conversations side by side, never more at once than the seed’s bound', async () => {
    await runSeed();

    const peak = peakInFlight('createDevConversation', inSet(bulkIds));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SEED_CONCURRENCY);
  });

  it('seeds cohort accounts side by side, never more at once than the seed’s bound', async () => {
    await runSeed();

    const peak = peakInFlight('mintSeedUser', inSet(cohortEmails()));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SEED_CONCURRENCY);
  });

  it('runs each cohort account’s steps in the order the account lived them', async () => {
    await runSeed();

    const outOfOrder = buildGrowthCohortPlan(new Date()).filter((account) => {
      const userId = seedUUID(account.email);
      return !settledInTurn([
        step('mintSeedUser', account.email),
        step('setAccountCreatedAt', account.email),
        step('setEmailVerified', account.email),
        ...(account.selfReportedChannel === null ? [] : [step('applySelfReport', userId)]),
        ...(account.payment === null ? [] : [step('seedPaymentsHistory', userId)]),
        ...(account.usage.length === 0
          ? []
          : [step('createDevConversation', account.email), step('seedUsageHistory', userId)]),
      ]);
    });
    expect(outOfOrder.map((account) => account.email)).toEqual([]);
  });

  it('starts dev data only after every test persona’s chain has settled', async () => {
    await runSeed();

    expect(lastIndex('end', 'setEmailVerified', inSet(testEmails))).toBeLessThan(
      firstIndex('start', 'mintSeedUser', inSet(devEmails))
    );
  });

  it('creates no dev conversation until every dev persona is minted', async () => {
    await runSeed();

    expect(lastIndex('end', 'mintSeedUser', inSet(devEmails))).toBeLessThan(
      firstIndex('start', 'createDevConversation', inSet(devEmails))
    );
  });

  it('starts the screenshot conversations only after every bulk sample conversation has settled', async () => {
    await runSeed();

    const firstScreenshot = Math.min(
      firstIndex('start', 'createDevConversation', (keys) =>
        keys.some((key) => key.startsWith('Screenshot:'))
      ),
      firstIndex('start', 'createDevGroupChat', () => true)
    );
    expect(lastIndex('end', 'createDevConversation', inSet(bulkIds))).toBeLessThan(firstScreenshot);
  });

  it('sets the dev balances only after alice’s usage history has settled', async () => {
    await runSeed();

    expect(
      lastIndex('end', 'seedUsageHistory', (keys) => keys.includes(seedUUID(aliceEmail)))
    ).toBeLessThan(firstIndex('start', 'setWalletBalance', inSet(devEmails)));
  });

  it('seeds no cohort account until the growth seed has minted its campaigns', async () => {
    let releaseGrowth = (): void => {};
    growthHeld = new Promise((resolve) => {
      releaseGrowth = resolve;
    });
    const seeding = runSeed();
    await vi.waitFor(() => {
      expect(devSeed.seedGrowthCounts).toHaveBeenCalled();
    });
    // Every producer here is a mock that settles in microtasks, so one macrotask
    // turn lets any work not waiting on the growth seed reach its first mint.
    await new Promise((resolve) => setImmediate(resolve));
    const cohortMintsWhileHeld = marks.filter((candidate) =>
      isMark(candidate, 'start', 'mintSeedUser', inSet(cohortEmails()))
    );
    releaseGrowth();
    await seeding;

    expect(cohortMintsWhileHeld).toEqual([]);
    expect(lastIndex('end', 'seedGrowthCounts', () => true)).toBeLessThan(
      firstIndex('start', 'mintSeedUser', inSet(cohortEmails()))
    );
  });

  it('mints every test, dev and cohort persona exactly once', async () => {
    await runSeed();

    const minted = mintSeedUser.mock.calls.map((call) => call[1].email);
    expect(contents(minted)).toEqual(contents([...testEmails, ...devEmails, ...cohortEmails()]));
  });

  it('creates every bulk sample conversation exactly once', async () => {
    await runSeed();

    const created = marks
      .filter((candidate) => isMark(candidate, 'start', 'createDevConversation', inSet(bulkIds)))
      .map((candidate) => candidate.keys[0]);
    expect(contents(created)).toEqual(contents([...bulkIds]));
  });
});
