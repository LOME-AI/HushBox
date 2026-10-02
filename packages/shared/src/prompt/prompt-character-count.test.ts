import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '../testing/test-time.ts';
import { historyCharacterCount, promptCharacterCount } from './prompt-character-count.ts';
import { buildTurnSystemPrompt } from './system-prompt.ts';

const UTC_DAY = isoAt(TEST_DAY_START).slice(0, 10);

describe('historyCharacterCount', () => {
  it('returns 0 for an empty history', () => {
    expect(historyCharacterCount([])).toBe(0);
  });

  it('sums the content length of every history turn', () => {
    expect(
      historyCharacterCount([
        { content: 'first question' },
        { content: 'first answer' },
        { content: '' },
      ])
    ).toBe('first question'.length + 'first answer'.length);
  });
});

describe('promptCharacterCount', () => {
  it('counts system prompt + history + current input', () => {
    const systemPrompt = buildTurnSystemPrompt({ utcDay: UTC_DAY });
    expect(
      promptCharacterCount({
        systemPrompt,
        historyCharacters: 26,
        prompt: 'and now?',
      })
    ).toBe(systemPrompt.length + 26 + 'and now?'.length);
  });

  it('counts only the system prompt when history and input are empty', () => {
    const systemPrompt = buildTurnSystemPrompt({
      utcDay: UTC_DAY,
      customInstructions: 'Answer only in French.',
    });
    expect(promptCharacterCount({ systemPrompt, historyCharacters: 0, prompt: '' })).toBe(
      systemPrompt.length
    );
  });
});
