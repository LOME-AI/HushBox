import { describe, expect, it } from 'vitest';

import { offeredEffortRungs } from './effort-rungs.ts';
import type { ReasoningPlanModel } from '../estimate/reasoning-plan.ts';

/** Effort-native, three words (descending) → ladder [low, medium, high]. */
const threeRung: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  contextLength: 200_000,
};

/** Two words → ladder [low, high]; nothing on it reaches Mid or Max. */
const twoRung: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['xhigh', 'xlow'] },
  contextLength: 200_000,
};

/** Reasoning it cannot switch off, so it carries no off rung. */
const mandatory: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  contextLength: 200_000,
};

/** No reasoning metadata at all: it declares nothing on the axis. */
const ladderless: ReasoningPlanModel = { contextLength: 8192 };

function ids(sources: readonly ReasoningPlanModel[]): string[] {
  return offeredEffortRungs(sources).map((option) => option.optionId);
}

describe('offeredEffortRungs', () => {
  it('carries the off rung below every level a source declares', () => {
    expect(ids([threeRung])).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('omits the off rung when no source can disable reasoning', () => {
    expect(ids([mandatory])).toEqual(['low', 'medium', 'high']);
  });

  it('unions the sources rather than intersecting them', () => {
    // Per-model resolution falls downward, so a rung only one source names is
    // still one the turn can honour.
    expect(ids([twoRung, mandatory])).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('names each rung once however many sources declare it', () => {
    expect(ids([threeRung, threeRung, twoRung])).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('orders by the declared domain rather than by the order sources arrive in', () => {
    expect(ids([mandatory, twoRung])).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('carries the label the axis declares for each rung', () => {
    expect(offeredEffortRungs([twoRung]).map((option) => option.label)).toEqual([
      'Min',
      'Low',
      'High',
    ]);
  });

  it('is empty for sources that declare nothing on the axis', () => {
    expect(ids([ladderless])).toEqual([]);
  });

  it('is empty when there are no sources at all', () => {
    expect(ids([])).toEqual([]);
  });
});
