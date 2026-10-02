import { describe, expect, it } from 'vitest';
import { serializeSegments } from '@hushbox/shared';
import { cheapestClassifierEffort } from '@hushbox/shared/affordability';
import {
  TURN_DECISION_SCHEMA_NAME,
  TurnDecision,
  decideTurn,
  decisionDomainInput,
} from './turn-decision.js';
import type { ResolvedReasoningEffort } from '@hushbox/shared';

/** The domain of a turn with no Smart Model slot: presented rungs and no candidate. */
function presentedOnly(efforts: readonly ResolvedReasoningEffort[]): string {
  return decisionDomainInput({ presentedEfforts: efforts, candidates: [] });
}

describe('decideTurn over a candidate list', () => {
  /** A menu of Min and Lite, whose second candidate carries a cap for Min alone. */
  const DOMAIN = decisionDomainInput({
    presentedEfforts: ['off', 'lite'],
    candidates: [
      { id: 'vendor/engine', answerableRungs: ['off', 'lite'] },
      { id: 'vendor/mandatory', answerableRungs: ['off'] },
      { id: 'vendor/ladderless', answerableRungs: ['off', 'lite'] },
      { id: 'vendor/open', answerableRungs: ['off', 'lite'] },
    ],
  });

  it('decides the highest rung at or below the answer that the bound candidate answers at', () => {
    const decision = decideTurn('p', 'model: vendor/mandatory\neffort: Lite', DOMAIN);

    expect({ modelId: decision.modelId, effort: decision.effort }).toEqual({
      modelId: 'vendor/mandatory',
      effort: 'off',
    });
  });

  it('binds the first candidate at a rung it answers at when the answer names no model', () => {
    const fallbackFirst = decisionDomainInput({
      presentedEfforts: ['off', 'lite'],
      candidates: [
        { id: 'vendor/mandatory', answerableRungs: ['off'] },
        { id: 'vendor/engine', answerableRungs: ['off', 'lite'] },
      ],
    });

    const decision = decideTurn('p', 'effort: Lite', fallbackFirst);

    expect({ modelId: decision.modelId, effort: decision.effort }).toEqual({
      modelId: 'vendor/mandatory',
      effort: 'off',
    });
  });

  it('binds no candidate on a turn that listed none', () => {
    expect(
      decideTurn('p', 'model: vendor/engine\neffort: Low', LOW_AND_HIGH).modelId
    ).toBeUndefined();
  });

  it('refuses a domain it cannot read rather than deciding without it', () => {
    expect(() => decideTurn('p', 'effort: Low', 'low,high')).toThrow();
  });
});

/**
 * A turn that opened the effort axis. Every effort assertion needs one: the rung
 * a turn runs at is resolved among the options its prompt presented, so a closed
 * axis has no rung to resolve at all — which is its own describe below.
 */
const LOW_AND_HIGH = presentedOnly(['low', 'high']);

describe('decideTurn', () => {
  it('applies the declared effort fallback when no classifier answered', () => {
    // §Reasoning Effort 8's rule, not a rung named twice: the fallback IS the
    // axis's cheapest option. The second assertion is what discriminates — a
    // mid-rung fallback (the constant this collapsed) would satisfy the first
    // only if the axis reordered, and would fail this one outright.
    expect(decideTurn('write me a poem').effort).toBe(cheapestClassifierEffort());
    expect(decideTurn('write me a poem').effort).not.toBe('medium');
  });

  it('carries the prompt through to every consumer', () => {
    expect(decideTurn('write me a poem').prompt).toBe('write me a poem');
  });

  it('resolves the effort dimension from its labelled line', () => {
    const decision = decideTurn('p', 'model: openai/gpt-x\neffort: High', LOW_AND_HIGH);
    expect(decision.effort).toBe('high');
  });

  it('reads only labelled lines, so an added dimension cannot shift another', () => {
    const decision = decideTurn('p', 'search: yes\neffort: Low\nmodel: openai/gpt-x', LOW_AND_HIGH);
    expect(decision.effort).toBe('low');
  });

  it('falls back to the cheapest presented option when the answer names a level outside the ladder', () => {
    expect(decideTurn('p', 'effort: turbo-max-overdrive', LOW_AND_HIGH).effort).toBe('low');
  });

  it('parses the answer out of a reasoning-capable classifier value', () => {
    const value = serializeSegments([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'weighing options\neffort: Low\n' }] },
      { kind: 'text', text: 'effort: Lite' },
    ]);
    expect(decideTurn('p', value, presentedOnly(['lite', 'low'])).effort).toBe('lite');
  });
});

const RUNGS = ['low', 'medium', 'high'] as const;

describe('decideTurn over the options the turn PRESENTED', () => {
  const PRESENTED = presentedOnly(RUNGS);

  it('takes a level the turn presented', () => {
    expect(decideTurn('p', 'effort: Mid', PRESENTED).effort).toBe('medium');
  });

  it('refuses a level the turn did not present, however well the axis knows it', () => {
    // The same answer, twice: a turn that offered `lite` runs at it, and a turn
    // that offered the identical rung set minus `lite` must not — the rung is
    // declared and resolvable either way (§Reasoning Effort 8).
    expect(decideTurn('p', 'effort: Lite', presentedOnly(['lite', ...RUNGS])).effort).toBe('lite');
    expect(decideTurn('p', 'effort: Lite', PRESENTED).effort).toBe('low');
  });

  it('falls back to the cheapest PRESENTED option rather than the axis cheapest', () => {
    expect(decideTurn('p', undefined, PRESENTED).effort).toBe('low');
    expect(decideTurn('p', undefined, PRESENTED).effort).not.toBe(cheapestClassifierEffort());
  });

  it('keeps the axis fallback when the turn presented nothing', () => {
    expect(decideTurn('p', undefined, presentedOnly([])).effort).toBe(cheapestClassifierEffort());
  });
});

describe('decideTurn when the turn presented no effort option', () => {
  it('runs at the axis fallback when the answer names a rung the turn never presented', () => {
    // The prompt never offered the effort axis, so a rung named on it was never
    // priced into the turn's reservation and cannot be honoured.
    expect(decideTurn('p', 'effort: High').effort).toBe(cheapestClassifierEffort());
  });
});

describe('TurnDecision', () => {
  it('names the registered schema', () => {
    expect(TURN_DECISION_SCHEMA_NAME).toBe('turnDecision');
    expect(TurnDecision.safeParse({ prompt: '', effort: 'medium' }).success).toBe(true);
  });

  it('carries the bound candidate', () => {
    expect(
      TurnDecision.parse({ prompt: '', modelId: 'vendor/engine', effort: 'off' }).modelId
    ).toBe('vendor/engine');
  });

  it('rejects an effort outside the closed ladder', () => {
    expect(TurnDecision.safeParse({ prompt: '', effort: 'turbo' }).success).toBe(false);
  });
});
