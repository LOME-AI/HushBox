import { describe, it, expect } from 'vitest';
import { promptSuggestions, type PromptSuggestion } from './prompt-suggestions';

describe('promptSuggestions', () => {
  it('exports an array of suggestions', () => {
    expect(Array.isArray(promptSuggestions)).toBe(true);
  });

  it('contains at least 4 suggestions', () => {
    expect(promptSuggestions.length).toBeGreaterThanOrEqual(4);
  });

  it('each suggestion has an id property', () => {
    for (const suggestion of promptSuggestions) {
      expect(suggestion).toHaveProperty('id');
      expect(typeof suggestion.id).toBe('string');
    }
  });

  it('each suggestion has a label property', () => {
    for (const suggestion of promptSuggestions) {
      expect(suggestion).toHaveProperty('label');
      expect(typeof suggestion.label).toBe('string');
    }
  });

  it('each suggestion has a prompts array property', () => {
    for (const suggestion of promptSuggestions) {
      expect(suggestion).toHaveProperty('prompts');
      expect(Array.isArray(suggestion.prompts)).toBe(true);
      expect(suggestion.prompts.length).toBeGreaterThan(0);
      for (const prompt of suggestion.prompts) {
        expect(typeof prompt).toBe('string');
        expect(prompt.length).toBeGreaterThan(0);
      }
    }
  });

  it('each category has at least 10 prompts', () => {
    for (const suggestion of promptSuggestions) {
      expect(suggestion.prompts.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('each suggestion has an icon property', () => {
    for (const suggestion of promptSuggestions) {
      expect(suggestion).toHaveProperty('icon');
      // LucideIcon is a forwardRef component which is an object
      expect(suggestion.icon).toBeDefined();
      expect(suggestion.icon.$$typeof).toBeDefined();
    }
  });

  it('all suggestion ids are unique', () => {
    const ids = promptSuggestions.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('includes code-related suggestion', () => {
    const codeSuggestion = promptSuggestions.find(
      (s) => s.id === 'code' || s.label.toLowerCase().includes('code')
    );
    expect(codeSuggestion).toBeDefined();
  });

  it('includes explanation suggestion', () => {
    const explainSuggestion = promptSuggestions.find(
      (s) => s.id === 'explain' || s.label.toLowerCase().includes('explain')
    );
    expect(explainSuggestion).toBeDefined();
  });

  it('includes brainstorm suggestion', () => {
    const brainstormSuggestion = promptSuggestions.find(
      (s) => s.id === 'brainstorm' || s.label.toLowerCase().includes('brainstorm')
    );
    expect(brainstormSuggestion).toBeDefined();
  });

  it('includes question suggestion', () => {
    const questionSuggestion = promptSuggestions.find(
      (s) => s.id === 'question' || s.label.toLowerCase().includes('question')
    );
    expect(questionSuggestion).toBeDefined();
  });
});

describe('PromptSuggestion type', () => {
  it('first suggestion conforms to PromptSuggestion type', () => {
    const suggestion = promptSuggestions[0];
    expect(suggestion).toBeDefined();
    if (!suggestion) return;
    const typed: PromptSuggestion = suggestion;
    expect(typed.id).toBeDefined();
    expect(typed.label).toBeDefined();
    expect(typed.prompts).toBeDefined();
    expect(Array.isArray(typed.prompts)).toBe(true);
    expect(typed.icon).toBeDefined();
  });
});
