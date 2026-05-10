import atkinsonUrl from './atkinson-hyperlegible.woff2?url';
import openDyslexicUrl from './open-dyslexic.woff2?url';
import lexendUrl from './lexend.woff2?url';

export interface AccessibilityFont {
  id: 'system' | 'atkinson' | 'open-dyslexic' | 'lexend';
  purpose: string;
  displayName: string;
  /** Resolved asset URL for the woff2 binary, or null for the system entry (no override). */
  url: string | null;
  license: 'OFL' | 'Apache-2.0';
  designedFor: ('general' | 'low-vision' | 'dyslexia' | 'cognitive')[];
}

export const ACCESSIBILITY_FONTS: readonly AccessibilityFont[] = [
  {
    id: 'system',
    purpose: 'Site default',
    displayName: 'Merriweather',
    url: null,
    license: 'OFL',
    designedFor: ['general'],
  },
  {
    id: 'atkinson',
    purpose: 'For low vision',
    displayName: 'Atkinson Hyperlegible',
    url: atkinsonUrl,
    license: 'OFL',
    designedFor: ['low-vision', 'general'],
  },
  {
    id: 'open-dyslexic',
    purpose: 'For dyslexia',
    displayName: 'OpenDyslexic',
    url: openDyslexicUrl,
    license: 'OFL',
    designedFor: ['dyslexia'],
  },
  {
    id: 'lexend',
    purpose: 'For reading speed',
    displayName: 'Lexend',
    url: lexendUrl,
    license: 'OFL',
    designedFor: ['general', 'cognitive'],
  },
];

export function getFont(id: AccessibilityFont['id']): AccessibilityFont | undefined {
  return ACCESSIBILITY_FONTS.find((f) => f.id === id);
}
