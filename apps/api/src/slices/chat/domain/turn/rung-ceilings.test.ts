import { describe, expect, it } from 'vitest';

import { toolCallCapFor, toolLoopStepsFor } from '@hushbox/shared/affordability';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { compileMultiModelTurnOutcome } from './definition.js';
import {
  atLoop,
  effortRungsOf,
  settledRungOf,
  sizedTurnAnswers,
  withRungCeilings,
} from './rung-ceilings.js';
import type { AnswerFit } from './rung-ceilings.js';
import type { ModelDescriptor, Node, WorkflowDefinition } from '@hushbox/shared';

function descriptorOf(id: string, rate: bigint, behaviors: readonly string[]): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [...behaviors],
    limits: { contextLength: 128_000, maxOutputTokens: 16_000 },
    pricing: tokenPricingFixture({ input: rate, output: rate * 4n }),
    reasoning: { supportedEfforts: null },
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
  };
}

const ENGINE: ModelDescriptor = { ...descriptorOf('cheap/engine', 100n, []), reasoning: undefined };
const SEARCHER = descriptorOf('s/searcher', 2000n, ['tools']);
const CATALOG: readonly ModelDescriptor[] = [ENGINE, SEARCHER];

/** A budget-less auto turn: a tool-free classifier call beside one searching answer. */
const STAMPED: WorkflowDefinition = (() => {
  const outcome = compileMultiModelTurnOutcome(
    (id) => CATALOG.find((model) => model.id === id),
    [SEARCHER.id],
    { webSearchEnabled: true, reasoningEffort: 'auto', catalog: CATALOG, nowMs: TEST_DAY_START }
  )._unsafeUnwrap();
  if (outcome.kind !== 'built') throw new Error('expected a built turn');
  return outcome.definition;
})();

const PLAN = { loop: 'high', rungs: ['low', 'high'] } as const;
const LOW_STEPS = toolLoopStepsFor(toolCallCapFor('low'));
const HIGH_STEPS = toolLoopStepsFor(toolCallCapFor('high'));

function isSearching(node: Node): node is Extract<Node, { type: 'modelCall' }> {
  return node.type === 'modelCall' && node.tools.length > 0;
}

function searchingOf(definition: WorkflowDefinition): Extract<Node, { type: 'modelCall' }> {
  const node = definition.nodes.find((candidate) => isSearching(candidate));
  if (node === undefined || !isSearching(node)) throw new Error('expected a searching answer');
  return node;
}

/**
 * A fit that caps every answer at its own step count, except that at the low
 * rung's loop it does what `atLow` says to the searching answer.
 */
function fitBy(
  atLow: 'keep' | 'uncap' | 'drop'
): (shaped: WorkflowDefinition) => WorkflowDefinition {
  return (shaped) => ({
    ...shaped,
    nodes: shaped.nodes.flatMap((node): Node[] => {
      if (node.type !== 'modelCall') return [node];
      const low = isSearching(node) && node.maxSteps === LOW_STEPS;
      if (low && atLow === 'drop') return [];
      const params = Object.fromEntries(
        Object.entries(node.params).filter(([key]) => key !== 'maxOutputTokens')
      );
      return [
        {
          ...node,
          params: low && atLow === 'uncap' ? params : { ...params, maxOutputTokens: node.maxSteps },
        },
      ];
    }),
  });
}

describe('each searching answer carries the cap its own fit buys at every rung', () => {
  it('names each rung with the cap its fit bought, and declares the plan’s loop', () => {
    const answer = searchingOf(withRungCeilings(STAMPED, atLoop, PLAN, fitBy('keep')));
    expect(answer.rungCeilings).toStrictEqual({ low: LOW_STEPS, high: HIGH_STEPS });
    expect(answer.maxSteps).toBe(HIGH_STEPS);
  });

  it('leaves every node that carries no tool without a per-rung record', () => {
    const fitted = withRungCeilings(STAMPED, atLoop, PLAN, fitBy('keep'));
    const others = fitted.nodes.filter((node): boolean => !isSearching(node));
    expect(others.some((node) => node.type === 'modelCall')).toBe(true);
    expect(others.some((node) => node.type !== 'modelCall')).toBe(true);
    expect(
      others.map((node) => (node.type === 'modelCall' ? node.rungCeilings : undefined))
    ).toEqual(others.map(() => undefined));
  });

  it('names no rung whose fit leaves the answer without a cap', () => {
    const answer = searchingOf(withRungCeilings(STAMPED, atLoop, PLAN, fitBy('uncap')));
    expect(answer.rungCeilings).toStrictEqual({ high: HIGH_STEPS });
  });

  it('names no rung whose fit leaves no such answer', () => {
    const answer = searchingOf(withRungCeilings(STAMPED, atLoop, PLAN, fitBy('drop')));
    expect(answer.rungCeilings).toStrictEqual({ high: HIGH_STEPS });
  });
});

