import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  HOUR_MS,
  OLD_RELEASE_SECONDS,
  TEST_DAY_START,
  freezeClock,
  secondsAt,
} from '@hushbox/shared/test-time';
import { freeDailyAllowanceNanoUsd } from '@hushbox/shared';
import { DESCRIPTOR_VERSION } from '@hushbox/api/dev-seed';
import {
  E2E_MODELS,
  assertE2eModelsPresent,
  assertSeededImageModelPresent,
  assertSeededVideoModelsPresent,
} from './models.js';
import {
  E2E_SEEDED_IMAGE_MODEL_ID,
  E2E_SEEDED_VIDEO_MODEL_IDS,
  E2E_TEXT_PINNED_EFFORT,
  HOLD_PROBE_MODEL_ID,
  PRESENCE_ONLY_MODELS,
} from './model-ids.js';
import type { Database } from '@hushbox/db';
import type { ExcludeReason } from '@hushbox/shared';
import type { SQL } from 'drizzle-orm';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

// `assertE2eModelsPresent` reads `model_catalog` and validates every E2E id is
// exposed and in its strict call-shape family. Here a fake `db.select().from()`
// returns hand-built descriptor rows (in the persisted wire form the models
// slice re-parses) so the exposure/family predicates are driven directly,
// without a live catalog.

/**
 * A persisted-wire-form descriptor: nano-USD pricing crosses the JSON boundary
 * as a string, so a stored descriptor uses string pricing (re-parsed by
 * `ModelDescriptor.safeParse`). Returned as `unknown` — the callee validates it.
 *
 * The stamped version is the product's own: its catalog read refuses a whole
 * catalog carrying any other one, so a fixture stamping a literal would fail
 * every case here the day that constant moves.
 */
function descriptor(overrides: { outputs: readonly string[] } & Record<string, unknown>): unknown {
  return {
    id: 'x/y',
    provider: 'x',
    version: DESCRIPTOR_VERSION,
    inputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: { kind: 'perImage', anchor: '1', dearest: '1' },
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: FIXTURE_STAMP_SECONDS,
    ...overrides,
  };
}

const OUTPUTS_BY_BUCKET = { text: ['text'], image: ['image'], video: ['video'] } as const;

/**
 * What a TEXT descriptor needs beyond exposure to satisfy the turn-shape legs:
 * per-token rates plus a context length make it priceable (the premium leg
 * grades the money projection, and an unpriceable row has none), a reasoning
 * object whose `mandatory` is unset gives it the off rung, and a release far
 * outside the premium recency window keeps recency from marking it premium.
 * Media buckets carry none of it — neither leg reaches them.
 */
const SELECTABLE_TEXT_FIELDS = {
  pricing: { kind: 'tokens', anchor: { base: { input: '1', output: '1' }, tiers: [] } },
  limits: { contextLength: 100_000 },
  reasoning: { supportedEfforts: ['high', 'low'] },
  releasedAt: OLD_RELEASE_SECONDS,
} as const;

/**
 * One `model_catalog` row as a case describes it. `lastSeenAt` is stated only by
 * a case about the read's staleness window; everything else is sighted at the
 * frozen clock and so is current.
 */
interface FixtureRow {
  readonly modelId: string;
  readonly descriptor: unknown;
  readonly lastSeenAt?: Date;
}

/**
 * Every presence-only id mapped to a BARE exposed language-family descriptor:
 * no reasoning object and no per-token rates, so a row here would fail both
 * turn-shape legs if the guard ever applied them to this set. Being unpriceable
 * also keeps these rows out of the premium pool, so adding them moves no other
 * fixture's verdict.
 */
function presenceOnlyRows(): FixtureRow[] {
  return Object.values(PRESENCE_ONLY_MODELS).map((id) => ({
    modelId: id,
    descriptor: descriptor({ id, outputs: ['text'] }),
  }));
}

/**
 * What the HOLD-PROBE descriptor needs beyond exposure: per-token rates and a
 * context window wide enough that one turn's admission hold clears twice the
 * paid negative-balance cushion. Its reasoning is mandatory and it carries no
 * off rung, so a row described this way would fail the text turn-shape leg if
 * the guard ever applied one to this slot. Its combined rate matches the dear
 * pool members other cases push in, so adding it moves no premium verdict.
 */
const HOLD_PROBE_FIELDS = {
  pricing: { kind: 'tokens', anchor: { base: { input: '1', output: '1999' }, tiers: [] } },
  limits: { contextLength: 1_000_000 },
  reasoning: { mandatory: true },
  releasedAt: OLD_RELEASE_SECONDS,
} as const;

/**
 * A hold-probe row whose hold falls short of twice the paid cushion
 * (1,000,000,000 nano) because of its rates and its window: 1 nano a token on
 * each leg, held at its ceiling of 2, and a 100,000-token window. Its hold is
 * 150,399,236 nano:
 *
 * - the answer, 100,000 output tokens × (2 + 5 stored chars × 300 nano) =
 *   150,200,000;
 * - the answer's framing, `ASSISTANT_FRAMING_MAX_CHARS` 640 × 300 = 192,000;
 * - the classifier reserve its mandatory reasoning adds, 1,570 input tokens × 2
 *   + `CLASSIFIER_OUTPUT_TOKEN_CAP` 2,048 output tokens × 2 = 7,236.
 *
 * At {@link HOLD_PROBE_FIELDS}' 1,000,000-token window the same rates would hold
 * 1,502,199,236 and clear the threshold, so the window is what keeps this row
 * short.
 */
