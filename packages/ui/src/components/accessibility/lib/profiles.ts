import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
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
  description: string;
  /** Full snapshot — every setting has an opinion. Applying replaces all current settings. */
  preset: AccessibilityPreferences;
}

const BASE = ACCESSIBILITY_PREFERENCES_DEFAULTS;

export const ACCESSIBILITY_PROFILES: readonly AccessibilityProfile[] = [
  {
    id: 'vision-friendly',
    label: 'Easier to see',
    description: 'Higher contrast, bigger text, stronger focus rings, larger pointer.',
    preset: {
      ...BASE,
      contrast: 'high',
      saturation: '100',
      fontSize: '150',
      letterSpacing: '0.05',
      lineHeight: '1.5',
      paragraphSpacing: '2',
      focusWidth: '4',
      focusColor: 'yellow',
      focusHalo: true,
      cursorSize: 'large',
      cursorColor: 'black',
    },
  },
  {
    id: 'reading-focus',
    label: 'Easier to read',
    description: 'Dyslexia-friendly font, looser spacing, animations off.',
    preset: {
      ...BASE,
      contrast: 'normal',
      fontFamily: 'atkinson',
      fontSize: '125',
      letterSpacing: '0.05',
      lineHeight: '2.0',
      paragraphSpacing: '2',
      stopAnimations: true,
    },
  },
  {
    id: 'motion-sensitive',
    label: 'Calmer movement',
    description: 'Animations off, softer colors, autoplay paused.',
    preset: {
      ...BASE,
      stopAnimations: true,
      saturation: '50',
      muteSounds: true,
    },
  },
  {
    id: 'color-vision',
    label: 'Color help',
    description: 'Stronger focus colors that do not rely on hue alone.',
    preset: {
      ...BASE,
      focusWidth: '4',
      focusColor: 'magenta',
      focusHalo: true,
    },
  },
  {
    id: 'cognitive-load',
    label: 'Less distraction',
    description: 'Looser spacing, sound muted, animations off.',
    preset: {
      ...BASE,
      stopAnimations: true,
      muteSounds: true,
      lineHeight: '2.0',
      paragraphSpacing: '2',
    },
  },
];

export function getProfile(id: ProfileId): AccessibilityProfile | undefined {
  return ACCESSIBILITY_PROFILES.find((p) => p.id === id);
}
