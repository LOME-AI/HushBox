/**
 * A model whose room cannot hold its reasoning budget plus a minimum answer,
 * whether that budget is a rung's or zero: the server compile refuses exactly
 * the sends the browser's admissible pass refuses as `model_output_cap_too_low`,
 * and a model with room compiles as before.
 *
 * Funding here is far above every hold, so money never binds: the only bound in
 * play is the model's own room, `min(providerCap, contextHeadroom)`.
 */

import { describe, expect, it } from 'vitest';
import { modelId, nanoUSD } from '@hushbox/shared';
import { getTurnOptions } from '@hushbox/shared/affordability';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import {
  compileMultiModelTurnOutcome,
  compileSingleTurn,
  promptInputTokensFor,
} from './definition.js';
import { CHAT_TURN_HOOKS } from '../constants.js';
import { compileAutoEffortTurn } from '../smart-model/turn.js';
import type { TurnBudget } from './definition.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { CanonicalReasoningEffort, ModelDescriptor, ModelReasoning } from '@hushbox/shared';

type PromptBasis = Parameters<typeof getTurnOptions>[1];
type PriceableModel = Parameters<typeof getTurnOptions>[3]['models'][number];

interface Row {
  readonly id: string;
  readonly contextLength: number;
  readonly cap: number;
  readonly input: bigint;
  readonly output: bigint;
  readonly reasoning: ModelReasoning | undefined;
}

/** Budget-native reasoning: every rung is offered, each a clamped token budget. */
const BUDGET_NATIVE: ModelReasoning = {};

const SONNET: Row = {
  id: 'anthropic/claude-sonnet-4.5',
  contextLength: 1_000_000,
  cap: 64_000,
  input: 3450n,
  output: 17_250n,
  reasoning: BUDGET_NATIVE,
};

const R1: Row = {
  id: 'deepseek/deepseek-r1',
  contextLength: 163_840,
  cap: 16_000,
  input: 700n,
  output: 2500n,
  reasoning: BUDGET_NATIVE,
};

/**
 * Two native effort words, so its ladder is Low and High: at Lite it has no rung
 * at or below the pin and resolves to off, which reserves no reasoning budget.
 */
const TWO_RUNG_NARROW: Row = {
  id: 'vendor/two-rung-narrow',
  contextLength: 128_000,
  cap: 506,
  input: 700n,
  output: 2500n,
  reasoning: { supportedEfforts: ['high', 'low'] },
};

/** No reasoning metadata at all, with a completion cap below a minimum answer. */
const PLAIN_NARROW: Row = {
  id: 'vendor/plain-narrow',
  contextLength: 128_000,
  cap: 900,
  input: 700n,
  output: 2500n,
  reasoning: undefined,
};

/**
 * Budget-native and unable to turn reasoning off: with no rung pinned, the
 * composer holds it to its cheapest rung, Lite, plus a minimum answer.
 */
const MANDATORY_BUDGET_NATIVE: Row = {
  id: 'vendor/mandatory-budget-native',
  contextLength: 1_000_000,
  cap: 64_000,
  input: 700n,
  output: 2500n,
  reasoning: { mandatory: true },
};

/** Offers only one native effort word and cannot turn it off. */
const MANDATORY_SINGLE_WORD: Row = {
  id: 'vendor/mandatory-single-word',
  contextLength: 1_000_000,
  cap: 64_000,
  input: 700n,
  output: 2500n,
  reasoning: { supportedEfforts: ['high'], mandatory: true },
};

/**
 * The smallest provider cap at which the composer sends each mandatory model
 * with no rung pinned: its cheapest rung's reasoning budget plus a minimum
 * answer. Each is pinned against the composer below, at the need and one token
 * short of it.
 */
const MANDATORY_NEEDS = [
  { row: MANDATORY_BUDGET_NATIVE, need: 3048 },
  { row: MANDATORY_SINGLE_WORD, need: 33_768 },
] as const;

/** The smallest room a model that reserves no reasoning budget needs. */
const MINIMUM_ANSWER_CAP = 1000;

/** $12.48 spendable. */
const SPENDABLE = 12_480_000_000n;

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

const BUDGET: TurnBudget = {
  promptCharacterCount: 1000,
  inputCharacterCount: BASIS.inputChars,
  funding: { kind: 'purchased', spendableNanoUsd: SPENDABLE },
};

