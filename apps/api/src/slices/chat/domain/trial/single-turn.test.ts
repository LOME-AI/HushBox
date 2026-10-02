/**
 * The trial single-model compile refuses exactly what the composer refuses at
 * the fixed per-message ceiling. The model under test cannot turn reasoning off
 * and offers one effort word, so an `auto` send buys no classifier and reaches
 * this compile; whether its one rung plus a minimum answer fits the ceiling is
 * the whole question, and the composer answers it with `pinned: {}`.
 */

import { describe, expect, it } from 'vitest';
import { modelId } from '@hushbox/shared';
import {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  getTurnOptions,
  priceableModelFrom,
  promptBasisFromTotal,
  trialFundingSnapshot,
} from '@hushbox/shared/affordability';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { snapshotResolver } from '../../../models/index.js';
import { TRIAL_TURN_HOOKS } from '../constants.js';
import { compileSingleTurn } from '../turn/definition.js';
import { trialGateVerdict } from './gate.js';
import { compileTrialSingleTurn } from './single-turn.js';
import type { ModelDescriptor, ModelReasoning } from '@hushbox/shared';
import type { TurnBudget } from '../turn/definition.js';

const NOW_MS = TEST_DAY_START;
const SINGLE_RUNG = 'vendor/single-rung-mandatory';
const SINGLE_RUNG_REASONING: ModelReasoning = { supportedEfforts: ['high'], mandatory: true };

function descriptor(
  id: string,
  input: bigint,
  output: bigint,
  reasoning?: ModelReasoning
): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 1_000_000 },
    pricing: tokenPricingFixture({ input: input, output: output }),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/**
 * The catalog around the model under test: a cheap text model beside it and
 * pricey rows above both, so the premium percentile keeps it trial-eligible.
 */
function catalogAt(outputPerToken: bigint): readonly ModelDescriptor[] {
  return [
    descriptor(SINGLE_RUNG, 100n, outputPerToken, SINGLE_RUNG_REASONING),
    descriptor('vendor/cheap', 1n, 2n),
    descriptor('vendor/dear-a', 1_000_000n, 1_000_000n),
    descriptor('vendor/dear-b', 1_000_000n, 1_000_000n),
    descriptor('vendor/dear-c', 1_000_000n, 1_000_000n),
  ];
}

function trialBudget(promptChars: number): TurnBudget {
  return {
    promptCharacterCount: promptChars,
    inputCharacterCount: promptChars,
    funding: { kind: 'free', spendableNanoUsd: TRIAL_MESSAGE_COST_CAP_NANO_USD },
  };
}

/** Whether the composer sends a trial `auto` turn on the model at this rate and prompt. */
function composerSends(outputPerToken: bigint, promptChars: number): boolean {
  const catalog = catalogAt(outputPerToken);
  return getTurnOptions(
    trialFundingSnapshot(),
    promptBasisFromTotal({ promptChars, inputChars: promptChars }),
    {
      answerSources: { models: [modelId(SINGLE_RUNG)], smartSlot: false },
      modality: 'text',
      pinned: {},
      webSearch: false,
    },
    {
      models: catalog.flatMap((row) => priceableModelFrom(row) ?? []),
      nowMs: NOW_MS,
    }
  ).admissible.sendable;
}

/** Whether this module builds the same send. */
function serverBuilds(outputPerToken: bigint, promptChars: number): boolean {
  return (
    compileTrialSingleTurn(catalogAt(outputPerToken), SINGLE_RUNG, {
      budget: trialBudget(promptChars),
      reasoningEffort: 'auto',
    })._unsafeUnwrap().kind === 'built'
  );
}

function gateOn(outputPerToken: bigint, promptChars: number): string {
  const catalog = catalogAt(outputPerToken);
  return trialGateVerdict(
    catalog.find((row) => row.id === SINGLE_RUNG),
    catalog,
    promptChars,
    NOW_MS
  )._unsafeUnwrap();
}

/** The least output rate at which the composer refuses, by bisection over whole nano-USD. */
function composerFlip(promptChars: number): bigint {
  let sends = 1n;
  let refuses = 100_000n;
  if (!composerSends(sends, promptChars) || composerSends(refuses, promptChars)) {
    throw new Error('expected the bisection bounds to straddle the composer flip');
  }
  while (refuses - sends > 1n) {
    const mid = (sends + refuses) / 2n;
    if (composerSends(mid, promptChars)) sends = mid;
    else refuses = mid;
  }
  return refuses;
}

const SWEEP_HALF_WIDTH = 25n;

describe('the trial single-model compile against the composer', () => {
  it.each([400, 3000, 12_000])(
    'refuses exactly what the composer refuses across its flip at %i prompt characters',
    (promptChars) => {
      const flip = composerFlip(promptChars);
      const verdicts: boolean[] = [];
      for (let rate = flip - SWEEP_HALF_WIDTH; rate <= flip + SWEEP_HALF_WIDTH; rate += 1n) {
        expect(gateOn(rate, promptChars)).toBe('allowed');
        const composer = composerSends(rate, promptChars);
        expect(serverBuilds(rate, promptChars), `at output rate ${String(rate)}`).toBe(composer);
        verdicts.push(composer);
      }
      expect(verdicts).toContain(true);
      expect(verdicts).toContain(false);
    }
  );
});

describe('compileTrialSingleTurn', () => {
  it('builds the definition the single-model compile builds when the ceiling funds it', () => {
    const catalog = catalogAt(1n);
    const build = compileTrialSingleTurn(catalog, SINGLE_RUNG, {
      budget: trialBudget(400),
      reasoningEffort: 'auto',
    })._unsafeUnwrap();
    const today = compileSingleTurn(snapshotResolver(catalog), SINGLE_RUNG, {
      hooks: TRIAL_TURN_HOOKS,
      budget: trialBudget(400),
      reasoningEffort: 'auto',
    })._unsafeUnwrap();
    expect(build).toEqual({ kind: 'built', definition: today });
  });

  it('builds a send that names no effort', () => {
    const build = compileTrialSingleTurn(catalogAt(1n), 'vendor/cheap', {
      budget: trialBudget(400),
    })._unsafeUnwrap();
    expect(build.kind).toBe('built');
  });

  it('answers over-ceiling when the rung plus a minimum answer exceeds the ceiling', () => {
    const build = compileTrialSingleTurn(catalogAt(100_000n), SINGLE_RUNG, {
      budget: trialBudget(400),
      reasoningEffort: 'auto',
    })._unsafeUnwrap();
    expect(build).toEqual({ kind: 'over-ceiling' });
  });

  it('passes the compile refusal of a model the catalog does not carry through', () => {
    const build = compileTrialSingleTurn(catalogAt(1n), 'vendor/absent', {
      budget: trialBudget(400),
    });
    expect(build._unsafeUnwrapErr().code).toBe('validation');
  });
});
