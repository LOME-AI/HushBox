import { describe, expect, it } from 'vitest';

import { resolveClassifierAnswer } from './answer-resolution.ts';
import { effortDomainOptions } from '../dimensions/effort.ts';
import { REASONING_OFF } from '../reasoning-effort.ts';

const ALL_EFFORTS = effortDomainOptions().map((option) => option.optionId);
/** Two candidates with no per-rung record, so each answers at every rung. */
const CANDIDATES = ['openai/gpt-5', 'anthropic/claude-opus-4'].map((id) => ({
  id,
  answerableRungs: ALL_EFFORTS,
}));

/** A menu of Min and Lite, whose mandatory candidate answers at Min alone. */
const ENGINE = { id: 'vendor/engine', answerableRungs: ['off', 'lite'] };
const MANDATORY = { id: 'vendor/mandatory', answerableRungs: ['off'] };
const MIN_AND_LITE = ['off', 'lite'];

describe('resolveClassifierAnswer over candidates that answer at some rungs only', () => {
  it('clamps the effort down to the highest rung the named candidate answers at', () => {
    const resolved = resolveClassifierAnswer(
      'model: vendor/mandatory\neffort: Lite',
      MIN_AND_LITE,
      [ENGINE, MANDATORY]
    );

    expect(resolved).toEqual({ modelId: 'vendor/mandatory', effort: REASONING_OFF });
  });

  it('keeps the named effort when the named candidate answers at it', () => {
    const resolved = resolveClassifierAnswer('model: vendor/engine\neffort: Lite', MIN_AND_LITE, [
      ENGINE,
      MANDATORY,
    ]);

    expect(resolved).toEqual({ modelId: 'vendor/engine', effort: 'lite' });
  });

  it('binds the first candidate, the declared fallback, when the answer names none, and clamps against it', () => {
    const resolved = resolveClassifierAnswer('effort: Lite', MIN_AND_LITE, [MANDATORY, ENGINE]);

    expect(resolved).toEqual({ modelId: 'vendor/mandatory', effort: REASONING_OFF });
  });

  it('keeps the effort an answer names beside a model outside the list, clamped against the fallback', () => {
    const presented = ['off', 'lite', 'low', 'medium'];
    const fallback = { id: 'vendor/first', answerableRungs: ['off', 'lite', 'low'] };

    const resolved = resolveClassifierAnswer(
      'model: mistralai/mistral-large\neffort: Mid',
      presented,
      [fallback, ENGINE]
    );

    expect(resolved).toEqual({ modelId: 'vendor/first', effort: 'low' });
  });

  it('takes the highest answerable rung at or below the answer, not the lowest', () => {
    const presented = ['off', 'lite', 'low', 'medium', 'high'];
    const gapped = { id: 'vendor/gapped', answerableRungs: ['off', 'low'] };

    const resolved = resolveClassifierAnswer('model: vendor/gapped\neffort: High', presented, [
      gapped,
    ]);

    expect(resolved.effort).toBe('low');
  });

  it('leaves the rung as resolved when the bound candidate answers at no rung at or below it', () => {
    // No producer lists such a candidate, and the rung is left for the slot to
    // refuse rather than replaced by one the answer never reached.
    const above = { id: 'vendor/above', answerableRungs: ['lite'] };

    const resolved = resolveClassifierAnswer('model: vendor/above\neffort: Min', MIN_AND_LITE, [
      above,
    ]);

    expect(resolved.effort).toBe(REASONING_OFF);
  });
});

describe('resolveClassifierAnswer', () => {
  it('reads each axis off its own labelled line', () => {
    const resolved = resolveClassifierAnswer(
      'model: openai/gpt-5\neffort: High',
      ALL_EFFORTS,
      CANDIDATES
    );

    expect(resolved.modelId).toBe('openai/gpt-5');
    expect(resolved.effort).toBe('high');
  });

  it('falls back to the cheapest PRESENTED option when the answer names an unpresented rung', () => {
    const presented = ['low', 'medium'];

    const resolved = resolveClassifierAnswer('effort: Max', presented, []);

    expect(resolved.effort).toBe('low');
  });

  it('falls back to the cheapest presented option when the answer names no rung', () => {
    const resolved = resolveClassifierAnswer('effort: turbo', ['medium', 'high'], []);

    expect(resolved.effort).toBe('medium');
  });

  it('binds the fallback when both axes are open and the answer is unlabelled', () => {
    // An unlabelled answer could belong to either axis, so it belongs to
    // neither: guessing from line order is how a positional protocol returns.
    const resolved = resolveClassifierAnswer('anthropic/claude-opus-4', ALL_EFFORTS, CANDIDATES);

    expect(resolved.modelId).toBe('openai/gpt-5');
  });

  it('takes an unlabelled answer as the model`s when no effort option was presented', () => {
    const resolved = resolveClassifierAnswer('anthropic/claude-opus-4', [], CANDIDATES);

    expect(resolved.modelId).toBe('anthropic/claude-opus-4');
  });

  it('resolves no effort when the turn presented none, rather than inventing one', () => {
    const resolved = resolveClassifierAnswer('effort: High', [], CANDIDATES);

    expect(resolved.effort).toBeUndefined();
  });

  it('resolves a candidate through the shared matcher, so a typo still binds', () => {
    const resolved = resolveClassifierAnswer('model: anthropic/claude-opus4', [], CANDIDATES);

    expect(resolved.modelId).toBe('anthropic/claude-opus-4');
  });

  it('binds the first candidate, the declared fallback, when the answer names none of them', () => {
    const resolved = resolveClassifierAnswer('model: mistralai/mistral-large', [], CANDIDATES);

    expect(resolved.modelId).toBe('openai/gpt-5');
  });

  it('names no candidate when the turn carries no candidate list', () => {
    const resolved = resolveClassifierAnswer('model: openai/gpt-5', ALL_EFFORTS, []);

    expect(resolved.modelId).toBeUndefined();
  });

  it('falls back on both axes for an empty answer', () => {
    const resolved = resolveClassifierAnswer('', ALL_EFFORTS, CANDIDATES);

    expect(resolved.modelId).toBe('openai/gpt-5');
    expect(resolved.effort).toBe(REASONING_OFF);
  });
});