function descriptorOf(row: Row): ModelDescriptor {
  return {
    id: row.id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: row.contextLength, maxOutputTokens: row.cap },
    pricing: tokenPricingFixture({ input: row.input, output: row.output }),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
  };
}

function priceableOf(row: Row): PriceableModel {
  return {
    modelId: modelId(row.id),
    pricing: tokenPricingFixture({ input: nanoUSD(row.input), output: nanoUSD(row.output) }),
    contextLength: row.contextLength,
    providerCap: row.cap,
    reasoning: row.reasoning,
    releasedAtMs: OLD_RELEASE_SECONDS * 1000,
  };
}

function resolverOf(rows: readonly Row[]): ModelPricingResolver {
  const catalog = rows.map((row) => descriptorOf(row));
  return (id) => catalog.find((row) => row.id === id);
}

/** The browser's admissible refusal for a pinned rung, or `undefined` when it sends. */
function browserRefusal(
  rows: readonly [Row, ...Row[]],
  effort: CanonicalReasoningEffort
): string | undefined {
  const [first, ...rest] = rows;
  const options = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(SPENDABLE),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    BASIS,
    {
      answerSources: {
        models: [modelId(first.id), ...rest.map((row) => modelId(row.id))],
        smartSlot: false,
      },
      modality: 'text',
      pinned: { effort },
      webSearch: false,
    },
    { models: rows.map((row) => priceableOf(row)), nowMs: TEST_DAY_START }
  );
  return options.admissible.sendable ? undefined : options.admissible.refusal;
}

/** The browser's admissible refusal for a turn that pins no rung, or `undefined` when it sends. */
function unpinnedBrowserRefusal(...rows: readonly [Row, ...Row[]]): string | undefined {
  const [first, ...rest] = rows;
  const options = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(SPENDABLE),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    BASIS,
    {
      answerSources: {
        models: [modelId(first.id), ...rest.map((row) => modelId(row.id))],
        smartSlot: false,
      },
      modality: 'text',
      pinned: {},
      webSearch: false,
    },
    { models: rows.map((row) => priceableOf(row)), nowMs: TEST_DAY_START }
  );
  return options.admissible.sendable ? undefined : options.admissible.refusal;
}

/** The server compile's answer for one model with no reasoning selection. */
function unpinnedSingleCompile(row: Row): string {
  return compileSingleTurn(resolverOf([row]), row.id, { budget: BUDGET }).match(
    () => 'compiled',
    (error) => `refused: ${error.code}`
  );
}

/** The server compile's answer for one model at a pinned rung. */
function singleCompile(row: Row, effort: CanonicalReasoningEffort): string {
  return compileSingleTurn(resolverOf([row]), row.id, {
    budget: BUDGET,
    reasoningEffort: effort,
  }).match(
    () => 'compiled',
    (error) => `refused: ${error.code}`
  );
}

/** The server compile's answer for a multi-model turn at a pinned rung. */
function multiCompile(rows: readonly Row[], effort: CanonicalReasoningEffort): string {
  return compileMultiModelTurnOutcome(
    resolverOf(rows),
    rows.map((row) => row.id),
    { budget: BUDGET, reasoningEffort: effort, nowMs: TEST_DAY_START }
  ).match(
    (outcome) => outcome.kind,
    (error) => `refused: ${error.code}`
  );
}