const UNDERSIZED_HOLD_PROBE = {
  pricing: { kind: 'tokens', anchor: { base: { input: '1', output: '1' }, tiers: [] } },
  limits: { contextLength: 100_000 },
} as const;

/** The hold-probe id mapped to a descriptor whose hold clears the threshold. */
function holdProbeRow(overrides: Record<string, unknown> = {}): FixtureRow {
  return {
    modelId: HOLD_PROBE_MODEL_ID,
    descriptor: descriptor({
      id: HOLD_PROBE_MODEL_ID,
      outputs: ['text'],
      ...HOLD_PROBE_FIELDS,
      ...overrides,
    }),
  };
}

/** Every declared id — both sets — mapped to a valid, exposed, strict-family descriptor. */
function validRows(): FixtureRow[] {
  return [
    ...(['text', 'image', 'video'] as const).flatMap((bucket) =>
      E2E_MODELS[bucket].map((id) => ({
        modelId: id,
        descriptor: descriptor({
          id,
          outputs: [...OUTPUTS_BY_BUCKET[bucket]],
          ...(bucket === 'text' ? SELECTABLE_TEXT_FIELDS : {}),
        }),
      }))
    ),
    ...presenceOnlyRows(),
    holdProbeRow(),
  ];
}

/**
 * Rates at which the minimum answer alone costs many times one day's free
 * allowance, so no arrangement the producer prices at them fits it.
 */
const UNAFFORDABLE_RATES = {
  pricing: { kind: 'tokens', anchor: { base: { input: '1000000', output: '1000000' }, tiers: [] } },
} as const;

/** The declared text ids, which are the rows carrying per-token rates. */
const TEXT_IDS: ReadonlySet<string> = new Set<string>(E2E_MODELS.text);

/**
 * Every row the turn producer's pool projection admits — the declared text ids
 * and the hold probe — re-described with `overrides`. The rest are left alone:
 * carrying no per-token rates, they reach no pool and would move no verdict.
 */
function pooledRows(overrides: Record<string, unknown>): FixtureRow[] {
  return validRows().map((row) => {
    if (row.modelId === HOLD_PROBE_MODEL_ID) return holdProbeRow(overrides);
    if (!TEXT_IDS.has(row.modelId)) return row;
    return {
      modelId: row.modelId,
      descriptor: descriptor({
        id: row.modelId,
        outputs: ['text'],
        ...SELECTABLE_TEXT_FIELDS,
        ...overrides,
      }),
    };
  });
}

/** The hold-probe row re-described, every other declared row left valid. */
function holdProbeRows(overrides: Record<string, unknown>): FixtureRow[] {
  return validRows().map((row) =>
    row.modelId === HOLD_PROBE_MODEL_ID ? holdProbeRow(overrides) : row
  );
}

/** Every presence-only row re-described, the declared sets left valid. */
function presenceRows(overrides: Record<string, unknown>): FixtureRow[] {
  const presenceOnly = new Set<string>(Object.values(PRESENCE_ONLY_MODELS));
  return validRows().map((row) =>
    presenceOnly.has(row.modelId)
      ? {
          modelId: row.modelId,
          descriptor: descriptor({ id: row.modelId, outputs: ['text'], ...overrides }),
        }
      : row
  );
}

/** One declared text id re-described, the rest left selectable. */
function textRows(overrides: Record<string, unknown>): FixtureRow[] {
  const rows = validRows();
  rows[0] = {
    modelId: E2E_MODELS.text[0],
    descriptor: descriptor({
      id: E2E_MODELS.text[0],
      outputs: ['text'],
      ...SELECTABLE_TEXT_FIELDS,
      ...overrides,
    }),
  };
  return rows;
}

/**
 * A sighting the product's catalog read grades as outside its freshness window,
 * which is the state a gateway retirement leaves behind: the refresh iterates
 * only the models a fetch returned, so a retired row is never re-sighted and
 * nothing else about it changes.
 */
const UNSIGHTED_AT = new Date(TEST_DAY_START - 25 * HOUR_MS);

/** Every declared row valid, one of them last sighted outside that window. */
function unsightedRows(id: string): FixtureRow[] {
  return validRows().map((row) =>
    row.modelId === id
      ? { modelId: row.modelId, descriptor: row.descriptor, lastSeenAt: UNSIGHTED_AT }
      : row
  );
}

/**
 * The SQL of the WHERE clause the last PROJECTED catalog read applied. A fake
 * handle cannot enforce SQL semantics, so the sellability filter is pinned on
 * the query the guard actually builds.
 */
let lastWhereSql = '';

