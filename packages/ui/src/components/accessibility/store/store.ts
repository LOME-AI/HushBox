import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { StateCreator } from 'zustand';
import {
  accessibilityPreferencesSchema,
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  type AccessibilityPreferences,
} from './schema';
import { createWebStorageAdapter, type A11yStorageAdapter } from './storage-adapter';

export const A11Y_STORAGE_KEY = 'hushbox.a11y.v1';

export interface A11yStore extends AccessibilityPreferences {
  /** Update one or more settings. Persisted via the configured adapter. */
  update: (changes: Partial<AccessibilityPreferences>) => void;
  /** Reset all settings to schema defaults. */
  reset: () => void;
}

const stateCreator: StateCreator<A11yStore> = (set) => ({
  ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
  update: (changes) => {
    set((state) => ({ ...state, ...changes }));
  },
  reset: () => {
    set({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  },
});

/** Factory: create the accessibility store with a custom storage adapter. Defaults to web localStorage. */
export function createA11yStore(adapter: A11yStorageAdapter = createWebStorageAdapter()) {
  return create<A11yStore>()(
    persist(stateCreator, {
      name: A11Y_STORAGE_KEY,
      storage: adapter,
      // Defensive merge: re-parse persisted state through Zod so legacy/missing keys get defaults.
      // If the persisted blob is invalid, swallow the error and fall back to current defaults.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<AccessibilityPreferences>) };
        try {
          const parsed = accessibilityPreferencesSchema.parse(merged);
          return { ...current, ...parsed };
        } catch {
          return current;
        }
      },
    })
  );
}

/** Default singleton store (web localStorage adapter). */
export const useA11yStore = createA11yStore();
