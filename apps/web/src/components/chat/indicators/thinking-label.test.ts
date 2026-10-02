import { describe, it, expect } from 'vitest';
import { answerSubject, thinkingLabel } from '@/components/chat/indicators/thinking-label';

describe('thinkingLabel', () => {
  it('names the model that is working', () => {
    expect(thinkingLabel('GPT-4 Turbo')).toBe('GPT-4 Turbo is thinking');
  });

  it('names an unknown model AI when no name is given', () => {
    expect(thinkingLabel()).toBe('AI is thinking');
  });

  it('names an unknown model AI when the name is blank', () => {
    expect(thinkingLabel('   ')).toBe('AI is thinking');
  });

  it('drops the provider prefix so the label reads as the model alone', () => {
    expect(thinkingLabel('deepseek/deepseek-r1')).toBe('deepseek-r1 is thinking');
  });
});

describe('answerSubject', () => {
  it('names the model without its provider prefix', () => {
    expect(answerSubject('deepseek/deepseek-r1')).toBe('deepseek-r1');
  });

  it('names a model with no usable name AI', () => {
    expect(answerSubject('   ')).toBe('AI');
  });

  it('names a turn with no model name AI', () => {
    expect(answerSubject()).toBe('AI');
  });
});