/**
 * Two readers share this handle and the projection tells them apart: the
 * product's catalog read selects the whole row and applies its filters in
 * memory, while the guard's own read projects two columns and filters
 * sellability in SQL. The projected chain deliberately resolves only through
 * `.where(...)`, so a guard read that dropped its filter fails every test in
 * this file rather than only the one asserting the clause.
 */
function fakeDb(rows: FixtureRow[]): Database {
  lastWhereSql = '';
  const stored = rows.map((row) => ({
    id: row.modelId,
    modelId: row.modelId,
    descriptor: row.descriptor,
    adminDisabledAt: null,
    excludedReason: null,
    popularityRank: null,
    lastSeenAt: row.lastSeenAt ?? new Date(TEST_DAY_START),
  }));
  return {
    select: (projection?: unknown) => ({
      from: () =>
        projection === undefined
          ? Promise.resolve(stored)
          : {
              where: (condition: SQL): Promise<typeof stored> => {
                lastWhereSql = new PgDialect().sqlToQuery(condition).sql;
                return Promise.resolve(stored);
              },
            },
    }),
  } as unknown as Database;
}

/** A refresh that excluded nothing the declared set names. */
const NO_LIVE_EXCLUSIONS: ReadonlyMap<string, ExcludeReason> = new Map();

/**
 * The message a guard rejected with, so a test can assert over its whole text
 * rather than a substring — the only way to assert a remedy is ABSENT.
 */
async function refusal(guard: Promise<void>): Promise<string> {
  try {
    await guard;
  } catch (error) {
    return (error as Error).message;
  }
  return 'the guard resolved instead of refusing';
}

