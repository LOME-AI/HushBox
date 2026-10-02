import { describe, expect, it } from 'vitest';

import { planReasoning } from './reasoning-plan.ts';
import { reasoningBudgetForTurn } from './reasoning-budget-turn.ts';
import type { ReasoningBudgetModel } from './reasoning-budget-turn.ts';

function reasoner(id: string, maxOutputTokens: number): ReasoningBudgetModel {
  return {
    id,
    contextLength: 200_000,
    maxOutputTokens,
    reasoning: { supportedEfforts: ['low', 'medium', 'high'] },
  };
}

/** The budget the shared plan itself yields, so no expectation restates the ladder. */
function plannedBudget(model: ReasoningBudgetModel): number {
  const planned = planReasoning(model, 'medium', 1);
  if (!planned.feasible) throw new Error('fixture is not feasible at medium');
  return planned.plan.reasoningBudgetTokens;
}

describe('reasoningBudgetForTurn', () => {
  it('prices no budget for an absent selection', () => {
    const models = [reasoner('a', 64_000)];
    expect(
      reasoningBudgetForTurn({ selection: undefined, selectedIds: ['a'], catalog: models })
    ).toBeUndefined();
  });

  it('prices no budget for `auto` — its reserve resolves server-side', () => {
    const models = [reasoner('a', 64_000)];
    expect(
      reasoningBudgetForTurn({ selection: 'auto', selectedIds: ['a'], catalog: models })
    ).toBeUndefined();
  });

  it('prices no budget for `off` — the hard off is B = 0', () => {
    const models = [reasoner('a', 64_000)];
    expect(
      reasoningBudgetForTurn({ selection: 'off', selectedIds: ['a'], catalog: models })
    ).toBeUndefined();
  });

  it('prices the selected model’s own budget at an explicit level', () => {
    const model = reasoner('a', 64_000);
    expect(
      reasoningBudgetForTurn({ selection: 'medium', selectedIds: ['a'], catalog: [model] })
    ).toBe(plannedBudget(model));
  });

  it('prices the LARGEST budget across the selected models, matching the server gate', () => {
    const small = reasoner('small', 8000);
    const large = reasoner('large', 64_000);
    expect(plannedBudget(large)).toBeGreaterThan(plannedBudget(small));
    expect(
      reasoningBudgetForTurn({
        selection: 'medium',
        selectedIds: ['small', 'large'],
        catalog: [small, large],
      })
    ).toBe(plannedBudget(large));
  });

  it('lets a model that does not offer the level contribute nothing', () => {
    const offers = reasoner('offers', 64_000);
    const silent: ReasoningBudgetModel = { id: 'silent', contextLength: 200_000 };
    expect(
      reasoningBudgetForTurn({
        selection: 'medium',
        selectedIds: ['offers', 'silent'],
        catalog: [offers, silent],
      })
    ).toBe(plannedBudget(offers));
  });

  it('prices no budget when no selected model offers the level', () => {
    const silent: ReasoningBudgetModel = { id: 'silent', contextLength: 200_000 };
    expect(
      reasoningBudgetForTurn({ selection: 'medium', selectedIds: ['silent'], catalog: [silent] })
    ).toBeUndefined();
  });

  it('skips a selected id the catalog has not delivered', () => {
    const model = reasoner('a', 64_000);
    expect(
      reasoningBudgetForTurn({
        selection: 'medium',
        selectedIds: ['a', 'not-yet-served'],
        catalog: [model],
      })
    ).toBe(plannedBudget(model));
  });

  it('prices no budget while the catalog is unresolved', () => {
    expect(
      reasoningBudgetForTurn({ selection: 'medium', selectedIds: ['a'], catalog: undefined })
    ).toBeUndefined();
  });
});
