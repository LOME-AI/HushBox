import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  reconcileAccessibilityPreferences,
  type AccessibilityPreferences,
} from './schema';
import { createWebStorageAdapter, type A11yStorageAdapter } from './storage-adapter';
import type { StateCreator } from 'zustand';

export const A11Y_STORAGE_KEY = 'hushbox.a11y.v1';

export interface A11yStore extends AccessibilityPreferences {
  /** ISO timestamp of the last mutation; null until first edit. Drives LWW server sync. */
  updatedAt: string | null;
  /** Update one or more settings. Persisted via the configured adapter. */
  update: (changes: Partial<AccessibilityPreferences>) => void;
  /** Reset all settings to schema defaults. */
  reset: () => void;
}

function parseUpdatedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? value : null;
}

const stateCreator: StateCreator<A11yStore> = (set) => ({
  ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
  updatedAt: null,
  update: (changes) => {
    set((state) => ({ ...state, ...changes, updatedAt: new Date().toISOString() }));
  },
  reset: () => {
    set({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS, updatedAt: new Date().toISOString() });
  },
});

/** Factory: create the accessibility store with a custom storage adapter. Defaults to web localStorage. */
export function createA11yStore(adapter: A11yStorageAdapter = createWebStorageAdapter()) {
  return create<A11yStore>()(
    persist(stateCreator, {
      name: A11Y_STORAGE_KEY,
      storage: adapter,
      merge: (persisted, current) => {
        const blob =
          persisted && typeof persisted === 'object' ? (persisted as Record<string, unknown>) : {};
        return {
          ...current,
          ...reconcileAccessibilityPreferences(blob),
          updatedAt: parseUpdatedAt(blob['updatedAt']),
        };
      },
    })
  );
}

/** Default singleton store (web localStorage adapter). */
export const useA11yStore = createA11yStore();