describe('assertE2eModelsPresent', () => {
  // The premium leg grades a release date against a clock, so the guard reads
  // one; without a frozen clock every fixture's verdict would move with the day
  // the suite happens to run on.
  beforeEach(() => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when every id is present, exposed, and in its strict family', async () => {
    await expect(
      assertE2eModelsPresent(fakeDb(validRows()), NO_LIVE_EXCLUSIONS)
    ).resolves.toBeUndefined();
  });

  it('reads only sellable rows, so a soft-deleted or kill-switched id cannot pass', async () => {
    await assertE2eModelsPresent(fakeDb(validRows()), NO_LIVE_EXCLUSIONS);
    // Asserted whole, not by substring: `or(...)` renders both of these null
    // checks too, and a disjunction would admit a soft-deleted row whose kill
    // switch happens to be clear — the exact regression this guard exists to
    // catch. Only the connective distinguishes them.
    expect(lastWhereSql).toBe(
      '("model_catalog"."excluded_reason" is null and "model_catalog"."admin_disabled_at" is null)'
    );
  });

  it('throws when an id is absent from the catalog', async () => {
    const rows = validRows().filter((row) => row.modelId !== E2E_MODELS.text[0]);
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'is not sellable in the live OpenRouter catalog'
    );
  });

  it('raises one failure per declared id, so a modality declaring none raises none', async () => {
    // The empty-catalog case is what makes an empty bucket observable: the guard
    // loops over what each bucket declares, and video declares nothing.
    const failure = await assertE2eModelsPresent(fakeDb([]), NO_LIVE_EXCLUSIONS).then(
      () => 'the guard resolved on an empty catalog',
      (error: unknown) => (error as Error).message
    );
    expect(failure.split('\n')).toEqual([
      expect.stringContaining(E2E_MODELS.text[0]),
      expect.stringContaining(E2E_MODELS.text[1]),
      expect.stringContaining(E2E_MODELS.image[0]),
      expect.stringContaining(PRESENCE_ONLY_MODELS.primary),
      expect.stringContaining(PRESENCE_ONLY_MODELS.secondary),
      expect.stringContaining(HOLD_PROBE_MODEL_ID),
      // The one refusal no declared id draws: a catalog selling nothing leaves
      // the free tier nothing to send on either, and that is its own claim.
      expect.stringContaining('the free tier cannot send'),
    ]);
  });

  it('names the live exclusion reason when the refresh discovered the id and turned it down', async () => {
    const missing = E2E_MODELS.text[0];
    const rows = validRows().filter((row) => row.modelId !== missing);
    const excluded: ReadonlyMap<string, ExcludeReason> = new Map([[missing, 'non-zdr']]);
    await expect(assertE2eModelsPresent(fakeDb(rows), excluded)).rejects.toThrow(
      `e2e model '${missing}' was discovered by the catalog refresh and excluded as 'non-zdr'`
    );
  });

  it('does not blame the refresh when it excluded the id', async () => {
    const missing = E2E_MODELS.text[0];
    const rows = validRows().filter((row) => row.modelId !== missing);
    const excluded: ReadonlyMap<string, ExcludeReason> = new Map([[missing, 'non-zdr']]);
    await expect(assertE2eModelsPresent(fakeDb(rows), excluded)).rejects.not.toThrow(
      'the catalog refresh failed'
    );
  });

  it('throws when a stored descriptor fails its contract', async () => {
    const rows = validRows();
    rows[0] = { modelId: E2E_MODELS.text[0], descriptor: { not: 'a descriptor' } };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'has a stored descriptor that fails its contract'
    );
  });

  it('throws when a model is not ZDR-reachable', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['text'], zdrReachable: false }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'present but NOT exposed'
    );
  });

  it('throws when a model has empty pricing', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['text'], pricing: {} }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'fails its contract'
    );
  });

  it('throws when a model classifies to the embedding call shape', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['embedding'] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'present but NOT exposed'
    );
  });

  it('throws when a model has no classifiable call shape', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: [] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'present but NOT exposed'
    );
  });

  it('throws when a model produces text alongside another modality', async () => {
    const rows = validRows();
    // A dual text/image model classifies to the language family, so the bucket
    // check passes it; only the runnable-shape leg refuses it. The send path
    // cannot run it, so the tooling must not hand it to a test.
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['text', 'image'] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'present but NOT exposed'
    );
  });

  it('throws when a model does not accept text input', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['text'], inputs: ['image'] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'present but NOT exposed'
    );
  });

  it('throws when a declared text model cannot turn its reasoning off', async () => {
    // The turn-shape helper pins the off rung; a mandatory-reasoning model
    // presents no such row, and the helper throws mid-spec instead.
    await expect(
      assertE2eModelsPresent(
        fakeDb(textRows({ reasoning: { mandatory: true } })),
        NO_LIVE_EXCLUSIONS
      )
    ).rejects.toThrow('presents no reasoning-off rung');
  });

  it('throws when a declared text model has no reasoning metadata at all', async () => {
    await expect(
      assertE2eModelsPresent(fakeDb(textRows({ reasoning: undefined })), NO_LIVE_EXCLUSIONS)
    ).rejects.toThrow('presents no reasoning-off rung');
  });

  it('throws when a declared text model caps output below what the pinned effort rung needs', async () => {
    // The rung's reasoning budget plus a minimum answer outruns a 32,768-token
    // output cap, so the effort menu greys that rung for the pair.
    const message = await refusal(
      assertE2eModelsPresent(
        fakeDb(textRows({ limits: { contextLength: 262_144, maxOutputTokens: 32_768 } })),
        NO_LIVE_EXCLUSIONS
      )
    );
    expect(message).toContain(E2E_MODELS.text[0]);
    expect(message).toContain(`'${E2E_TEXT_PINNED_EFFORT}' reasoning-effort rung`);
  });

  it('names the refusal the turn producer gives for the pinned effort rung', async () => {
    const message = await refusal(
      assertE2eModelsPresent(
        fakeDb(textRows({ limits: { contextLength: 262_144, maxOutputTokens: 32_768 } })),
        NO_LIVE_EXCLUSIONS
      )
    );
    expect(message).toContain("'model_output_cap_too_low'");
  });

  it('admits a declared text model whose output cap leaves room for the pinned effort rung', async () => {
    await expect(
      assertE2eModelsPresent(
        fakeDb(textRows({ limits: { contextLength: 262_144, maxOutputTokens: 235_929 } })),
        NO_LIVE_EXCLUSIONS
      )
    ).resolves.toBeUndefined();
  });

  it('throws when neither declared text model offers the pinned effort rung at all', async () => {
    // Every enumerated effort ladder carries the high rung, so only a pair with
    // no reasoning metadata leaves the producer nothing to present for it.
    const rows = validRows().map((row) =>
      TEXT_IDS.has(row.modelId)
        ? {
            modelId: row.modelId,
            descriptor: descriptor({
              id: row.modelId,
              outputs: ['text'],
              ...SELECTABLE_TEXT_FIELDS,
              reasoning: undefined,
            }),
          }
        : row
    );
    const message = await refusal(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS));
    expect(message).toContain(
      `the turn producer does not offer the '${E2E_TEXT_PINNED_EFFORT}' reasoning-effort rung`
    );
  });

  it('throws when a declared text model is premium, which a free-tier payer cannot select', async () => {
    // Released inside the premium recency window: premium on recency alone,
    // whatever it costs.
    await expect(
      assertE2eModelsPresent(
        fakeDb(textRows({ releasedAt: secondsAt(TEST_DAY_START) })),
        NO_LIVE_EXCLUSIONS
      )
    ).rejects.toThrow('is premium');
  });

  it('names the payer the premium refusal blocks, not the price it was picked for', async () => {
    const message = await refusal(
      assertE2eModelsPresent(
        fakeDb(textRows({ releasedAt: secondsAt(TEST_DAY_START) })),
        NO_LIVE_EXCLUSIONS
      )
    );
    expect(message).toContain('zero purchased balance');
  });

  it('throws when a declared text model prices into the pool premium quartile', async () => {
    // The other premium leg: an old model can still be premium on price alone.
    // Dear pool members put the threshold at the dear rate, so the declared id
    // matching it is premium and the cheap declared id is not.
    const dear = { kind: 'tokens', anchor: { base: { input: '1000', output: '1000' }, tiers: [] } };
    const rows = textRows({ pricing: dear });
    rows.push(
      ...[0, 1, 2].map((index) => ({
        modelId: `pool/dear-${String(index)}`,
        descriptor: descriptor({
          id: `pool/dear-${String(index)}`,
          outputs: ['text'],
          ...SELECTABLE_TEXT_FIELDS,
          pricing: dear,
        }),
      }))
    );
    const message = await refusal(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS));
    expect(message).toContain(`e2e model '${E2E_MODELS.text[0]}' is premium`);
    expect(message).not.toContain(E2E_MODELS.text[1]);
  });

  it("throws when a declared text model's minimal exchange costs more than the per-message cap", async () => {
    // The leg that is neither price-percentile nor recency: a model cheap
    // against its pool and long released can still price a minimal exchange
    // above the free tier's per-message ceiling, and the picker refuses it for
    // that alone. Output-heavy rates put it over the ceiling while three far
    // dearer pool members hold the percentile above its combined rate, so no
    // other premium leg can account for the refusal.
    const rows = textRows({
      pricing: { kind: 'tokens', anchor: { base: { input: '1', output: '6000' }, tiers: [] } },
    });
    rows.push(
      ...[0, 1, 2].map((index) => ({
        modelId: `pool/dear-${String(index)}`,
        descriptor: descriptor({
          id: `pool/dear-${String(index)}`,
          outputs: ['text'],
          ...SELECTABLE_TEXT_FIELDS,
          pricing: {
            kind: 'tokens',
            anchor: { base: { input: '500000', output: '500000' }, tiers: [] },
          },
        }),
      }))
    );
    const message = await refusal(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS));
    expect(message).toContain(`e2e model '${E2E_MODELS.text[0]}' is premium`);
    expect(message).not.toContain(E2E_MODELS.text[1]);
  });

  it('throws when a declared text model carries no per-token rates to grade', async () => {
    // Exposed (priced per image) but unpriceable by tokens, so the money layer
    // projects nothing for it. The product's gate is fail-closed on exactly that
    // and refuses it, rather than admitting a model it cannot grade.
    const message = await refusal(
      assertE2eModelsPresent(
        fakeDb(textRows({ pricing: { kind: 'perImage', anchor: '1', dearest: '1' } })),
        NO_LIVE_EXCLUSIONS
      )
    );
    expect(message).toContain(`e2e model '${E2E_MODELS.text[0]}' is premium`);
    expect(message).not.toContain(E2E_MODELS.text[1]);
  });

  it('leaves a row the gateway stopped offering out of the pool the premium verdict is taken over', async () => {
    // The unsighted rows are sellable, so the guard's own read keeps them:
    // only the product's read drops a row the gateway has not offered for a
    // day, and the pool is the product's. They are dear enough to put the
    // threshold at the declared model's own combined rate, so counting them
    // would mark it premium and the guard would refuse.
    const rows = textRows({
      pricing: { kind: 'tokens', anchor: { base: { input: '1000', output: '1000' }, tiers: [] } },
    });
    rows.push(
      ...[0, 1, 2].map((index) => ({
        modelId: `pool/unsighted-${String(index)}`,
        descriptor: descriptor({
          id: `pool/unsighted-${String(index)}`,
          outputs: ['text'],
          ...SELECTABLE_TEXT_FIELDS,
          pricing: {
            kind: 'tokens',
            anchor: { base: { input: '1000', output: '1000' }, tiers: [] },
          },
        }),
        lastSeenAt: new Date(TEST_DAY_START - 25 * HOUR_MS),
      }))
    );
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).resolves.toBeUndefined();
  });

  it('refuses a declared text model the product judges cannot answer a text turn', async () => {
    // Exposed, priceable and reasoning-capable, but its one output is an image.
    // The bucket leg names the family mismatch; this is the product's own gate
    // saying the same row cannot answer the turn a spec sends it.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(textRows({ outputs: ['image'] })), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toContain(`e2e model '${E2E_MODELS.text[0]}' does not answer a text turn`);
  });

  it('refuses the whole catalog when the product declines to read it', async () => {
    // A row stamped with a descriptor version the product will not price makes
    // its catalog read refuse outright. Nothing can be graded against a catalog
    // that never resolved, so the guard says which read refused rather than
    // reporting every declared id as ungraded.
    const rows = validRows();
    rows.push({
      modelId: 'pool/prior-version',
      descriptor: descriptor({ id: 'pool/prior-version', outputs: ['text'], version: 'prior' }),
    });
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      "the product's catalog read refused this catalog"
    );
  });

  it('refuses a declared text model whose sellable row the product no longer returns', async () => {
    // The retirement state, and nothing else: the row is present, carries no
    // exclusion reason and no admin-disable stamp, and its descriptor is the
    // same exposed one every other case uses. Only its sighting is old.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(unsightedRows(E2E_MODELS.text[0])), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toContain(
      `e2e model '${E2E_MODELS.text[0]}' is sellable but the product's catalog read no longer returns it`
    );
  });

  it('blames the sighting window, not one of the sellability causes', async () => {
    // The sellability refusal offers absence, soft-deletion and admin-disabling,
    // and none of the three is true here — a reader sent to check them debugs a
    // healthy catalog.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(unsightedRows(E2E_MODELS.text[0])), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toContain('unsighted past');
    expect(message).not.toContain('is not sellable in the live OpenRouter catalog');
  });

  it('reports a declared id the exposure read drops exactly once', async () => {
    // The text turn-shape legs grade from that same read, so the dropped id is
    // also the one they find nothing to grade. One answer, not two.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(unsightedRows(E2E_MODELS.text[0])), NO_LIVE_EXCLUSIONS)
    );
    expect(message.split('\n')).toEqual([expect.stringContaining(E2E_MODELS.text[0])]);
  });

  it('leaves a row a presence leg already condemned to that one refusal', async () => {
    // Unexposed AND unsighted at once. The presence leg names the cause that
    // actually happened; a second line blaming the sighting window would be
    // both redundant and untrue of why the row is hidden.
    const rows = unsightedRows(E2E_MODELS.text[0]).map((row) =>
      row.modelId === E2E_MODELS.text[0]
        ? {
            modelId: row.modelId,
            lastSeenAt: UNSIGHTED_AT,
            descriptor: descriptor({
              id: E2E_MODELS.text[0],
              outputs: ['text'],
              ...SELECTABLE_TEXT_FIELDS,
              zdrReachable: false,
            }),
          }
        : row
    );
    const message = await refusal(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS));
    expect(message.split('\n')).toEqual([expect.stringContaining('present but NOT exposed')]);
  });

  it('sends a retired presence-only id to its own declaration', async () => {
    const message = await refusal(
      assertE2eModelsPresent(
        fakeDb(unsightedRows(PRESENCE_ONLY_MODELS.primary)),
        NO_LIVE_EXCLUSIONS
      )
    );
    expect(message).toContain(
      `e2e model '${PRESENCE_ONLY_MODELS.primary}' is sellable but the product's catalog read no longer returns it`
    );
    expect(message).toContain('retire it from PRESENCE_ONLY_MODELS');
  });

  it('admits a declared model last sighted inside the freshness window', async () => {
    // The positive control the refusals need: a stamp that is not the fixture
    // default and still inside the window resolves, so the leg is bounded by
    // the window rather than firing for any row it did not stamp itself.
    const rows = validRows().map((row) =>
      row.modelId === E2E_MODELS.text[0]
        ? {
            modelId: row.modelId,
            descriptor: row.descriptor,
            lastSeenAt: new Date(TEST_DAY_START - 23 * HOUR_MS),
          }
        : row
    );
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).resolves.toBeUndefined();
  });

  it('throws when an id declared for presence only is absent from the catalog', async () => {
    const rows = validRows().filter((row) => row.modelId !== PRESENCE_ONLY_MODELS.primary);
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      `e2e model '${PRESENCE_ONLY_MODELS.primary}' is not sellable`
    );
  });

  it('sends a retired presence-only id to its own declaration, not the text set', async () => {
    // The remedy has to name the constant the reader edits. Folding one of
    // these ids into E2E_MODELS would satisfy the presence question and break
    // the turn-shape legs, so a refusal that pointed there would be advising
    // the one change that must not be made.
    const rows = validRows().filter((row) => row.modelId !== PRESENCE_ONLY_MODELS.primary);
    const message = await refusal(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS));
    expect(message).toContain('update PRESENCE_ONLY_MODELS');
    expect(message).not.toContain('E2E_MODELS');
  });

  it('throws when an id declared for presence only is not exposed', async () => {
    await expect(
      assertE2eModelsPresent(fakeDb(presenceRows({ zdrReachable: false })), NO_LIVE_EXCLUSIONS)
    ).rejects.toThrow(`e2e model '${PRESENCE_ONLY_MODELS.primary}' is present but NOT exposed`);
  });

  it('throws when an id declared for presence only is not language-family', async () => {
    // Every site naming one stamps it on, or selects it for, a text turn.
    await expect(
      assertE2eModelsPresent(fakeDb(presenceRows({ outputs: ['image'] })), NO_LIVE_EXCLUSIONS)
    ).rejects.toThrow('the send path requires a strict-family match');
  });

  it('admits an id declared for presence only whose reasoning is mandatory', async () => {
    // The off rung is what the turn-shape helper pins, and no site that names
    // one of these ids pins a rung — so holding them to it would retire live
    // catalog ids for a property nothing reads.
    await expect(
      assertE2eModelsPresent(
        fakeDb(presenceRows({ reasoning: { mandatory: true } })),
        NO_LIVE_EXCLUSIONS
      )
    ).resolves.toBeUndefined();
  });

  it('admits an id declared for presence only that prices into the pool premium quartile', async () => {
    // Dear enough to put the threshold at its own rate, leaving the declared
    // text ids basic: the premium leg fires for this row and the guard admits
    // it anyway. No site naming one of these ids selects it as a payer at a
    // zero purchased balance, which is the only payer a premium row refuses.
    const dear = { kind: 'tokens', anchor: { base: { input: '1000', output: '1000' }, tiers: [] } };
    await expect(
      assertE2eModelsPresent(
        fakeDb(presenceRows({ ...SELECTABLE_TEXT_FIELDS, pricing: dear })),
        NO_LIVE_EXCLUSIONS
      )
    ).resolves.toBeUndefined();
  });

  it('throws when the hold-probe model holds no more than twice the paid cushion', async () => {
    // The pin the spec makes is half the hold less that cushion, so a hold at or
    // below twice it lands the payer at or under zero and the scarcity the spec
    // needs is unreachable. The undersized probe holds 150,399,236, far short.
    await expect(
      assertE2eModelsPresent(fakeDb(holdProbeRows(UNDERSIZED_HOLD_PROBE)), NO_LIVE_EXCLUSIONS)
    ).rejects.toThrow('holds too little');
  });

  it('quotes the measured hold as a figure when the model can be priced', async () => {
    // A reader meets this refusal at a stopped preparation gate, so the figure and
    // its unit have to land as one phrase rather than as a substitution that only
    // reads as a quantity on one of the two arms.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(holdProbeRows(UNDERSIZED_HOLD_PROBE)), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toMatch(/one turn on it reserves \d+ nano-USD\./);
  });

  it('sends an undersized hold-probe refusal to its own declaration', async () => {
    // The remedy names the constant a reader edits. Pointing at E2E_MODELS would
    // advise the one move that breaks the set it moves into.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(holdProbeRows(UNDERSIZED_HOLD_PROBE)), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toContain('HOLD_PROBE_MODEL_ID');
    expect(message).not.toContain('E2E_MODELS');
  });

  it('throws when the hold-probe model carries no per-token rates to price a hold from', async () => {
    // Exposed — priced per image — but unpriceable by tokens, so the turn producer
    // draws no pool member for it and sizes no hold at all. Fail-closed: a model
    // nothing can price is not one the spec can measure.
    const message = await refusal(
      assertE2eModelsPresent(
        fakeDb(holdProbeRows({ pricing: { kind: 'perImage', anchor: '1', dearest: '1' } })),
        NO_LIVE_EXCLUSIONS
      )
    );
    expect(message).toContain('holds too little');
    expect(message).toContain('can price no hold for it at all');
    expect(message).not.toMatch(/reserves \d/);
  });

  it('throws when the hold-probe id is absent from the catalog', async () => {
    const rows = validRows().filter((row) => row.modelId !== HOLD_PROBE_MODEL_ID);
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      `e2e model '${HOLD_PROBE_MODEL_ID}' is not sellable`
    );
  });

  it('sends a retired hold-probe id to its own declaration', async () => {
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(unsightedRows(HOLD_PROBE_MODEL_ID)), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toContain(
      `e2e model '${HOLD_PROBE_MODEL_ID}' is sellable but the product's catalog read no longer returns it`
    );
    expect(message).toContain('retire it from HOLD_PROBE_MODEL_ID');
  });

  it('admits a hold-probe id whose reasoning is mandatory', async () => {
    // The off rung is what the text turn-shape helper pins, and the hold-probe
    // spec pins no rung — it needs the opposite, a turn that reasons at all.
    await expect(
      assertE2eModelsPresent(fakeDb(validRows()), NO_LIVE_EXCLUSIONS)
    ).resolves.toBeUndefined();
  });

  it('admits a hold-probe id the product classifies as premium', async () => {
    // Released inside the premium recency window, so premium whatever it costs.
    // The payer this spec sends as holds a purchased balance, which is the only
    // payer a premium row is refused to.
    await expect(
      assertE2eModelsPresent(
        fakeDb(holdProbeRows({ releasedAt: secondsAt(TEST_DAY_START) })),
        NO_LIVE_EXCLUSIONS
      )
    ).resolves.toBeUndefined();
  });

  it('throws when one day of free allowance buys no turn the default selection would run', async () => {
    // Every pooled row repriced past the allowance, which is the catalog-wide
    // condition the free tier goes dark under. The declared text ids draw their
    // own turn-shape refusal at these rates too, so the free-tier leg is read
    // off its own wording rather than off being the only refusal.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(pooledRows(UNAFFORDABLE_RATES)), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toContain('the free tier cannot send');
    expect(message).toContain('The affordability leg is what failed');
  });

  it('quotes the daily allowance and the funding refusal when the catalog outruns it', async () => {
    // A reader meets this at a stopped preparation gate with no catalog in
    // front of them: the figure the comparison was made against and the
    // producer's own verdict are the whole of what tells them the free tier,
    // rather than a declared id, is what broke.
    const message = await refusal(
      assertE2eModelsPresent(fakeDb(pooledRows(UNAFFORDABLE_RATES)), NO_LIVE_EXCLUSIONS)
    );
    expect(message).toContain(`${freeDailyAllowanceNanoUsd().toString()} nano-USD`);
    expect(message).toContain("'insufficient_funds'");
  });

  it('throws on the selectability leg when every model on offer is premium here', async () => {
    // Released inside the premium recency window, so the whole pool is premium
    // and the free tier's own gate refuses it before any rate is weighed. The
    // money leg's wording would send the reader to look at prices that are fine.
    const message = await refusal(
      assertE2eModelsPresent(
        fakeDb(pooledRows({ releasedAt: secondsAt(TEST_DAY_START) })),
        NO_LIVE_EXCLUSIONS
      )
    );
    expect(message).toContain('nothing affordable is selectable');
    expect(message).toContain("'premium_requires_credit'");
    expect(message).not.toContain('The affordability leg');
  });

  it('throws when an exposed model is in the wrong bucket for its family', async () => {
    const rows = validRows();
    // A strict-image model sitting in the text bucket: exposed, but classifies
    // as 'image', not the required 'language'.
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['image'] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows), NO_LIVE_EXCLUSIONS)).rejects.toThrow(
      'the send path requires a strict-family match'
    );
  });
});

