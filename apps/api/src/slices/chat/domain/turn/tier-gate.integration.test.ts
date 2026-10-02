import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { listDescriptors } from '../../../models/index.js';
import { tierGateVerdict } from './tier-gate.js';
import type { TierGateBody } from './tier-gate.js';
import type { FundingDecisionInputs } from './context.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for turn-tier-gate integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

/**
 * The reference clock the premium classification is judged against. A frozen
 * instant, not the wall clock: the fixture below is premium on the RECENCY leg,
 * which is a comparison between the two.
 */
const NOW_MS = TEST_DAY_START;

/** A model released at the reference instant — inside the premium recency window. */
const RECENT_MODEL = `chat-tier-gate/${crypto.randomUUID().slice(0, 8)}`;
/** A model id no catalog row carries, so no selected model classifies as premium. */
const ABSENT_MODEL = `chat-tier-gate/${crypto.randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [RECENT_MODEL]));
  await db.$client.end();
});

async function seedRecentModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: RECENT_MODEL,
      descriptor: {
        id: RECENT_MODEL,
        provider: 'p',
        version: '3',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: {
          kind: 'tokens',
          anchor: { base: { input: '2500', output: '10000' }, tiers: [] },
        },
        zdrReachable: true,
        releasedAt: Math.floor(NOW_MS / 1000),
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

/**
 * The catalog as production hands it to the gate: read through the same seam
 * the gated resolution reads it through, over the rows this file seeded, so the
 * classification below is judged against persisted rows rather than a
 * hand-built descriptor list.
 */
async function liveCatalog(): Promise<readonly ModelDescriptor[]> {
  const read = await listDescriptors({ db, telemetry: silentTelemetry });
  return read._unsafeUnwrap();
}

/**
 * A snapshot that locks the seeded model — the same catalog the refusing case
 * is judged against.
 *
 * For an arm asserting `allowed`, this snapshot is EVIDENCE about where the
 * gate returned only where the arm keeps BOTH halves of that refusing case: it
 * pins the seeded model, and it carries a funding shape the core can answer
 * `MODEL_TIER_LOCKED` for. Such an arm differs from the refusal in one
 * property, so `allowed` isolates that property and can only mean the gate
 * returned before classification.
 *
 * An arm that gives up either half reads `allowed` at classification too, and
 * so gets no such evidence: one pinning no model leaves classification nothing
 * to judge, and a funding shape the core cannot refuse as `MODEL_TIER_LOCKED`
 * — the tier reaches the core only down its self-funding branch — answers
 * `allowed` whatever the model's tier. For those arms the assertion is the
 * OUTCOME, that this shape is never tier-locked, and it says nothing about
 * where the gate returned.
 *
 * Such an arm is handed this snapshot anyway, because seeding and then reading
 * makes the read deterministic whatever order the cases run in.
 */
async function lockingCatalog(): Promise<readonly ModelDescriptor[]> {
  await seedRecentModel();
  return liveCatalog();
}

/** A caller funding the turn themselves with nothing purchased — the gated shape. */
const SELF_FUNDED_NO_BALANCE: FundingDecisionInputs = {
  isSolo: true,
  isGuest: false,
  memberRemainingNanoUsd: 0n,
  conversationRemainingNanoUsd: 0n,
  ownerPurchasedBalanceNanoUsd: 0n,
  callerOwnPurchasedBalanceNanoUsd: 0n,
  minTurnCostNanoUsd: undefined,
};

function pins(id: string): TierGateBody {
  return { turnSources: [{ kind: 'model', id }] };
}

describe('the premium-tier gate answers a verdict, off the wire', () => {
  it('locks a recently released model for a self-funding caller with no balance', async () => {
    const verdict = tierGateVerdict(
      await lockingCatalog(),
      pins(RECENT_MODEL),
      SELF_FUNDED_NO_BALANCE,
      NOW_MS
    );
    expect(verdict).toBe('tier-locked');
  });

  it('allows an image turn, which is out of the gate scope', async () => {
    const verdict = tierGateVerdict(
      await lockingCatalog(),
      { ...pins(RECENT_MODEL), modality: 'image' },
      SELF_FUNDED_NO_BALANCE,
      NOW_MS
    );
    expect(verdict).toBe('allowed');
  });

  it('allows a video turn, which is out of the gate scope', async () => {
    const verdict = tierGateVerdict(
      await lockingCatalog(),
      { ...pins(RECENT_MODEL), modality: 'video' },
      SELF_FUNDED_NO_BALANCE,
      NOW_MS
    );
    expect(verdict).toBe('allowed');
  });

  it('allows a turn whose only answer source is the Smart slot', async () => {
    const verdict = tierGateVerdict(
      await lockingCatalog(),
      { turnSources: [{ kind: 'smart' }] },
      SELF_FUNDED_NO_BALANCE,
      NOW_MS
    );
    expect(verdict).toBe('allowed');
  });

  it('allows an owner-funded group turn, whose payer is not the caller', async () => {
    const verdict = tierGateVerdict(
      await lockingCatalog(),
      pins(RECENT_MODEL),
      {
        ...SELF_FUNDED_NO_BALANCE,
        isSolo: false,
        memberRemainingNanoUsd: 10_000_000_000n,
        conversationRemainingNanoUsd: 10_000_000_000n,
        ownerPurchasedBalanceNanoUsd: 10_000_000_000n,
      },
      NOW_MS
    );
    expect(verdict).toBe('allowed');
  });

  it('allows a caller whose own purchased balance is positive', async () => {
    const verdict = tierGateVerdict(
      await lockingCatalog(),
      pins(RECENT_MODEL),
      { ...SELF_FUNDED_NO_BALANCE, callerOwnPurchasedBalanceNanoUsd: 1n },
      NOW_MS
    );
    expect(verdict).toBe('allowed');
  });

  it('allows a link guest the group headroom cannot fund, whose refusal is not this gate', async () => {
    const verdict = tierGateVerdict(
      await lockingCatalog(),
      pins(RECENT_MODEL),
      { ...SELF_FUNDED_NO_BALANCE, isSolo: false, isGuest: true },
      NOW_MS
    );
    expect(verdict).toBe('allowed');
  });

  it('allows a selection the catalog does not classify as premium', async () => {
    const verdict = tierGateVerdict(
      await liveCatalog(),
      pins(ABSENT_MODEL),
      SELF_FUNDED_NO_BALANCE,
      NOW_MS
    );
    expect(verdict).toBe('allowed');
  });
});