describe('a built turn’s answers are sized by one rule', () => {
  /** An answer fit that records every funding it is asked to fit against. */
  function recordingFit(spendableNanoUsd: bigint): {
    readonly asked: bigint[];
    readonly fit: AnswerFit;
  } {
    const asked: bigint[] = [];
    return {
      asked,
      fit: {
        spendableNanoUsd,
        fit: (shaped, spendable) => {
          asked.push(spendable);
          return { definition: fitBy('keep')(shaped), withinFunds: true };
        },
      },
    };
  }

  it('leaves a turn with nothing to fit against as it was built', () => {
    expect(sizedTurnAnswers(STAMPED, undefined, { shapeAt: atLoop }).definition).toBe(STAMPED);
  });

  it('fits a turn that sets nothing aside against its whole funding', () => {
    const { asked, fit } = recordingFit(1000n);
    sizedTurnAnswers(STAMPED, fit, { shapeAt: atLoop });
    expect(asked).toEqual([1000n]);
  });

  it('fits a settled turn against its funding less the reserve set aside', () => {
    const { asked, fit } = recordingFit(1000n);
    sizedTurnAnswers(STAMPED, fit, { shapeAt: atLoop, setAsideNanoUsd: 150n });
    expect(asked).toEqual([850n]);
  });

  it('fits a per-rung turn once per rung and once at its loop, each at its whole funding', () => {
    const { asked, fit } = recordingFit(1000n);
    const sized = sizedTurnAnswers(STAMPED, fit, { shapeAt: atLoop, perRung: PLAN });
    expect(asked).toEqual([1000n, 1000n, 1000n]);
    expect(searchingOf(sized.definition).rungCeilings).toStrictEqual({
      low: LOW_STEPS,
      high: HIGH_STEPS,
    });
  });
});

describe('a sized turn says whether its answers fit their funding', () => {
  /** An answer fit whose verdict is over funds exactly where `overAt` says. */
  function fitOverFundsAt(overAt: 'nowhere' | 'everywhere' | 'low rung'): AnswerFit {
    return {
      spendableNanoUsd: 1000n,
      fit: (shaped) => ({
        definition: fitBy('keep')(shaped),
        withinFunds:
          overAt === 'nowhere' ||
          (overAt === 'low rung' && searchingOf(shaped).maxSteps !== LOW_STEPS),
      }),
    };
  }

  it('counts a turn with nothing to fit against as within funds', () => {
    expect(sizedTurnAnswers(STAMPED, undefined, { shapeAt: atLoop }).withinFunds).toBe(true);
  });

  it('carries the verdict of a turn fitted once', () => {
    const fit = fitOverFundsAt('everywhere');
    expect(sizedTurnAnswers(STAMPED, fit, { shapeAt: atLoop }).withinFunds).toBe(false);
  });

  it('counts a per-rung turn as within funds when every rung’s fit is', () => {
    const fit = fitOverFundsAt('nowhere');
    const sized = sizedTurnAnswers(STAMPED, fit, { shapeAt: atLoop, perRung: PLAN });
    expect(sized.withinFunds).toBe(true);
  });

  it('counts a per-rung turn as over funds when one rung’s fit lands above its funding', () => {
    const fit = fitOverFundsAt('low rung');
    const sized = sizedTurnAnswers(STAMPED, fit, { shapeAt: atLoop, perRung: PLAN });
    expect(sized.withinFunds).toBe(false);
  });
});

describe('the rungs a menu names', () => {
  it('reads each menu id as its rung, the off rung by its id', () => {
    expect(
      effortRungsOf([
        { optionId: 'off', label: 'Min' },
        { optionId: 'lite', label: 'Lite' },
        { optionId: 'low', label: 'Low' },
      ])
    ).toEqual(['off', 'lite', 'low']);
  });

  it('refuses a menu naming an id outside the effort domain rather than dropping it', () => {
    expect(() =>
      effortRungsOf([
        { optionId: 'low', label: 'Low' },
        { optionId: 'not-a-rung', label: 'None' },
      ])
    ).toThrow(RangeError);
  });

  it('refuses the same id when it sits beside a rung the settlement would otherwise skip', () => {
    expect(() =>
      settledRungOf([
        { optionId: 'low', label: 'Low' },
        { optionId: 'not-a-rung', label: 'None' },
      ])
    ).toThrow(RangeError);
  });
});

describe('the rung a menu that marks exactly one available settles', () => {
  it('settles the off rung, matched by its id', () => {
    expect(settledRungOf([{ optionId: 'off', label: 'Min' }])).toBe('off');
  });

  it('settles a rung of the ladder', () => {
    expect(settledRungOf([{ optionId: 'low', label: 'Low' }])).toBe('low');
  });

  it('settles nothing on a menu that marks no rung', () => {
    expect(settledRungOf([])).toBeUndefined();
  });

  it('settles nothing on a menu that marks two rungs', () => {
    expect(
      settledRungOf([
        { optionId: 'off', label: 'Min' },
        { optionId: 'lite', label: 'Lite' },
      ])
    ).toBeUndefined();
  });

  it('refuses an id outside the effort domain rather than reading it as a rung', () => {
    expect(() => settledRungOf([{ optionId: 'minimal', label: 'Minimal' }])).toThrow(RangeError);
  });
});
