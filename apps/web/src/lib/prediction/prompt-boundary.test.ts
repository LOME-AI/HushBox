import { describe, it, expect } from 'vitest';
import { healCompletion, healPromptBoundary } from './prompt-boundary';

describe('healPromptBoundary', () => {
  it('leaves text with no trailing whitespace unchanged', () => {
    const result = healPromptBoundary('the cat sat');
    expect(result).toEqual({ text: 'the cat sat', healedTrailingSpace: false });
  });

  it('strips a single trailing space', () => {
    const result = healPromptBoundary('the cat sat ');
    expect(result).toEqual({ text: 'the cat sat', healedTrailingSpace: true });
  });

  it('strips every trailing space, not just the last one', () => {
    const result = healPromptBoundary('the cat sat   ');
    expect(result).toEqual({ text: 'the cat sat', healedTrailingSpace: true });
  });

  it('strips a trailing tab', () => {
    const result = healPromptBoundary('the cat sat\t');
    expect(result).toEqual({ text: 'the cat sat', healedTrailingSpace: true });
  });

  it('leaves a trailing newline unhealed', () => {
    const result = healPromptBoundary('the cat sat\n');
    expect(result).toEqual({ text: 'the cat sat\n', healedTrailingSpace: false });
  });

  it('leaves a trailing space-then-newline unhealed, since the last character is not a space', () => {
    const result = healPromptBoundary('the cat sat \n');
    expect(result).toEqual({ text: 'the cat sat \n', healedTrailingSpace: false });
  });
});

describe('healCompletion', () => {
  it('returns the completion unchanged when no trailing space was healed', () => {
    expect(healCompletion('urday', false)).toBe('urday');
  });

  it('strips the single leading space a healed completion opens with', () => {
    expect(healCompletion(' on the mat', true)).toBe('on the mat');
  });

  it('refuses a completion that continues the last word instead of starting a new one', () => {
    expect(healCompletion('urday', true)).toBe('');
  });

  it('strips only one leading whitespace character, not a whole run', () => {
    expect(healCompletion('  on the mat', true)).toBe(' on the mat');
  });
});
