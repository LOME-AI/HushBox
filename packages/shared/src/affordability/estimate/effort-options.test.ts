import { describe, it, expect } from 'vitest';

import { CANONICAL_REASONING_EFFORTS } from '../reasoning-effort.ts';
import {
  effortSelectionForTurn,
  resolveEffortForModel,
  turnEffortOptions,
} from './effort-options.ts';
import { offeredLevels, planReasoning, reasoningBudgetForWire } from './reasoning-plan.ts';
import type { EffortChoice } from './effort-options.ts';
import type { ModelReasoning } from '../model/model-descriptor.ts';
import type { ReasoningPlanModel } from './reasoning-plan.ts';
import type { CanonicalReasoningEffort } from '../reasoning-effort.ts';

/** Effort-native model enumerating (descending) high/medium/low → ladder [low, medium, high]. */
const effortModel: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  contextLength: 200_000,
};

/** Budget-native model (no effort vocabulary) — full five-rung ladder. */
const budgetModel: ReasoningPlanModel = { reasoning: {}, contextLength: 200_000 };

const mandatoryModel: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  contextLength: 200_000,
};

/** Mandatory single-level vocabulary: offers nothing — no choice exists. */
const mandatoryOneLevel: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['high'], mandatory: true },
  contextLength: 200_000,
};

/** Two-rung vocabulary (descending) → ladder [low, high]. */
const twoRungModel: ReasoningPlanModel = {
  reasoning: { supportedEfforts: ['xhigh', 'xlow'] },
  contextLength: 200_000,
};

const plainModel: ReasoningPlanModel = { contextLength: 8192 };

const position = (label: CanonicalReasoningEffort): number =>
  CANONICAL_REASONING_EFFORTS.indexOf(label);

function levelChoices(options: readonly { choice: EffortChoice }[]): EffortChoice[] {
  return options.map((option) => option.choice);
}

