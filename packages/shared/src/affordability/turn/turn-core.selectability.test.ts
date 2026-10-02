/**
 * A candidate row answers two questions, and they are not the same question:
 * whether the CLASSIFIER may bind the model, and whether the payer CLICKING the
 * row gets a turn that sends. Selecting a model moves it out of the classifier
 * pool and into the pinned set, where an effort pin it cannot resolve runs
 * wire-silent instead of withholding it — so the two answers diverge exactly
 * there, and these pins are on that divergence.
 *
 * The second question has two answers, because a click has two meanings: one
 * picker mode REPLACES the answer set with the row, the other ADDS the row
 * beside what is already selected. The pins below hold the two arms apart, and
 * hold apart the two things an add-refusal can be about — the model itself, or
 * the selection it would join.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { REASONING_OFF } from '../reasoning-effort.ts';
import { evaluateTurn } from './turn-core.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { CoreInput, CoreResult } from './turn-core.ts';
import type { ModelId } from '../model/model-id.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { CandidateModelEntry, PromptBasis, Selection } from './turn-types.ts';

interface ModelShape {
  readonly modelId: string;
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly reasoning?: PriceableModel['reasoning'];
}

function modelOf(shape: ModelShape): PriceableModel {
  return {
    modelId: modelId(shape.modelId),
    pricing: tokenPricingFixture({
      input: nanoUSD(shape.inputRate),
      output: nanoUSD(shape.outputRate),
    }),
    contextLength: 100_000,
    providerCap: 32_000,
    releasedAtMs: 0,
    reasoning: shape.reasoning,
  };
}

/** Offers `low`, `medium`, `high`, and — not being mandatory — the off rung too. */
const LADDERED = modelOf({
  modelId: 'vendor/laddered',
  inputRate: 100n,
  outputRate: 200n,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
});

/** No reasoning metadata at all: the axis offers it nothing, not even off. */
const LADDERLESS = modelOf({ modelId: 'vendor/ladderless', inputRate: 120n, outputRate: 240n });

/** A second ladderless model, so a turn can have no answer for a pin at all. */
const LADDERLESS_TWIN = modelOf({ modelId: 'vendor/plain', inputRate: 110n, outputRate: 220n });

const NOW_MS = TEST_DAY_START;

const BASIS: PromptBasis = {
  systemChars: 400,
  instructionChars: 0,
  historyChars: 400,
  inputChars: 200,
  attachmentBytes: 0,
};

/** $500 in nano-USD: money is never the constraint in the divergence pins. */
const AMPLE_FUNDING = 500_000_000_000n;

function selectionOf(models: readonly string[], pinnedEffort?: string): Selection {
  return {
    answerSources: {
      models: models.map((id) => modelId(id)) as [ModelId, ...ModelId[]],
      smartSlot: false,
    },
    modality: 'text',
    pinned: pinnedEffort === undefined ? {} : { effort: pinnedEffort },
    webSearch: false,
  };
}

/**
 * A trial payer's catalog: one premium model and one that is not. The pool is
 * too small to have a price percentile, so the release date is the whole
 * premium classification here — the recent one is premium, the epoch one is not.
 */
const PREMIUM_PIN: PriceableModel = {
  ...modelOf({ modelId: 'vendor/premium-pin', inputRate: 100n, outputRate: 200n }),
  releasedAtMs: NOW_MS,
};

const CHEAP: PriceableModel = modelOf({
  modelId: 'vendor/cheap',
  inputRate: 10n,
  outputRate: 20n,
});

/** The founder's arrangement: a persisted premium pin surviving into a trial session. */
function trialInputOf(): CoreInput {
  return {
    fundingNanoUsd: AMPLE_FUNDING,
    basis: BASIS,
    selection: selectionOf(['vendor/premium-pin']),
    catalog: [PREMIUM_PIN, CHEAP],
    tier: 'trial',
    nowMs: NOW_MS,
  };
}

/**
 * A pin the trial's per-message cap refuses, in a pool whose price percentile
 * sits well above it — so the tier axis reaches the cap instead of stopping at
 * premium, and the cheap row beside it is neither premium nor over the cap.
 */
const TRIAL_CAP_PIN = modelOf({
  modelId: 'vendor/trial-cap-pin',
  inputRate: 10_000n,
  outputRate: 10_000n,
});

const DEAR = [1, 2, 3].map((n) =>
  modelOf({ modelId: `vendor/dear-${String(n)}`, inputRate: 100_000n, outputRate: 100_000n })
);

function trialCapInputOf(): CoreInput {
  return {
    fundingNanoUsd: AMPLE_FUNDING,
    basis: BASIS,
    selection: selectionOf(['vendor/trial-cap-pin']),
    catalog: [TRIAL_CAP_PIN, CHEAP, ...DEAR],
    tier: 'trial',
    nowMs: NOW_MS,
  };
}

