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

describe('imageSuggestions', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(imageSuggestions)).toBe(true);
    expect(imageSuggestions.length).toBeGreaterThan(0);
  });

  it('has a single category with image label', () => {
    expect(imageSuggestions).toHaveLength(1);
    const category = imageSuggestions[0];
    expect(category?.label).toBe('Image ideas');
  });

  it('category has at least 6 prompts', () => {
    const category = imageSuggestions[0];
    expect(category?.prompts.length).toBeGreaterThanOrEqual(6);
  });
});

describe('videoSuggestions', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(videoSuggestions)).toBe(true);
    expect(videoSuggestions.length).toBeGreaterThan(0);
  });

  it('has a single category with video label', () => {
    expect(videoSuggestions).toHaveLength(1);
    const category = videoSuggestions[0];
    expect(category?.label).toBe('Video ideas');
  });

  it('category has at least 6 prompts', () => {
    const category = videoSuggestions[0];
    expect(category?.prompts.length).toBeGreaterThanOrEqual(6);
  });
});

describe('audioSuggestions', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(audioSuggestions)).toBe(true);
    expect(audioSuggestions.length).toBeGreaterThan(0);
  });

  it('has a single category with audio label', () => {
    expect(audioSuggestions).toHaveLength(1);
    const category = audioSuggestions[0];
    expect(category?.label).toBe('Audio ideas');
  });

  it('category has at least 6 prompts', () => {
    const category = audioSuggestions[0];
    expect(category?.prompts.length).toBeGreaterThanOrEqual(6);
  });
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