describe('turnEffortOptions', () => {
  it('returns the single model ladder plus Min for a disableable model', () => {
    expect(levelChoices(turnEffortOptions([budgetModel]))).toEqual([
      'off',
      'lite',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('unions offered levels across a heterogeneous selection', () => {
    expect(levelChoices(turnEffortOptions([effortModel, twoRungModel]))).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
  });

  it('omits Min when no selected model can disable reasoning', () => {
    expect(levelChoices(turnEffortOptions([mandatoryModel]))).toEqual(['low', 'medium', 'high']);
  });

  it('omits Min when the only non-mandatory model is not reasoning-capable', () => {
    expect(levelChoices(turnEffortOptions([mandatoryModel, plainModel]))).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('includes Min when any model can disable, even alongside a mandatory model', () => {
    expect(levelChoices(turnEffortOptions([mandatoryModel, budgetModel]))).toContain('off');
  });

  it('is empty for an empty selection', () => {
    expect(turnEffortOptions([])).toEqual([]);
  });

  it('is empty when no selected model reasons', () => {
    expect(turnEffortOptions([plainModel])).toEqual([]);
  });

  it("sizes each option by the selection's largest resolved reasoning budget", () => {
    const options = turnEffortOptions([effortModel]);
    const high = options.find((option) => option.choice === 'high');
    expect(high?.maxReasoningBudgetTokens).toBe(32_768);
    const off = options.find((option) => option.choice === 'off');
    expect(off?.maxReasoningBudgetTokens).toBe(0);
  });

  it('sizes Min by the mandatory sibling forced up to its lowest rung', () => {
    const options = turnEffortOptions([mandatoryModel, budgetModel]);
    const off = options.find((option) => option.choice === 'off');
    // The budget-native sibling turns off (0); the mandatory sibling runs low (4096).
    expect(off?.maxReasoningBudgetTokens).toBe(4096);
  });

  it('sizes a level by the largest budget across siblings after per-model clamps', () => {
    const cappedBudgetModel: ReasoningPlanModel = {
      reasoning: {},
      contextLength: 200_000,
      maxOutputTokens: 8192,
    };
    const options = turnEffortOptions([effortModel, cappedBudgetModel]);
    const high = options.find((option) => option.choice === 'high');
    // effortModel's high tier (32768) dominates the capped sibling's 8192.
    expect(high?.maxReasoningBudgetTokens).toBe(32_768);
  });

  it('carries the tightest declared completion cap across the selection', () => {
    const a: ReasoningPlanModel = {
      reasoning: {},
      contextLength: 200_000,
      maxOutputTokens: 16_000,
    };
    const b: ReasoningPlanModel = { reasoning: {}, contextLength: 200_000, maxOutputTokens: 8192 };
    for (const option of turnEffortOptions([a, b])) {
      expect(option.completionCapTokens).toBe(8192);
    }
  });

  it('carries the declared cap even when a sibling declares none', () => {
    const capped: ReasoningPlanModel = {
      reasoning: {},
      contextLength: 200_000,
      maxOutputTokens: 16_000,
    };
    const options = turnEffortOptions([capped, budgetModel]);
    expect(options[0]?.completionCapTokens).toBe(16_000);
  });

  it('leaves the completion cap undefined when no model declares a valid one', () => {
    const invalidCap: ReasoningPlanModel = {
      reasoning: {},
      contextLength: 200_000,
      maxOutputTokens: 0,
    };
    const options = turnEffortOptions([invalidCap]);
    expect(options[0]?.completionCapTokens).toBeUndefined();
  });
});

describe('resolveEffortForModel', () => {
  it('resolves an offered level exactly', () => {
    const resolved = resolveEffortForModel(effortModel, 'medium');
    expect(resolved).toMatchObject({ kind: 'level', level: { label: 'medium' } });
  });

  it('downgrades an unoffered level to the nearest offered level below', () => {
    const resolved = resolveEffortForModel(twoRungModel, 'medium');
    expect(resolved).toMatchObject({ kind: 'level', level: { label: 'low' } });
  });

  it('never resolves upward when a lower rung exists', () => {
    const resolved = resolveEffortForModel(twoRungModel, 'max');
    expect(resolved).toMatchObject({ kind: 'level', level: { label: 'high' } });
  });

  it('resolves a choice below the whole ladder of a disableable model to off', () => {
    // Single-rung vocabulary offers only high; lite sits below it.
    const oneRung: ReasoningPlanModel = {
      reasoning: { supportedEfforts: ['high'] },
      contextLength: 200_000,
    };
    expect(resolveEffortForModel(oneRung, 'lite')).toEqual({ kind: 'off' });
  });

  it('resolves a choice below a mandatory ladder up to the lowest rung — the one upward exception', () => {
    const resolved = resolveEffortForModel(mandatoryModel, 'lite');
    expect(resolved).toMatchObject({ kind: 'level', level: { label: 'low' } });
  });

  it('resolves Min to off on a disableable model', () => {
    expect(resolveEffortForModel(budgetModel, 'off')).toEqual({ kind: 'off' });
  });

  it('resolves Min on a mandatory model to its lowest rung', () => {
    const resolved = resolveEffortForModel(mandatoryModel, 'off');
    expect(resolved).toMatchObject({ kind: 'level', level: { label: 'low' } });
  });

  it('resolves to the one rung of a mandatory single-level model, never to default', () => {
    // Its budget is spent by the provider either way, so the wire says so and
    // pricing can see it. `off` resolves UP to that rung — the mandatory
    // carve-out — because downward is impossible for such a model.
    const expected = { kind: 'level', level: { label: 'high' } };
    expect(resolveEffortForModel(mandatoryOneLevel, 'off')).toMatchObject(expected);
    expect(resolveEffortForModel(mandatoryOneLevel, 'high')).toMatchObject(expected);
  });

  it('resolves everything to default on a non-reasoning model', () => {
    expect(resolveEffortForModel(plainModel, 'high')).toEqual({ kind: 'default' });
    expect(resolveEffortForModel(plainModel, 'off')).toEqual({ kind: 'default' });
  });

  it('carries the exact offered wire for the resolved level', () => {
    const resolved = resolveEffortForModel(effortModel, 'high');
    if (resolved.kind !== 'level') throw new Error('expected a level resolution');
    expect(resolved.level.wire).toEqual({ effort: 'high' });
  });
});

/**
 * Bounded-exhaustive property block: every reasoning shape the descriptor
 * schema admits (native vocabularies of every length 0–6, mandatory or not,
 * budget-native, null-enumeration, non-reasoning), singly and in pairs.
 */
describe('effort option properties over the model space', () => {
  const nativeWords = ['w6', 'w5', 'w4', 'w3', 'w2', 'w1'];
  const reasoningShapes: (ModelReasoning | undefined)[] = [
    undefined,
    {},
    { mandatory: true },
    { supportedEfforts: null },
    { supportedEfforts: null, mandatory: true },
    ...Array.from({ length: 7 }, (_, n) => n).flatMap((n) => [
      { supportedEfforts: nativeWords.slice(0, n) },
      { supportedEfforts: nativeWords.slice(0, n), mandatory: true },
    ]),
  ];
  const space: ReasoningPlanModel[] = reasoningShapes.map((reasoning) => ({
    reasoning,
    contextLength: 200_000,
  }));

  const offeredLabelsOf = (model: ReasoningPlanModel): CanonicalReasoningEffort[] =>
    offeredLevels(model).map((level) => level.label);

  const modelCanDisable = (model: ReasoningPlanModel): boolean =>
    model.reasoning !== undefined && model.reasoning.mandatory !== true;

  it('options are exactly the union of offered ladders, plus Min iff any model can disable', () => {
    for (const a of space) {
      for (const b of space) {
        const options = turnEffortOptions([a, b]);
        const labels = options
          .map((option) => option.choice)
          .filter((choice): choice is CanonicalReasoningEffort => choice !== 'off');
        const union = CANONICAL_REASONING_EFFORTS.filter(
          (label) => offeredLabelsOf(a).includes(label) || offeredLabelsOf(b).includes(label)
        );
        expect(labels).toEqual(union);
        const hasMin = options.some((option) => option.choice === 'off');
        expect(hasMin).toBe(modelCanDisable(a) || modelCanDisable(b));
      }
    }
  });

  /**
   * Independent oracle re-stating the ruled resolution semantics: nearest
   * offered rung at or below the choice; below the whole ladder → off when
   * disableable, lowest rung when mandatory (the one upward exception);
   * nothing offered and no off → provider default.
   */
  function expectedResolution(
    model: ReasoningPlanModel,
    chosen: EffortChoice
  ): { kind: string; label?: CanonicalReasoningEffort } {
    const offered = offeredLabelsOf(model);
    const chosenPosition = chosen === 'off' ? -1 : position(chosen);
    const bestAtOrBelow = offered.findLast((label) => position(label) <= chosenPosition);
    if (bestAtOrBelow !== undefined) return { kind: 'level', label: bestAtOrBelow };
    if (modelCanDisable(model)) return { kind: 'off' };
    const lowest = offered[0];
    if (lowest !== undefined) return { kind: 'level', label: lowest };
    return { kind: 'default' };
  }

  it('resolution is exact or downward, with the mandatory lowest-rung exception', () => {
    const choices: EffortChoice[] = ['off', ...CANONICAL_REASONING_EFFORTS];
    for (const model of space) {
      for (const chosen of choices) {
        const resolved = resolveEffortForModel(model, chosen);
        const expected = expectedResolution(model, chosen);
        expect(resolved.kind).toBe(expected.kind);
        if (resolved.kind === 'level') {
          expect(resolved.level.label).toBe(expected.label);
        }
      }
    }
  });

  it('every resolved level budget equals the shared wire budget for that rung', () => {
    for (const model of space) {
      const options = turnEffortOptions([model]);
      for (const option of options) {
        const resolved = resolveEffortForModel(model, option.choice);
        const expected =
          resolved.kind === 'level' ? reasoningBudgetForWire(model, resolved.level.wire) : 0;
        expect(option.maxReasoningBudgetTokens).toBe(expected);
      }
    }
  });

  it('single-model explicit picks stay refusals, never substitutions', () => {
    for (const model of space) {
      const offered = offeredLabelsOf(model);
      for (const label of CANONICAL_REASONING_EFFORTS) {
        if (offered.includes(label)) continue;
        const plan = planReasoning(model, label, 1000);
        expect(plan.feasible).toBe(false);
      }
    }
  });
});

describe('effortSelectionForTurn', () => {
  const text = { modality: 'text', smartSlot: false } as const;

  it('keeps the preferred level when the turn offers it', () => {
    expect(effortSelectionForTurn({ ...text, preferred: 'high', models: [effortModel] })).toBe(
      'high'
    );
  });

  it('lowers a level no selected model offers to the nearest offered rung below', () => {
    expect(effortSelectionForTurn({ ...text, preferred: 'max', models: [effortModel] })).toBe(
      'high'
    );
  });

  it('lowers a preference no selected model offers to the nearest offered rung below', () => {
    expect(effortSelectionForTurn({ ...text, preferred: 'medium', models: [twoRungModel] })).toBe(
      'low'
    );
  });

  it('resolves a drawn slot against the rungs its candidates offer', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'max',
        models: [],
        slotCandidates: [effortModel, twoRungModel],
      })
    ).toBe('high');
  });

  it('sends no reasoning field when a drawn slot could become nothing that reasons', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'high',
        models: [],
        slotCandidates: [plainModel],
      })
    ).toBeUndefined();
  });

  it('unions the pinned siblings with the drawn slot candidates', () => {
    // The pinned sibling carries the only Min in the selection; the candidates
    // carry the only rungs. Either read alone loses one of them.
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'off',
        models: [budgetModel],
        slotCandidates: [mandatoryModel],
      })
    ).toBe('off');
  });

  it('passes auto through on a reasoning-capable selection', () => {
    expect(effortSelectionForTurn({ ...text, preferred: 'auto', models: [effortModel] })).toBe(
      'auto'
    );
  });

  it('keeps the off rung when no selected model requires reasoning', () => {
    expect(
      effortSelectionForTurn({ ...text, preferred: 'off', models: [effortModel, budgetModel] })
    ).toBe('off');
  });

  it('keeps the off rung when one selected model can disable and a sibling cannot', () => {
    // The turn's own option set carries Min as soon as ONE model can disable,
    // and the server honours it — the mandatory sibling runs its lowest rung.
    // Substituting `auto` here would refuse a rung the menu renders selectable.
    expect(
      effortSelectionForTurn({ ...text, preferred: 'off', models: [effortModel, mandatoryModel] })
    ).toBe('off');
  });

  it('clamps the off rung to auto when no selected model can disable reasoning', () => {
    expect(effortSelectionForTurn({ ...text, preferred: 'off', models: [mandatoryModel] })).toBe(
      'auto'
    );
  });

  it('sends nothing on a non-text modality', () => {
    expect(
      effortSelectionForTurn({
        preferred: 'high',
        models: [effortModel],
        modality: 'image',
        smartSlot: false,
      })
    ).toBeUndefined();
  });

  it('sends the preference itself for a slot-only turn', () => {
    for (const preferred of ['auto', 'high', 'off'] as const) {
      expect(
        effortSelectionForTurn({ modality: 'text', smartSlot: true, preferred, models: [] })
      ).toBe(preferred);
    }
  });

  // The slot is an ANSWER SOURCE on this axis, and its ladder is in potential:
  // the server derives its candidates at the pin, so every choice is one the
  // slot can answer. A turn drawing the slot therefore rides the preference
  // whatever the pinned siblings offer — each of them resolves downward or runs
  // wire-silent — and the pool-aware graded set is the only further clamp.
  it('sends the pin on a mixed turn whose pinned model offers it', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'high',
        models: [effortModel],
      })
    ).toBe('high');
  });

  it('sends the pin on a mixed turn whose pinned model cannot reason', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'high',
        models: [plainModel],
      })
    ).toBe('high');
  });

  it('sends the pin on a mixed turn whose pinned model tops out below it', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'max',
        models: [effortModel],
      })
    ).toBe('max');
  });

  it('sends the off rung on a mixed turn with a mandatory pinned model', () => {
    // The mandatory sibling resolves UP to its lowest rung — the axis's one
    // upward move — while the slot's candidates take the off wire wherever
    // they can disable. Neither is a refusal, so nothing here substitutes.
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'off',
        models: [mandatoryModel],
      })
    ).toBe('off');
  });

  // The slot always has a ladder in potential, so a pinned set offering nothing
  // must not suppress the selection: omitting the field would close the slot's
  // own effort classification and with it the reserve that pays for the call.
  it('keeps auto on a mixed turn whose pinned model cannot reason', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'auto',
        models: [plainModel],
      })
    ).toBe('auto');
  });

  it('sends the off rung on a mixed turn whose pinned model has nothing to disable', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'off',
        models: [plainModel],
      })
    ).toBe('off');
  });

  it('sends nothing when the selection offers no level at all', () => {
    expect(
      effortSelectionForTurn({ ...text, preferred: 'auto', models: [plainModel] })
    ).toBeUndefined();
  });
});

