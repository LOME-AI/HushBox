import { describe, it, expect } from 'vitest';
import {
  textSuggestions,
  imageSuggestions,
  videoSuggestions,
  audioSuggestions,
  getSuggestionsForModality,
  type PromptSuggestion,
} from './prompt-suggestions';

describe('textSuggestions', () => {
  it('has 4 categories', () => {
    expect(textSuggestions).toHaveLength(4);
  });

  it('exports an array of suggestions', () => {
    expect(Array.isArray(textSuggestions)).toBe(true);
  });

  it('contains at least 4 suggestions', () => {
    expect(textSuggestions.length).toBeGreaterThanOrEqual(4);
  });

  it('each suggestion has an id property', () => {
    for (const suggestion of textSuggestions) {
      expect(suggestion).toHaveProperty('id');
      expect(typeof suggestion.id).toBe('string');
    }
  });

  it('each suggestion has a label property', () => {
    for (const suggestion of textSuggestions) {
      expect(suggestion).toHaveProperty('label');
      expect(typeof suggestion.label).toBe('string');
    }
  });

  it('each suggestion has a prompts array property', () => {
    for (const suggestion of textSuggestions) {
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
    for (const suggestion of textSuggestions) {
      expect(suggestion.prompts.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('each suggestion has an icon property', () => {
    for (const suggestion of textSuggestions) {
      expect(suggestion).toHaveProperty('icon');
      // LucideIcon is a forwardRef component which is an object
      expect(suggestion.icon).toBeDefined();
      expect(suggestion.icon.$$typeof).toBeDefined();
    }
  });

  it('all suggestion ids are unique', () => {
    const ids = textSuggestions.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('includes code-related suggestion', () => {
    const codeSuggestion = textSuggestions.find(
      (s) => s.id === 'code' || s.label.toLowerCase().includes('code')
    );
    expect(codeSuggestion).toBeDefined();
  });

  it('includes explanation suggestion', () => {
    const explainSuggestion = textSuggestions.find(
      (s) => s.id === 'explain' || s.label.toLowerCase().includes('explain')
    );
    expect(explainSuggestion).toBeDefined();
  });

  it('includes brainstorm suggestion', () => {
    const brainstormSuggestion = textSuggestions.find(
      (s) => s.id === 'brainstorm' || s.label.toLowerCase().includes('brainstorm')
    );
    expect(brainstormSuggestion).toBeDefined();
  });

  it('includes question suggestion', () => {
    const questionSuggestion = textSuggestions.find(
      (s) => s.id === 'question' || s.label.toLowerCase().includes('question')
    );
    expect(questionSuggestion).toBeDefined();
  });
});

describe('PromptSuggestion type', () => {
  it('first suggestion conforms to PromptSuggestion type', () => {
    const suggestion = textSuggestions[0];
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

function assertCategoryShape(suggestions: PromptSuggestion[], label: string): void {
  describe(`${label} shape`, () => {
    it('has 4 categories', () => {
      expect(suggestions).toHaveLength(4);
    });

    it('each suggestion has id, label, prompts, icon', () => {
      for (const suggestion of suggestions) {
        expect(typeof suggestion.id).toBe('string');
        expect(typeof suggestion.label).toBe('string');
        expect(Array.isArray(suggestion.prompts)).toBe(true);
        expect(suggestion.icon).toBeDefined();
      }
    });

    it('each category has at least 10 prompts and all are non-empty strings', () => {
      for (const suggestion of suggestions) {
        expect(suggestion.prompts.length).toBeGreaterThanOrEqual(10);
        for (const prompt of suggestion.prompts) {
          expect(typeof prompt).toBe('string');
          expect(prompt.length).toBeGreaterThan(0);
        }
      }
    });

    it('all suggestion ids are unique', () => {
      const ids = suggestions.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
}

describe('imageSuggestions', () => {
  assertCategoryShape(imageSuggestions, 'imageSuggestions');
});

describe('videoSuggestions', () => {
  assertCategoryShape(videoSuggestions, 'videoSuggestions');
});

describe('audioSuggestions', () => {
  assertCategoryShape(audioSuggestions, 'audioSuggestions');
});

describe('getSuggestionsForModality', () => {
  it('returns textSuggestions for "text"', () => {
    expect(getSuggestionsForModality('text')).toBe(textSuggestions);
  });

  it('returns imageSuggestions for "image"', () => {
    expect(getSuggestionsForModality('image')).toBe(imageSuggestions);
  });

  it('returns videoSuggestions for "video"', () => {
    expect(getSuggestionsForModality('video')).toBe(videoSuggestions);
  });

  it('returns audioSuggestions for "audio"', () => {
    expect(getSuggestionsForModality('audio')).toBe(audioSuggestions);
  });

  it('returns textSuggestions for undefined', () => {
    expect(getSuggestionsForModality()).toBe(textSuggestions);
  });
});