function inputOf(overrides: Partial<CoreInput> = {}): CoreInput {
  return {
    fundingNanoUsd: AMPLE_FUNDING,
    basis: BASIS,
    selection: selectionOf(['vendor/laddered'], 'low'),
    catalog: [LADDERED, LADDERLESS, LADDERLESS_TWIN],
    tier: 'paid',
    nowMs: NOW_MS,
    ...overrides,
  };
}

function candidateOf(result: CoreResult, id: string): CandidateModelEntry {
  const entry = result.optionSet.all.find((row) => row.modelId === id);
  if (entry?.kind !== 'candidate') throw new Error(`no candidate row for ${id}`);
  return entry;
}

describe('candidate activation', () => {
  // The two questions on one row in one state: under a pin this model cannot
  // resolve, the classifier may not bind it, while either click drops the pin
  // along with the sibling that carried it.
  it('refuses the row for the classifier while both clicks on it would send', () => {
    const row = candidateOf(evaluateTurn(inputOf()), 'vendor/ladderless');

    expect([row.availability, row.activation]).toStrictEqual([
      { available: false, reason: 'option_not_offered' },
      { replace: { available: true }, add: { available: true } },
    ]);
  });

  it('withholds a ladderless candidate from the classifier under an effort pin', () => {
    const row = candidateOf(evaluateTurn(inputOf()), 'vendor/ladderless');

    expect(row.availability).toStrictEqual({
      available: false,
      reason: 'option_not_offered',
    });
  });

  it('offers a ladderless candidate for selection when a sibling answers the pin', () => {
    const row = candidateOf(evaluateTurn(inputOf()), 'vendor/ladderless');

    expect(row.activation.add).toStrictEqual({ available: true });
  });

  it('offers a ladderless candidate for selection at the off rung', () => {
    const input = inputOf({ selection: selectionOf(['vendor/laddered'], REASONING_OFF) });

    expect(candidateOf(evaluateTurn(input), 'vendor/ladderless').activation.add).toStrictEqual({
      available: true,
    });
  });

  it('refuses selection of a ladderless candidate when nothing would answer the pin', () => {
    const input = inputOf({ selection: selectionOf(['vendor/plain'], 'low') });

    expect(candidateOf(evaluateTurn(input), 'vendor/ladderless').activation.add).toStrictEqual({
      available: false,
      reason: 'option_not_offered',
      causedBy: 'model',
    });
  });

  // A row that cannot run alone reports its OWN reason on both arms. Replacing
  // leaves this model carrying no pin at all, so the effort axis has nothing to
  // refuse and the money is what remains.
  it('refuses selection of a candidate the funding cannot reach', () => {
    const input = inputOf({ fundingNanoUsd: 1n });

    expect(candidateOf(evaluateTurn(input), 'vendor/ladderless').activation.add).toStrictEqual({
      available: false,
      reason: 'insufficient_funds',
      causedBy: 'model',
    });
  });

  // The same shortage on a row that DOES resolve the pin alone, so nothing
  // short-circuits ahead of the money.
  it('refuses selection of a laddered candidate the funding cannot reach', () => {
    const input = inputOf({ fundingNanoUsd: 1n, selection: selectionOf(['vendor/plain'], 'low') });

    expect(candidateOf(evaluateTurn(input), 'vendor/laddered').activation.add).toStrictEqual({
      available: false,
      reason: 'insufficient_funds',
      causedBy: 'model',
    });
  });

  // Selecting a model also makes it one of the turn's ANSWER SOURCES, which is what
  // lets a pinned sibling that cannot resolve the pin run wire-silent beside it.
  it('offers a laddered candidate for selection beside a pinned sibling that cannot answer the pin', () => {
    const input = inputOf({ selection: selectionOf(['vendor/plain'], 'low') });

    expect(candidateOf(evaluateTurn(input), 'vendor/laddered').activation.add).toStrictEqual({
      available: true,
    });
  });

  it('keeps a ladderless model out of the runnable set under an effort pin', () => {
    const result = evaluateTurn(inputOf());
    const runnable = result.optionSet.sendable
      ? result.optionSet.runnable.map((entry) => entry.modelId)
      : [];

    expect(runnable).not.toContain('vendor/ladderless');
  });
});

