import { useEffect, useState } from 'react';

export interface OsPreferences {
  reducedMotion: boolean;
  colorScheme: 'light' | 'dark' | null;
  contrast: 'normal' | 'more' | 'less' | 'no-preference' | null;
}

const QUERIES = {
  reducedMotion: '(prefers-reduced-motion: reduce)',
  darkScheme: '(prefers-color-scheme: dark)',
  lightScheme: '(prefers-color-scheme: light)',
  contrastMore: '(prefers-contrast: more)',
  contrastLess: '(prefers-contrast: less)',
} as const;

const SSR_DEFAULTS: OsPreferences = {
  reducedMotion: false,
  colorScheme: null,
  contrast: null,
};

function pickColorScheme(): 'light' | 'dark' | null {
  if (globalThis.matchMedia(QUERIES.darkScheme).matches) return 'dark';
  if (globalThis.matchMedia(QUERIES.lightScheme).matches) return 'light';
  return null;
}

function pickContrast(): OsPreferences['contrast'] {
  if (globalThis.matchMedia(QUERIES.contrastMore).matches) return 'more';
  if (globalThis.matchMedia(QUERIES.contrastLess).matches) return 'less';
  return 'normal';
}

function readPreferences(): OsPreferences {
  if (!('window' in globalThis) || typeof globalThis.matchMedia !== 'function') {
    return SSR_DEFAULTS;
  }
  return {
    reducedMotion: globalThis.matchMedia(QUERIES.reducedMotion).matches,
    colorScheme: pickColorScheme(),
    contrast: pickContrast(),
  };
}

/**
 * useOsPreferences — reads the user's OS-level accessibility settings via matchMedia.
 * Returns reactive state that updates when the user changes their OS preferences.
 * Used to seed defaults for the accessibility widget.
 */
export function useOsPreferences(): OsPreferences {
  const [prefs, setPrefs] = useState<OsPreferences>(readPreferences);

  useEffect(() => {
    if (!('window' in globalThis) || typeof globalThis.matchMedia !== 'function') return;

    const mqs = Object.values(QUERIES).map((q) => globalThis.matchMedia(q));
    const handler = (): void => {
      setPrefs(readPreferences());
    };
    for (const mq of mqs) {
      mq.addEventListener('change', handler);
    }
    return () => {
      for (const mq of mqs) {
        mq.removeEventListener('change', handler);
      }
    };
  }, []);

  return prefs;
}
