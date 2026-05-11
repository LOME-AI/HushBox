import { describe, it, expect } from 'vitest';
import {
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  accessibilityPreferencesSchema,
} from '@hushbox/shared';
import {
  ACCESSIBILITY_PROFILES,
  getProfile,
  type AccessibilityProfile,
  type ProfileId,
} from './profiles';

describe('ACCESSIBILITY_PROFILES', () => {
  const expectedIds: ProfileId[] = [
    'vision-friendly',
    'reading-focus',
    'motion-sensitive',
    'color-vision',
    'cognitive-load',
  ];

  it('exposes exactly five profile entries', () => {
    expect(ACCESSIBILITY_PROFILES).toHaveLength(5);
  });

  it('contains all expected profile ids', () => {
    const compare = (a: string, b: string): number => a.localeCompare(b);
    const ids = ACCESSIBILITY_PROFILES.map((profile) => profile.id);
    expect(ids.toSorted(compare)).toEqual([...expectedIds].toSorted(compare));
  });

  it('every profile has a non-empty label and description', () => {
    for (const profile of ACCESSIBILITY_PROFILES) {
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.description.length).toBeGreaterThan(0);
    }
  });

  it('every profile preset is a full, valid AccessibilityPreferences object', () => {
    for (const profile of ACCESSIBILITY_PROFILES) {
      expect(() => accessibilityPreferencesSchema.parse(profile.preset)).not.toThrow();
    }
  });

  it('every profile preset has the same keys as the defaults (full opinion)', () => {
    const compare = (a: string, b: string): number => a.localeCompare(b);
    const expectedKeys = Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS).toSorted(compare);
    for (const profile of ACCESSIBILITY_PROFILES) {
      expect(Object.keys(profile.preset).toSorted(compare)).toEqual(expectedKeys);
    }
  });

  it('vision-friendly preset turns visual aids up', () => {
    const profile = getProfile('vision-friendly');
    expect(profile?.preset.contrast).toBe('high');
    expect(profile?.preset.fontSize).toBe('150');
    expect(profile?.preset.focusHalo).toBe(true);
    expect(profile?.preset.cursorSize).toBe('large');
  });

  it('reading-focus preset chooses dyslexia-friendly font and reading guide', () => {
    const profile = getProfile('reading-focus');
    expect(profile?.preset.fontFamily).toBe('atkinson');
    expect(profile?.preset.readingGuide).toBe(true);
    expect(profile?.preset.lineHeight).toBe('2.0');
    expect(profile?.preset.stopAnimations).toBe(true);
  });

  it('motion-sensitive preset stops animations and softens colors', () => {
    const profile = getProfile('motion-sensitive');
    expect(profile?.preset.stopAnimations).toBe(true);
    expect(profile?.preset.saturation).toBe('50');
    expect(profile?.preset.muteSounds).toBe(true);
  });

  it('color-vision preset highlights links and strengthens focus', () => {
    const profile = getProfile('color-vision');
    expect(profile?.preset.highlightLinks).toBe(true);
    expect(profile?.preset.focusHalo).toBe(true);
  });

  it('cognitive-load preset reduces distractions', () => {
    const profile = getProfile('cognitive-load');
    expect(profile?.preset.forceLeftAlign).toBe(true);
    expect(profile?.preset.readingGuide).toBe(true);
    expect(profile?.preset.stopAnimations).toBe(true);
    expect(profile?.preset.muteSounds).toBe(true);
  });

  it('compile-time: AccessibilityProfile shape is correct', () => {
    const profile: AccessibilityProfile = ACCESSIBILITY_PROFILES[0]!;
    const id: ProfileId = profile.id;
    const label: string = profile.label;
    const description: string = profile.description;
    expect(id).toBeDefined();
    expect(label).toBeDefined();
    expect(description).toBeDefined();
  });
});

describe('getProfile', () => {
  it.each<ProfileId>([
    'vision-friendly',
    'reading-focus',
    'motion-sensitive',
    'color-vision',
    'cognitive-load',
  ])('returns the profile entry for known id %s', (id) => {
    const profile = getProfile(id);
    expect(profile).toBeDefined();
    expect(profile?.id).toBe(id);
  });

  it('returns undefined for an unknown id', () => {
    const profile = getProfile('nonexistent-profile' as ProfileId);
    expect(profile).toBeUndefined();
  });
});