describe('a candidate blocked by the selection rather than by itself', () => {
  it('offers a non-premium row for replacement to a trial payer holding a premium pin', () => {
    const row = candidateOf(evaluateTurn(trialInputOf()), 'vendor/cheap');

    expect(row.activation.replace).toStrictEqual({ available: true });
  });

  it('refuses adding that row beside the pin, and says the selection caused it', () => {
    const row = candidateOf(evaluateTurn(trialInputOf()), 'vendor/cheap');

    expect(row.activation.add).toStrictEqual({
      available: false,
      reason: 'premium_requires_account',
      causedBy: 'selection',
    });
  });

  it('still refuses the premium pin itself, on both arms', () => {
    const result = evaluateTurn({
      ...trialInputOf(),
      selection: selectionOf(['vendor/cheap']),
    });

    expect(candidateOf(result, 'vendor/premium-pin').activation).toStrictEqual({
      replace: { available: false, reason: 'premium_requires_account' },
      add: { available: false, reason: 'premium_requires_account', causedBy: 'model' },
    });
  });

  // The tier axis reaches the trial cap only past premium, so the pin has to be
  // costly enough to break the cap and still cheap enough to sit below the
  // pool's premium price percentile.
  it('attributes a trial cap the pinned sibling breaks to the selection', () => {
    const row = candidateOf(evaluateTurn(trialCapInputOf()), 'vendor/cheap');

    expect([row.activation.replace, row.activation.add]).toStrictEqual([
      { available: true },
      { available: false, reason: 'trial_message_cap_exceeded', causedBy: 'selection' },
    ]);
  });

  // Adding is graded on the arrangement the click would create and replacing on
  // the row alone, so the two arms reach the same verdict here by different
  // routes: adding leans on a sibling that answers the pin, replacing on the pin
  // no longer existing once this model is the whole answer set.
  it('offers a ladderless row on both arms under a pin only its sibling answers', () => {
    const input = inputOf({ selection: selectionOf(['vendor/laddered'], 'low') });

    expect(candidateOf(evaluateTurn(input), 'vendor/ladderless').activation).toStrictEqual({
      replace: { available: true },
      add: { available: true },
    });
  });
});

describe('the effort a replacing click leaves', () => {
  // The pin is a preference resolved against whatever ladders the chosen answer
  // sources offer, so committing a model with no ladder leaves the turn carrying
  // no pin at all and it sends. Grading the replaced arrangement at the pin the
  // PRE-click selection resolved greyed every ladderless row under any explicit
  // preference — most of the catalog.
  it('offers a ladderless candidate for replacement under a pin only its sibling answers', () => {
    const row = candidateOf(evaluateTurn(inputOf()), 'vendor/ladderless');

    expect(row.activation.replace).toStrictEqual({ available: true });
  });
});

describe('the classifier reserve a replacing click leaves', () => {
  /**
   * A pool of three models with no ladder, so the model dimension is the only
   * open one and the classifier the turn buys is bought for THAT choice alone.
   */
  const PLAIN_POOL: readonly PriceableModel[] = [1, 2, 3].map((n) =>
    modelOf({ modelId: `vendor/plain-${String(n)}`, inputRate: 100n, outputRate: 200n })
  );

  /** The same pool, laddered, so an open effort axis still buys a classifier alone. */
  const LADDERED_POOL: readonly PriceableModel[] = [1, 2, 3].map((n) =>
    modelOf({
      modelId: `vendor/laddered-${String(n)}`,
      inputRate: 100n,
      outputRate: 200n,
      reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
    })
  );

  function slotInputOf(catalog: readonly PriceableModel[], fundingNanoUsd: bigint): CoreInput {
    return {
      fundingNanoUsd,
      basis: BASIS,
      selection: {
        answerSources: { models: [], smartSlot: true },
        modality: 'text',
        pinned: {},
        webSearch: false,
      },
      catalog,
      tier: 'paid',
      nowMs: NOW_MS,
    };
  }

  // A commit closes the model dimension, so the classifier the pass bought to
  // choose between three candidates is not bought at all — the committed turn
  // reserves nothing for one. Grading the replacement against the pass's reserve
  // refuses a click that sends: this balance buys the model alone and not the
  // model plus a classifier call it will never make.
  it('offers a row whose committed turn buys no classifier at all', () => {
    const row = candidateOf(evaluateTurn(slotInputOf(PLAIN_POOL, 2_100_000n)), 'vendor/plain-1');

    expect(row.activation.replace).toStrictEqual({ available: true });
  });

  // The reserve is not simply dropped. A committed model whose own ladder is
  // open still buys the classifier that picks its rung — what shrinks is the
  // prompt, which no longer lists a pool of candidates to choose between.
  it('offers a row whose committed turn buys a classifier for its rung alone', () => {
    const row = candidateOf(
      evaluateTurn(slotInputOf(LADDERED_POOL, 3_202_500n)),
      'vendor/laddered-1'
    );

    expect(row.activation.replace).toStrictEqual({ available: true });
  });

  // The other half of the same rule, and the half an arm that simply dropped the
  // reserve would get wrong: this balance buys the model but not the classifier
  // its open rung still needs, so the row must stay refused. Reserving nothing
  // here offers a click that cannot send — the same defect as the pass's
  // oversized reserve, pointed the other way.
  it('refuses a row whose committed turn cannot afford the classifier its rung needs', () => {
    const row = candidateOf(
      evaluateTurn(slotInputOf(LADDERED_POOL, 2_100_000n)),
      'vendor/laddered-1'
    );

    expect(row.activation.replace).toStrictEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  // The arm still refuses a row the money genuinely cannot reach, so sizing the
  // reserve down does not become offering everything.
  it('still refuses a row the funding cannot reach even with no reserve at all', () => {
    const row = candidateOf(evaluateTurn(slotInputOf(PLAIN_POOL, 800_000n)), 'vendor/plain-1');

    expect(row.activation.replace).toStrictEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });
});
