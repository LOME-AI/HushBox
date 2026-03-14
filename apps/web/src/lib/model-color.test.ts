import { describe, it, expect } from 'vitest';
import { modelIdToHue, getModelColor } from './model-color';

describe('modelIdToHue', () => {
  it('returns same hue for same model ID', () => {
    const hue1 = modelIdToHue('openai/gpt-4-turbo');
    const hue2 = modelIdToHue('openai/gpt-4-turbo');
    expect(hue1).toBe(hue2);
  });

  it('returns different hues for different model IDs', () => {
    const hue1 = modelIdToHue('openai/gpt-4-turbo');
    const hue2 = modelIdToHue('anthropic/claude-3.5-sonnet');
    expect(hue1).not.toBe(hue2);
  });

  it('returns hue in 0-360 range', () => {
    const ids = [
      'openai/gpt-4-turbo',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-pro',
      'meta-llama/llama-3.1-70b-instruct',
      'x-ai/grok-2',
    ];
    for (const id of ids) {
      const hue = modelIdToHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('produces visually distinct colors for common models', () => {
    const ids = [
      'openai/gpt-4-turbo',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-pro',
      'meta-llama/llama-3.1-70b-instruct',
      'x-ai/grok-2',
    ];
    const hues = ids.map((id) => modelIdToHue(id));

    // Every pair of hues should be at least 15 degrees apart
    for (let index = 0; index < hues.length; index++) {
      for (let index_ = index + 1; index_ < hues.length; index_++) {
        const diff = Math.abs(hues[index]! - hues[index_]!);
        const circularDiff = Math.min(diff, 360 - diff);
        expect(circularDiff).toBeGreaterThan(15);
      }
    }
  });
});

describe('getModelColor', () => {
  it('returns valid HSL strings', () => {
    const color = getModelColor('openai/gpt-4-turbo');
    expect(color.bg).toMatch(/^hsl\(\d+(\.\d+)? 45% 90%\)$/);
    expect(color.fg).toMatch(/^hsl\(\d+(\.\d+)? 60% 30%\)$/);
    expect(color.bgDark).toMatch(/^hsl\(\d+(\.\d+)? 30% 20%\)$/);
    expect(color.fgDark).toMatch(/^hsl\(\d+(\.\d+)? 45% 75%\)$/);
  });

  it('returns consistent colors for same ID', () => {
    const color1 = getModelColor('anthropic/claude-3.5-sonnet');
    const color2 = getModelColor('anthropic/claude-3.5-sonnet');
    expect(color1).toEqual(color2);
  });

  it('returns different colors for different IDs', () => {
    const color1 = getModelColor('openai/gpt-4-turbo');
    const color2 = getModelColor('anthropic/claude-3.5-sonnet');
    expect(color1.bg).not.toBe(color2.bg);
  });
});