describe('a reasoning rung that leaves no room for a minimum answer', () => {
  it('is refused by the browser for Claude Sonnet 4.5 at max', () => {
    expect(browserRefusal([SONNET], 'max')).toBe('model_output_cap_too_low');
  });

  it('is refused by the server compile for Claude Sonnet 4.5 at max', () => {
    expect(singleCompile(SONNET, 'max')).toBe('refused: validation');
  });

  it.each<CanonicalReasoningEffort>(['high', 'max'])(
    'is refused by the browser for DeepSeek R1 at %s',
    (effort) => {
      expect(browserRefusal([R1], effort)).toBe('model_output_cap_too_low');
    }
  );

  it.each<CanonicalReasoningEffort>(['high', 'max'])(
    'is refused by the server compile for DeepSeek R1 at %s',
    (effort) => {
      expect(singleCompile(R1, effort)).toBe('refused: validation');
    }
  );

  it('carries an operator message naming the starved model', () => {
    const refused = compileSingleTurn(resolverOf([SONNET]), SONNET.id, {
      budget: BUDGET,
      reasoningEffort: 'max',
    });
    expect(refused._unsafeUnwrapErr().message).toBe(
      "model_output_cap_too_low: reasoning effort 'max' leaves model 'anthropic/claude-sonnet-4.5' no room for a minimum answer"
    );
  });

  it('refuses a multi-model turn whose narrow sibling starves while the wide one has room', () => {
    expect(browserRefusal([SONNET, R1], 'high')).toBe('model_output_cap_too_low');
    expect(multiCompile([SONNET, R1], 'high')).toBe('refused: validation');
  });
});

describe('a sibling that reserves no reasoning budget and has no room for a minimum answer', () => {
  it('is refused by the browser when a two-rung sibling resolves to off at lite', () => {
    expect(browserRefusal([SONNET, R1, TWO_RUNG_NARROW], 'lite')).toBe('model_output_cap_too_low');
  });

  it('is refused by the server compile when a two-rung sibling resolves to off at lite', () => {
    expect(multiCompile([SONNET, R1, TWO_RUNG_NARROW], 'lite')).toBe('refused: validation');
  });

  it('carries an operator message naming the starved off sibling', () => {
    const refused = compileMultiModelTurnOutcome(
      resolverOf([SONNET, R1, TWO_RUNG_NARROW]),
      [SONNET.id, R1.id, TWO_RUNG_NARROW.id],
      { budget: BUDGET, reasoningEffort: 'lite', nowMs: TEST_DAY_START }
    );
    expect(refused._unsafeUnwrapErr().message).toBe(
      "model_output_cap_too_low: reasoning effort 'off' leaves model 'vendor/two-rung-narrow' no room for a minimum answer"
    );
  });
});

describe('a reasoning-free model with no room for a minimum answer', () => {
  it('is refused by the browser', () => {
    expect(unpinnedBrowserRefusal(PLAIN_NARROW)).toBe('model_output_cap_too_low');
  });

  it('is refused by the server compile', () => {
    expect(unpinnedSingleCompile(PLAIN_NARROW)).toBe('refused: validation');
  });

  it('carries an operator message naming the model', () => {
    const refused = compileSingleTurn(resolverOf([PLAIN_NARROW]), PLAIN_NARROW.id, {
      budget: BUDGET,
    });
    expect(refused._unsafeUnwrapErr().message).toBe(
      "model_output_cap_too_low: model 'vendor/plain-narrow' has no room for a minimum answer"
    );
  });

  it('compiles when its cap holds a minimum answer', () => {
    const roomy: Row = { ...PLAIN_NARROW, cap: 4096 };
    expect(unpinnedBrowserRefusal(roomy)).toBeUndefined();
    expect(unpinnedSingleCompile(roomy)).toBe('compiled');
  });

  it('keeps compiling with no budget, since a turn with no prompt size has no room to measure', () => {
    expect(compileSingleTurn(resolverOf([PLAIN_NARROW]), PLAIN_NARROW.id, {}).isOk()).toBe(true);
  });
});

describe('a mandatory-reasoning model sent with no rung pinned', () => {
  describe.each(MANDATORY_NEEDS)('$row.id', ({ row, need }) => {
    it.each([MINIMUM_ANSWER_CAP, need - 1])(
      'is refused by the browser at a %i-token cap',
      (cap) => {
        expect(unpinnedBrowserRefusal({ ...row, cap })).toBe('model_output_cap_too_low');
      }
    );

    it.each([MINIMUM_ANSWER_CAP, need - 1])(
      'is refused by the server compile at a %i-token cap',
      (cap) => {
        expect(unpinnedSingleCompile({ ...row, cap })).toBe('refused: validation');
      }
    );

    it('is sent by the browser at its cheapest rung plus a minimum answer', () => {
      expect(unpinnedBrowserRefusal({ ...row, cap: need })).toBeUndefined();
    });

    it('compiles on the server at its cheapest rung plus a minimum answer', () => {
      expect(unpinnedSingleCompile({ ...row, cap: need })).toBe('compiled');
    });
  });

  it('carries an operator message naming the cheapest rung it was held to', () => {
    const narrow: Row = { ...MANDATORY_SINGLE_WORD, cap: 33_767 };
    const refused = compileSingleTurn(resolverOf([narrow]), narrow.id, { budget: BUDGET });
    expect(refused._unsafeUnwrapErr().message).toBe(
      "model_output_cap_too_low: reasoning effort 'high' leaves model 'vendor/mandatory-single-word' no room for a minimum answer"
    );
  });
});

