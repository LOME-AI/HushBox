/**
 * The two `T` clamp orders, compared BY AMOUNT on the saturating-sibling turn.
 *
 * §Sharing one budget across siblings solves the shared token count `T` against
 * the UNCLAMPED summed cost and clamps each sibling afterwards. The money module
 * implements exactly that, and pins its own amounts in
 * `turn-options.shared-ceiling.test.ts`. This server-side solver does not: its
 * fit prices the ALREADY-CLAMPED definition and raises the cap until the priced
 * total meets the funds, so a sibling that saturates its own room releases its
 * unused budget to the others.
 *
 * The orders therefore diverge, and this file exists to state by how much and in
 * which direction rather than to make them agree. It is not the
 * two-implementations-agree cross-check CODE-RULES §One Implementation, Shared
 * bans — the opposite: the assertions fail if the divergence closes silently or
 * changes sign, and either would mean one side moved without the other.
 *
 * The fixture is `turn-options.shared-ceiling.test.ts`'s, deliberately reused
 * down to the rates, the funding and the basis SPLIT, so the amounts on the two
 * sides are the same question asked twice.
 */

import { describe, expect, it } from 'vitest';
import { modelId, nanoUSD } from '@hushbox/shared';
import { getTurnOptions } from '@hushbox/shared/affordability';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { createEstimateRun } from '../../../models/index.js';
import { compileMultiModelTurnOutcome, payerSpendableNanoUsd } from './definition.js';
import type { TurnBudget } from './definition.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { ModelDescriptor, Node } from '@hushbox/shared';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { NanoUSD } from '@hushbox/shared';

/** The run estimator read as its hold's total. */
function createEstimateTotal(
  resolveModel: Parameters<typeof createEstimateRun>[0]
): (definition: WorkflowDefinition) => Result<NanoUSD, DomainError> {
  const reserve = createEstimateRun(resolveModel);
  return (definition) => reserve(definition).map((reservation) => reservation.totalNanoUsd);
}

/**
 * The producer's own parameter types, read off the published export rather than
 * deep-imported: the money module's shapes reach this side through the barrel
 * only, and naming them any other way would mean deep-importing past it.
 */
type FundingSnapshot = Parameters<typeof getTurnOptions>[0];
type PromptBasis = Parameters<typeof getTurnOptions>[1];
type Selection = Parameters<typeof getTurnOptions>[2];
type PriceableModel = Parameters<typeof getTurnOptions>[3]['models'][number];

const NOW_MS = TEST_DAY_START;

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);
const TIGHT_ID = 'vendor/tight';
const WIDE_ID = 'vendor/wide';

/** The one funding figure both sides are solved against. */
const SPENDABLE = 20_000_000n;

/** 600 system + 300 history + 100 input, the module fixture's basis. */
const PROMPT_CHARS = 1000;

/** Stored rates, held at their ceilings, 125 / 250. */
const RATES = { input: 100n, output: 200n } as const;

