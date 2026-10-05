/**
 * Every row the core publishes carries the money-free answer room the published
 * `answerRoomTokens` computes for the same model and prompt, and a ceiling no
 * larger than it. A surface tells whether the balance is what limits an answer
 * by comparing the room with each ceiling the row publishes, the graded one and
 * any per rung, so a room computed differently from the one the server sizes a
 * turn with would blame the balance for a limit it did not set.
 *
 * Pinned on `evaluateTurn` rather than on the producer above it, so it binds
 * both option sets: `getTurnOptions` is this one core at two (funding, basis)
 * pairs.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { USER_TIERS } from '../money/tiers.ts';
import { inputTokensOf } from '../price/quantities.ts';
import { answerRoomTokens } from './answer-room.ts';
import { evaluateTurn } from './turn-core.ts';
import { promptCharsOf } from './turn-types.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { ModelEntry, OptionSet, PromptBasis, Selection } from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

/** An id no catalogue prices, which is what puts a `model_not_priceable` row in a set. */
const GHOST_ID = modelId('vendor/unpriced');

/**
 * Rows that reach each term of the ceiling: a wide one the balance usually
 * binds, a capped one its provider limit binds, and a narrow one a long prompt
 * overruns, so the room's context leg is reached as well as its cap leg.
 */
const CATALOG: readonly PriceableModel[] = [
  {
    modelId: modelId('vendor/wide'),
    pricing: tokenPricingFixture({ input: nanoUSD(60n), output: nanoUSD(150n) }),
    contextLength: 200_000,
    providerCap: 64_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: modelId('vendor/capped'),
    pricing: tokenPricingFixture({ input: nanoUSD(300n), output: nanoUSD(700n) }),
    contextLength: 128_000,
    providerCap: 4000,
    releasedAtMs: 0,
    reasoning: undefined,
  },
  {
    modelId: modelId('vendor/narrow'),
    pricing: tokenPricingFixture({ input: nanoUSD(400n), output: nanoUSD(900n) }),
    contextLength: 6000,
    providerCap: 5000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: null },
  },
  {
    modelId: modelId('vendor/dear'),
    pricing: tokenPricingFixture({ input: nanoUSD(40_000n), output: nanoUSD(120_000n) }),
    contextLength: 128_000,
    providerCap: 32_000,
    releasedAtMs: 0,
    reasoning: undefined,
  },
];

const MODEL_IDS = CATALOG.map((model) => model.modelId);

/** A prompt from empty to long enough to overrun the narrow row's context. */
const bases: fc.Arbitrary<PromptBasis> = fc.record({
  systemChars: fc.integer({ min: 0, max: 2000 }),
  instructionChars: fc.integer({ min: 0, max: 1000 }),
  historyChars: fc.integer({ min: 0, max: 30_000 }),
  inputChars: fc.integer({ min: 0, max: 4000 }),
  attachmentBytes: fc.constant(0),
});

/** A selection with the Smart slot on or off, pinned rows, a ghost row, search and a pin. */
const selections: fc.Arbitrary<Selection> = fc
  .record({
    pool: fc.subarray(MODEL_IDS, { maxLength: 2 }),
    smartSlot: fc.boolean(),
    ghost: fc.boolean(),
    pin: fc.constantFrom(undefined, 'off', 'low', 'high'),
    webSearch: fc.boolean(),
  })
  .map(({ pool, smartSlot, ghost, pin, webSearch }): Selection => {
    const models = ghost ? [...pool, GHOST_ID] : pool;
    const [first, ...rest] = models;
    return {
      answerSources:
        smartSlot || first === undefined
          ? { models, smartSlot: true }
          : { models: [first, ...rest], smartSlot: false },
      modality: 'text',
      pinned: pin === undefined ? {} : { effort: pin },
      webSearch,
      effortAuto: pin === undefined,
    };
  });

/**
 * Funding from nothing to 40,000,000,000 nano: some draws leave a row at its
 * whole room and others leave it held by the balance, as the counters require.
 */
const fundings: fc.Arbitrary<bigint> = fc.bigInt({ min: 0n, max: 40_000_000_000n });

const tiers = fc.constantFrom(...USER_TIERS);

const passes = fc.constantFrom('affordable' as const, 'admissible' as const);

function entriesOf(set: OptionSet): readonly ModelEntry[] {
  return set.sendable ? [...set.all, ...set.runnable] : set.all;
}

/** The room the published door computes for a row's model, 0 for a row nothing prices. */
function expectedRoom(entry: ModelEntry, basis: PromptBasis): number {
  const model = CATALOG.find((candidate) => candidate.modelId === entry.modelId);
  return model === undefined ? 0 : answerRoomTokens(model, inputTokensOf(promptCharsOf(basis)));
}

describe('the answer room a row publishes', () => {
  it('equals the published answer room for the same model and prompt, at or above the ceiling', () => {
    let balanceBound = 0;
    let roomBound = 0;
    let contextBound = 0;
    fc.assert(
      fc.property(
        fc.record({
          funding: fundings,
          tier: tiers,
          basis: bases,
          selection: selections,
          pass: passes,
        }),
        ({ funding, tier, basis, selection, pass }) => {
          const { optionSet } = evaluateTurn({
            fundingNanoUsd: funding,
            basis,
            selection,
            catalog: CATALOG,
            tier,
            nowMs: NOW_MS,
            pass,
          });
          for (const entry of entriesOf(optionSet)) {
            const room = expectedRoom(entry, basis);
            expect(entry.answerRoomTokens).toBe(room);
            expect(entry.ceilingTokens).toBeLessThanOrEqual(entry.answerRoomTokens);
            if (entry.ceilingTokens < room) balanceBound += 1;
            if (room > 0 && entry.ceilingTokens === room) roomBound += 1;
            const cap = CATALOG.find(
              (candidate) => candidate.modelId === entry.modelId
            )?.providerCap;
            if (cap !== undefined && room < cap) contextBound += 1;
          }
        }
      )
    );
    // A sweep that never saw a ceiling below its room, or never one at it, or
    // never a room the context set, would hold while constraining one term only.
    expect(balanceBound).toBeGreaterThan(100);
    expect(roomBound).toBeGreaterThan(100);
    expect(contextBound).toBeGreaterThan(100);
  });
});