describe('a classifying auto turn that includes a mandatory-reasoning model', () => {
  /** The server compile's answer for an `auto` multi-model turn over `rows`. */
  function autoCompile(rows: readonly Row[]): string {
    const catalog = rows.map((row) => descriptorOf(row));
    return compileMultiModelTurnOutcome(
      resolverOf(rows),
      rows.map((row) => row.id),
      { budget: BUDGET, reasoningEffort: 'auto', catalog, nowMs: TEST_DAY_START }
    ).match(
      (outcome) => outcome.kind,
      (error) => `refused: ${error.code}`
    );
  }

  it('is refused by the browser when the mandatory model is one token short of its need', () => {
    const narrow: Row = { ...MANDATORY_BUDGET_NATIVE, cap: 3047 };
    expect(unpinnedBrowserRefusal(SONNET, narrow)).toBe('model_output_cap_too_low');
  });

  it('is refused by the server effort menu when the mandatory model is one token short of its need', () => {
    // Every rung the menu could offer resolves the mandatory model to its cheapest
    // rung or above, so no rung is available and the turn is unaffordable before
    // any sizing runs.
    expect(autoCompile([SONNET, { ...MANDATORY_BUDGET_NATIVE, cap: 3047 }])).toBe('unaffordable');
  });

  it('compiles on both sides when the mandatory model holds its need', () => {
    const roomy: Row = { ...MANDATORY_BUDGET_NATIVE, cap: 3048 };
    expect(unpinnedBrowserRefusal(SONNET, roomy)).toBeUndefined();
    expect(autoCompile([SONNET, roomy])).toBe('built');
  });
});

describe('a prompt that overruns the model window on the pinned-model auto-effort turn', () => {
  /** A budget whose prompt is `promptChars` characters long. */
  function promptOf(promptChars: number): TurnBudget {
    return { ...BUDGET, promptCharacterCount: promptChars };
  }

  /** The pinned-model auto-effort compile's outcome for `budget`. */
  function autoEffortOutcome(budget: TurnBudget): string {
    const catalog = [descriptorOf(SONNET), descriptorOf(R1)];
    return compileAutoEffortTurn(catalog, R1.id, {
      budget,
      hooks: CHAT_TURN_HOOKS,
      now: new Date(TEST_DAY_START),
    }).match(
      (build) => build.kind,
      (error) => `refused: ${error.code}`
    );
  }

  it('is graded unaffordable by its menu, so no sized turn carries the floored room', () => {
    const overrun = promptOf(R1.contextLength * 4);
    expect(promptInputTokensFor(overrun)).toBeGreaterThanOrEqual(R1.contextLength);
    expect(autoEffortOutcome(overrun)).toBe('unaffordable');
  });

  it('builds when the prompt leaves room, so the refusal above is the overrun', () => {
    expect(autoEffortOutcome(promptOf(4000))).toBe('built');
  });
});

describe('a reasoning rung with room for a minimum answer', () => {
  it('is sent by the browser for Claude Sonnet 4.5 at high', () => {
    expect(browserRefusal([SONNET], 'high')).toBeUndefined();
  });

  it('compiles on the server for Claude Sonnet 4.5 at high', () => {
    expect(singleCompile(SONNET, 'high')).toBe('compiled');
  });

  it('compiles on the server for DeepSeek R1 at medium', () => {
    expect(browserRefusal([R1], 'medium')).toBeUndefined();
    expect(singleCompile(R1, 'medium')).toBe('compiled');
  });

  it('compiles a multi-model turn where every sibling has room', () => {
    expect(browserRefusal([SONNET, R1], 'medium')).toBeUndefined();
    expect(multiCompile([SONNET, R1], 'medium')).toBe('built');
  });
});