// The seed injects a second, synthetic strict-image model AFTER `catalog:refresh`
// (`E2E_SEEDED_IMAGE_MODEL_ID`), so the E2E catalog carries >=2 distinct exposed
// strict-image ids for a genuine image fan-out. This post-seed guard asserts the
// injected row landed and is exposed + strict-image — the pre-seed
// `assertE2eModelsPresent` cannot cover it because a synthetic id is (by design)
// absent from the live catalog it validates against.
describe('assertSeededImageModelPresent', () => {
  function seededRow(overrides: Record<string, unknown> = {}): FixtureRow {
    return {
      modelId: E2E_SEEDED_IMAGE_MODEL_ID,
      descriptor: descriptor({ id: E2E_SEEDED_IMAGE_MODEL_ID, outputs: ['image'], ...overrides }),
    };
  }

  it('resolves when the seeded strict-image row is present and exposed', async () => {
    await expect(assertSeededImageModelPresent(fakeDb([seededRow()]))).resolves.toBeUndefined();
  });

  it('blames the seed when the seeded row is absent', async () => {
    await expect(assertSeededImageModelPresent(fakeDb([]))).rejects.toThrow(
      `seeded e2e model '${E2E_SEEDED_IMAGE_MODEL_ID}' has no sellable model_catalog row`
    );
  });

  it('offers the absent seeded row no remedy it cannot take', async () => {
    // Both remedies the live guard names are impossible for a synthetic id: it
    // is never in the gateway's catalog, and `model-ids.ts` requires it to
    // stay out of `E2E_MODELS`.
    const message = await refusal(assertSeededImageModelPresent(fakeDb([])));
    expect(message).not.toContain('live OpenRouter catalog');
    expect(message).not.toContain('E2E_MODELS');
  });

  it('throws when the seeded row is not strict-image', async () => {
    await expect(
      assertSeededImageModelPresent(fakeDb([seededRow({ outputs: ['text'] })]))
    ).rejects.toThrow('the send path requires a strict-family match');
  });
});

