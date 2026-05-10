import { describe, it, expect } from 'vitest';
import { ACCESSIBILITY_FONTS, getFont, type AccessibilityFont } from './registry';

describe('ACCESSIBILITY_FONTS', () => {
  it('contains exactly four entries', () => {
    expect(ACCESSIBILITY_FONTS).toHaveLength(4);
  });

  it('exposes the four expected ids in declared order', () => {
    expect(ACCESSIBILITY_FONTS.map((f) => f.id)).toEqual([
      'system',
      'atkinson',
      'open-dyslexic',
      'lexend',
    ]);
  });

  it('marks the system entry with a null url (no override)', () => {
    const system = ACCESSIBILITY_FONTS.find((f) => f.id === 'system');
    expect(system).toBeDefined();
    expect(system?.url).toBeNull();
  });

  it('provides a non-null url string for every non-system entry', () => {
    for (const font of ACCESSIBILITY_FONTS) {
      if (font.id === 'system') continue;
      expect(typeof font.url).toBe('string');
      expect(font.url).not.toBe('');
    }
  });

  it('every entry declares a purpose, displayName, license, and designedFor list', () => {
    for (const font of ACCESSIBILITY_FONTS) {
      expect(typeof font.purpose).toBe('string');
      expect(font.purpose.length).toBeGreaterThan(0);
      expect(typeof font.displayName).toBe('string');
      expect(font.displayName.length).toBeGreaterThan(0);
      expect(['OFL', 'Apache-2.0']).toContain(font.license);
      expect(Array.isArray(font.designedFor)).toBe(true);
      expect(font.designedFor.length).toBeGreaterThan(0);
    }
  });

  it('every designedFor tag is a known audience', () => {
    const known = new Set(['general', 'low-vision', 'dyslexia', 'cognitive']);
    for (const font of ACCESSIBILITY_FONTS) {
      for (const tag of font.designedFor) {
        expect(known.has(tag)).toBe(true);
      }
    }
  });

  it('atkinson entry advertises low-vision suitability', () => {
    const atkinson = ACCESSIBILITY_FONTS.find((f) => f.id === 'atkinson');
    expect(atkinson?.designedFor).toContain('low-vision');
  });

  it('open-dyslexic entry advertises dyslexia suitability', () => {
    const od = ACCESSIBILITY_FONTS.find((f) => f.id === 'open-dyslexic');
    expect(od?.designedFor).toContain('dyslexia');
  });

  it('lexend entry advertises cognitive-load suitability', () => {
    const lexend = ACCESSIBILITY_FONTS.find((f) => f.id === 'lexend');
    expect(lexend?.designedFor).toContain('cognitive');
  });
});

describe('getFont', () => {
  const ids: AccessibilityFont['id'][] = ['system', 'atkinson', 'open-dyslexic', 'lexend'];

  it.each(ids)('returns the registry entry for id %s', (id) => {
    const font = getFont(id);
    expect(font).toBeDefined();
    expect(font?.id).toBe(id);
  });

  it('returns the same reference held inside the registry array', () => {
    const fromRegistry = ACCESSIBILITY_FONTS.find((f) => f.id === 'atkinson');
    const fromGetter = getFont('atkinson');
    expect(fromGetter).toBe(fromRegistry);
  });

  it('returns undefined for an unknown id', () => {
    // @ts-expect-error — exercising the runtime fallback for an id outside the union.
    expect(getFont('not-a-real-font')).toBeUndefined();
  });
});
