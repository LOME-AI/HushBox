import { describe, expect, it } from 'vitest';

import {
  buildClassifierMessages,
  CLASSIFIER_MAX_DESCRIPTION_CHARS,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
} from './prompts.js';

const MODELS = [
  {
    id: 'anthropic/claude-opus-4.6',
    description: 'Most capable model for complex reasoning and coding.',
  },
  { id: 'openai/gpt-5-nano', description: 'Cheap and fast.' },
];

describe('buildClassifierMessages', () => {
  it('returns a system message containing the classifier marker', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '[USER START]: hello',
      eligibleModels: MODELS,
    });
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system?.content).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
  });

  it('lists every eligible model in the system prompt', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '[USER START]: hi',
      eligibleModels: MODELS,
    });
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('anthropic/claude-opus-4.6');
    expect(system?.content).toContain('Most capable model for complex reasoning and coding.');
    expect(system?.content).toContain('openai/gpt-5-nano');
    expect(system?.content).toContain('Cheap and fast.');
  });

  it('truncates very long descriptions', () => {
    const longDesc = 'A'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS * 2);
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: [{ id: 'foo/bar', description: longDesc }],
    });
    const system = messages.find((m) => m.role === 'system');
    // Description rendered no longer than the cap.
    const renderedSegment = system?.content.split('foo/bar')[1] ?? '';
    expect(renderedSegment.length).toBeLessThanOrEqual(CLASSIFIER_MAX_DESCRIPTION_CHARS + 16);
  });

  it('puts the truncated conversation context in the user message', () => {
    const ctx = '[USER START]: write a python script\n\n[USER END]: that sorts a list';
    const messages = buildClassifierMessages({
      truncatedContext: ctx,
      eligibleModels: MODELS,
    });
    const user = messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    expect(user?.content).toContain(ctx);
  });

  it('instructs the model to reply with only the model id', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: MODELS,
    });
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content.toLowerCase()).toMatch(/(reply|respond|output).*model id/);
  });

  it('handles an empty eligible list without crashing', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: [],
    });
    expect(messages.length).toBeGreaterThan(0);
  });

  it('returns exactly two messages (system + user)', () => {
    const messages = buildClassifierMessages({
      truncatedContext: 'x',
      eligibleModels: MODELS,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });
});
