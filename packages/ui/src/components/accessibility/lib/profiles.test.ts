import { describe, it, expect } from 'vitest';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
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

  it('every profile preset only contains keys that exist in AccessibilityPreferences', () => {
    const validKeys = new Set(Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS));
    for (const profile of ACCESSIBILITY_PROFILES) {
      for (const key of Object.keys(profile.preset)) {
        expect(validKeys.has(key)).toBe(true);
      }
    }
  });

  it('every profile preset has at least one key (presets are non-empty)', () => {
    for (const profile of ACCESSIBILITY_PROFILES) {
      expect(Object.keys(profile.preset).length).toBeGreaterThan(0);
    }
  });

  it('vision-friendly profile sets contrast/fontSize/focusWidth/focusHalo/cursorSize', () => {
    const profile = ACCESSIBILITY_PROFILES.find((p) => p.id === 'vision-friendly');
    expect(profile?.preset).toEqual({
      contrast: 'high',
      fontSize: '150',
      focusWidth: '4',
      focusHalo: true,
      cursorSize: 'large',
    });
  });

  it('reading-focus profile sets readingGuide/fontFamily/lineHeight/stopAnimations', () => {
    const profile = ACCESSIBILITY_PROFILES.find((p) => p.id === 'reading-focus');
    expect(profile?.preset).toEqual({
      readingGuide: true,
      fontFamily: 'atkinson',
      lineHeight: '2.0',
      stopAnimations: 'force-on',
    });
  });

  it('motion-sensitive profile sets stopAnimations/saturation/theme', () => {
    const profile = ACCESSIBILITY_PROFILES.find((p) => p.id === 'motion-sensitive');
    expect(profile?.preset).toEqual({
      stopAnimations: 'force-on',
      saturation: '100',
      theme: 'light',
    });
  });

  it('color-vision profile sets highlightLinks but does not auto-pick a colorblind type', () => {
    const profile = ACCESSIBILITY_PROFILES.find((p) => p.id === 'color-vision');
    expect(profile?.preset).toEqual({
      highlightLinks: true,
    });
    expect(profile?.preset.colorblindSimulate).toBeUndefined();
    expect(profile?.preset.colorblindCorrect).toBeUndefined();
  });

  it('cognitive-load profile sets forceLeftAlign/readingGuide/hideImages/readerView', () => {
    const profile = ACCESSIBILITY_PROFILES.find((p) => p.id === 'cognitive-load');
    expect(profile?.preset).toEqual({
      forceLeftAlign: true,
      readingGuide: true,
      hideImages: true,
      readerView: true,
    });
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

  it('returns the same reference each call (no copy)', () => {
    const a = getProfile('vision-friendly');
    const b = getProfile('vision-friendly');
    expect(a).toBe(b);
  });
});
