import { describe, expect, it } from 'vitest';

import { SHIPPED_FEATURES, COMING_SOON_FEATURES } from './features.ts';

describe('SHIPPED_FEATURES', () => {
  it('exposes a non-empty catalog of shipped features', () => {
    expect(SHIPPED_FEATURES.length).toBeGreaterThan(0);
  });

  it('fully describes every shipped feature', () => {
    for (const feature of SHIPPED_FEATURES) {
      expect(feature.id.length).toBeGreaterThan(0);
      expect(feature.name.length).toBeGreaterThan(0);
      expect(feature.description.length).toBeGreaterThan(0);
      expect(feature.emoji.length).toBeGreaterThan(0);
      expect(feature.lucideIcon.length).toBeGreaterThan(0);
    }
  });
});

describe('reasoning effort feature', () => {
  it('is listed as a shipped feature', () => {
    const feature = SHIPPED_FEATURES.find((f) => f.id === 'reasoning-effort');
    expect(feature).toBeDefined();
    expect(feature?.name).toBe('Reasoning Effort');
    expect(feature?.lucideIcon).toBe('BrainCircuit');
  });
});

describe('code execution feature', () => {
  it('is listed as a shipped feature, not a planned one', () => {
    const feature = SHIPPED_FEATURES.find((f) => f.id === 'code-execution');
    expect(feature).toBeDefined();
    expect(feature?.name).toBe('Code Execution');
    expect(feature?.lucideIcon).toBe('Play');
    expect(COMING_SOON_FEATURES.some((f) => f.id === 'code-execution')).toBe(false);
  });
});

describe('prompt autocomplete feature', () => {
  it('is listed as a shipped feature, not a planned one', () => {
    const feature = SHIPPED_FEATURES.find((f) => f.id === 'prompt-autocomplete');
    expect(feature).toBeDefined();
    expect(feature?.name).toBe('Prompt Autocomplete');
    expect(feature?.lucideIcon).toBe('TextCursorInput');
    expect(COMING_SOON_FEATURES.some((f) => f.id === 'prompt-autocomplete')).toBe(false);
  });
});

describe('COMING_SOON_FEATURES', () => {
  it('exposes a non-empty roadmap of planned features', () => {
    expect(COMING_SOON_FEATURES.length).toBeGreaterThan(0);
  });

  it('describes every planned feature with id, name, emoji, and icon', () => {
    for (const feature of COMING_SOON_FEATURES) {
      expect(feature.id.length).toBeGreaterThan(0);
      expect(feature.name.length).toBeGreaterThan(0);
      expect(feature.emoji.length).toBeGreaterThan(0);
      expect(feature.lucideIcon.length).toBeGreaterThan(0);
    }
  });
});

describe('feature identifiers', () => {
  it('are unique across shipped and planned features', () => {
    const ids = [
      ...SHIPPED_FEATURES.map((feature) => feature.id),
      ...COMING_SOON_FEATURES.map((feature) => feature.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
