import type { AccessibilityPreferences } from '../store/schema';

export type ProfileId =
  | 'vision-friendly'
  | 'reading-focus'
  | 'motion-sensitive'
  | 'color-vision'
  | 'cognitive-load';

export interface AccessibilityProfile {
  id: ProfileId;
  label: string;
  description: string; // short, what kind of friction it helps with
  preset: Partial<AccessibilityPreferences>;
}

/**
 * One-click preset bundles. Labeled by *kind of friction*, not by claiming to "fix" the user.
 * Applying a profile MERGES its preset into the current settings (does NOT reset other settings).
 */
export const ACCESSIBILITY_PROFILES: readonly AccessibilityProfile[] = [
  {
    id: 'vision-friendly',
    label: 'Vision-friendly starter',
    description: 'High contrast, larger text, strong focus rings, large cursor.',
    preset: {
      contrast: 'high',
      fontSize: '150',
      focusWidth: '4',
      focusHalo: true,
      cursorSize: 'large',
    },
  },
  {
    id: 'reading-focus',
    label: 'Reading focus starter',
    description: 'Reading guide, dyslexia-friendly font, looser line spacing, no animations.',
    preset: {
      readingGuide: true,
      fontFamily: 'atkinson',
      lineHeight: '2.0',
      stopAnimations: 'force-on',
    },
  },
  {
    id: 'motion-sensitive',
    label: 'Motion-sensitive starter',
    description: 'No animations, reduced saturation, light theme.',
    preset: {
      stopAnimations: 'force-on',
      saturation: '100',
      theme: 'light',
    },
  },
  {
    id: 'color-vision',
    label: 'Color vision starter',
    description: 'Highlights links by underline + outline. Pick a color-vision filter below.',
    preset: {
      highlightLinks: true,
      // Note: doesn't auto-pick a colorblind type — user chooses
    },
  },
  {
    id: 'cognitive-load',
    label: 'Cognitive-load starter',
    description: 'Force left-align, reading guide, hide images, reader mode.',
    preset: {
      forceLeftAlign: true,
      readingGuide: true,
      hideImages: true,
      readerView: true,
    },
  },
];

export function getProfile(id: ProfileId): AccessibilityProfile | undefined {
  return ACCESSIBILITY_PROFILES.find((p) => p.id === id);
}