// The video half of the same post-seed guard. Unlike image, video has no live
// partner at all — no gateway video model is ZDR-reachable — so BOTH members of
// the fan-out's pair are seeded rows and both have to land.
describe('assertSeededVideoModelsPresent', () => {
  function seededRow(modelId: string, overrides: Record<string, unknown> = {}): FixtureRow {
    return {
      modelId,
      descriptor: descriptor({ id: modelId, outputs: ['video'], ...overrides }),
    };
  }

  function allSeededRows(): FixtureRow[] {
    return E2E_SEEDED_VIDEO_MODEL_IDS.map((modelId) => seededRow(modelId));
  }

  it('resolves when every seeded strict-video row is present and exposed', async () => {
    await expect(assertSeededVideoModelsPresent(fakeDb(allSeededRows()))).resolves.toBeUndefined();
  });

  it('blames the seed when one of the seeded rows is absent', async () => {
    const missing = E2E_SEEDED_VIDEO_MODEL_IDS[1];
    const rows = allSeededRows().filter((row) => row.modelId !== missing);
    await expect(assertSeededVideoModelsPresent(fakeDb(rows))).rejects.toThrow(
      `seeded e2e model '${missing}' has no sellable model_catalog row`
    );
  });

  it('throws when a seeded row is not strict-video', async () => {
    const rows = allSeededRows();
    rows[0] = seededRow(E2E_SEEDED_VIDEO_MODEL_IDS[0], { outputs: ['image'] });
    await expect(assertSeededVideoModelsPresent(fakeDb(rows))).rejects.toThrow(
      'the send path requires a strict-family match'
    );
  });

  it('throws when a seeded row is not ZDR-reachable', async () => {
    const rows = allSeededRows();
    rows[0] = seededRow(E2E_SEEDED_VIDEO_MODEL_IDS[0], { zdrReachable: false });
    await expect(assertSeededVideoModelsPresent(fakeDb(rows))).rejects.toThrow(
      'present but NOT exposed'
    );
  });
});

// One validator serves both guards, so the hazard the split introduces is that
// it starts answering for both with one message. Driven rather than reasoned
// about: the two guards run over the same empty catalog, and their refusals are
// compared.
describe('the absent-row branch shared by both guards', () => {
  it('does not answer for both guards with one message', async () => {
    const live = await refusal(assertE2eModelsPresent(fakeDb([]), NO_LIVE_EXCLUSIONS));
    const seeded = await refusal(assertSeededImageModelPresent(fakeDb([])));
    expect(live).toContain('is not sellable in the live OpenRouter catalog');
    expect(seeded).not.toContain('is not sellable in the live OpenRouter catalog');
  });
});