function descriptorOf(id: string, providerCap: number): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 200_000, maxOutputTokens: providerCap },
    pricing: tokenPricingFixture({ input: RATES.input, output: RATES.output }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

const CATALOG = [descriptorOf(TIGHT_ID, 2000), descriptorOf(WIDE_ID, 64_000)];
const resolve: ModelPricingResolver = (id) => CATALOG.find((model) => model.id === id);

function priceableOf(id: string, providerCap: number): PriceableModel {
  return {
    modelId: modelId(id),
    pricing: tokenPricingFixture({ input: nanoUSD(RATES.input), output: nanoUSD(RATES.output) }),
    contextLength: 200_000,
    providerCap,
    reasoning: undefined,
    releasedAtMs: 0,
  };
}

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

const SELECTION: Selection = {
  answerSources: { models: [modelId(TIGHT_ID), modelId(WIDE_ID)], smartSlot: false },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

const FUNDING: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(SPENDABLE),
  heldNanoUsd: nanoUSD(0n),
  payerTier: 'paid',
  payer: 'self',
};

const MODULE_SIDE = getTurnOptions(FUNDING, BASIS, SELECTION, {
  models: [priceableOf(TIGHT_ID, 2000), priceableOf(WIDE_ID, 64_000)],
  nowMs: NOW_MS,
});

/**
 * The server budget for the SAME turn the module solved. Three figures have to
 * match or the two sides price different turns and the divergence below stops
 * being about clamp order: the spendable, the whole-prompt count the provider
 * leg bills, and the new-message count the storage leg bills — which is
 * `inputChars` alone, never the assembled prompt.
 */
const BUDGET: TurnBudget = {
  promptCharacterCount: PROMPT_CHARS,
  inputCharacterCount: BASIS.inputChars,
  funding: { kind: 'purchased', spendableNanoUsd: SPENDABLE },
};

const SERVER_SIDE = (() => {
  const outcome = compileMultiModelTurnOutcome(resolve, [TIGHT_ID, WIDE_ID], {
    budget: BUDGET,
  })._unsafeUnwrap();
  if (outcome.kind !== 'built') throw new Error('expected a built turn');
  return outcome;
})();

function serverCapOf(model: string): number | undefined {
  const node = SERVER_SIDE.definition.nodes.find(
    (candidate): candidate is Extract<Node, { type: 'modelCall' }> =>
      candidate.type === 'modelCall' && candidate.model === model
  );
  const cap = node?.params['maxOutputTokens'];
  return typeof cap === 'number' ? cap : undefined;
}

function moduleCeilingOf(model: string): number | undefined {
  return MODULE_SIDE.admissible.all.find((entry) => entry.modelId === model)?.ceilingTokens;
}

const SERVER_HOLD = createEstimateTotal(resolve)(SERVER_SIDE.definition)._unsafeUnwrap();

describe('the two clamp orders on one saturating-sibling turn', () => {
  it('agrees on the saturated sibling, which its own cap fixes either way', () => {
    // The tight sibling is bounded by its provider cap, not by the money, so no
    // clamp order can move it. Agreement here is what isolates the divergence
    // below to the ORDER rather than to the fixture.
    expect(moduleCeilingOf(TIGHT_ID)).toBe(2000);
    expect(serverCapOf(TIGHT_ID)).toBe(2000);
  });

  it('diverges on the wide sibling, and the server hands it the longer answer', () => {
    expect(moduleCeilingOf(WIDE_ID)).toBe(5572);
    expect(serverCapOf(WIDE_ID)).toBe(9144);
  });

  it('spends the saturated sibling unused budget instead of leaving it, unlike the module', () => {
    // The module leaves 6,251,500 nano unspent (its own pinned amount); the
    // server's fit reallocates all of it to the sibling that can use it but the
    // 500 nano left short of one more token at 250 + 1,500.
    expect(BigInt(FUNDING.spendableNanoUsd) - (MODULE_SIDE.holdNanoUsd ?? 0n)).toBe(6_251_500n);
    expect(SPENDABLE - SERVER_HOLD).toBe(500n);
  });

  it('keeps the server hold inside the same funding the module solved against', () => {
    // The direction that makes the divergence safe: the fit gates on the SAME
    // spendable figure, so the larger cap can only lengthen an answer — it can
    // never admit a send the client refused, and never holds past the funds.
    expect(SERVER_HOLD).toBeLessThanOrEqual(SPENDABLE);
    expect(SERVER_HOLD).toBeGreaterThan(MODULE_SIDE.holdNanoUsd ?? 0n);
    expect(payerSpendableNanoUsd(BUDGET)).toBe(SPENDABLE);
  });

  it('never presents more than it runs, so the served ceiling is not a promise the run breaks', () => {
    // The presented ceiling is the SMALLER of the two here. An over-presented
    // ceiling degrades to a shorter answer (§Data Structures); this direction
    // cannot even do that.
    expect(moduleCeilingOf(WIDE_ID) ?? 0).toBeLessThanOrEqual(serverCapOf(WIDE_ID) ?? 0);
  });
});