describe('effortSelectionForTurn — the funding term', () => {
  const text = { modality: 'text', smartSlot: false } as const;

  it('keeps the preferred level when the graded set still enables it', () => {
    expect(
      effortSelectionForTurn({
        ...text,
        preferred: 'high',
        models: [effortModel],
        enabled: ['low', 'medium', 'high'],
      })
    ).toBe('high');
  });

  it('lowers a preference the graded set disables to the nearest enabled rung below', () => {
    expect(
      effortSelectionForTurn({
        ...text,
        preferred: 'high',
        models: [effortModel],
        enabled: ['low', 'medium'],
      })
    ).toBe('medium');
  });

  it('lowers to the off rung when it is the only enabled choice', () => {
    expect(
      effortSelectionForTurn({
        ...text,
        preferred: 'high',
        models: [effortModel, budgetModel],
        enabled: ['off'],
      })
    ).toBe('off');
  });

  it('falls to auto when the graded set enables nothing', () => {
    expect(
      effortSelectionForTurn({ ...text, preferred: 'high', models: [effortModel], enabled: [] })
    ).toBe('auto');
  });

  it('leaves the selection alone when no graded set is in hand', () => {
    expect(effortSelectionForTurn({ ...text, preferred: 'high', models: [effortModel] })).toBe(
      'high'
    );
  });

  it('lowers a slot-only turn, whose pin the server derives its candidates at', () => {
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'high',
        models: [],
        enabled: ['low', 'medium'],
      })
    ).toBe('medium');
  });

  it('sends no reasoning field at all when the selection has no ladder', () => {
    // The model clamp answers this one before funding is consulted: a
    // ladderless selection has nothing to engage, so the field is omitted
    // rather than lowered. The graded set never has to answer "which rung" for
    // a turn that offers none.
    expect(
      effortSelectionForTurn({
        ...text,
        preferred: 'high',
        models: [plainModel],
        enabled: [],
      })
    ).toBeUndefined();
  });

  it('leaves auto alone — it names no rung to be unable to fund', () => {
    expect(
      effortSelectionForTurn({ ...text, preferred: 'auto', models: [effortModel], enabled: [] })
    ).toBe('auto');
  });

  it('ranks the off rung below every canonical rung when picking the nearest enabled', () => {
    expect(
      effortSelectionForTurn({
        ...text,
        preferred: 'high',
        models: [effortModel, budgetModel],
        enabled: ['off', 'lite', 'low'],
      })
    ).toBe('low');
  });

  it('falls to auto rather than raising when every enabled choice sits above the chosen one', () => {
    // Lowering is downward-only: a funding verdict that leaves only rungs
    // ABOVE the chosen one enables nothing the turn can drop to, and `auto`
    // is the answer for "this turn cannot honour the choice". Raising would
    // spend a reasoning budget the payer never asked for.
    expect(
      effortSelectionForTurn({
        modality: 'text',
        smartSlot: true,
        preferred: 'off',
        models: [plainModel],
        enabled: ['low', 'medium', 'high'],
      })
    ).toBe('auto');
  });
});
