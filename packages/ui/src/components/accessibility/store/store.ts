import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { A11Y_STORAGE_KEY } from '@hushbox/shared';
import {
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  reconcileAccessibilityPreferences,
  type AccessibilityPreferences,
} from './schema';
import { createWebStorageAdapter, type A11yStorageAdapter } from './storage-adapter';
import type { Mutate, StateCreator, StoreApi, UseBoundStore } from 'zustand';

export interface A11yStore extends AccessibilityPreferences {
  /** ISO timestamp of the last mutation; null until first edit. Drives LWW server sync. */
  updatedAt: string | null;
  /**
   * Host-supplied reduced-motion override, ORed into the merged reduced-motion
   * signal. Not a user preference: never persisted, never synced, and untouched
   * by `update`/`reset`. It lives here because this store is the only state
   * `shouldReduceMotion()` can read synchronously from its non-React callers,
   * and because a component library must not read the host's build environment.
   */
  forcedReducedMotion: boolean;
  /** Update one or more settings. Persisted via the configured adapter. */
  update: (changes: Partial<AccessibilityPreferences>) => void;
  /** Reset all settings to schema defaults. */
  reset: () => void;
  /** Set the host override. Deliberately leaves `updatedAt` alone — a host flag is not an edit. */
  setForcedReducedMotion: (value: boolean) => void;
}

function parseUpdatedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? value : null;
}

const stateCreator: StateCreator<A11yStore> = (set) => ({
  ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
  updatedAt: null,
  forcedReducedMotion: false,
  setForcedReducedMotion: (value) => {
    set({ forcedReducedMotion: value });
  },
  update: (changes) => {
    set((state) => ({ ...state, ...changes, updatedAt: new Date().toISOString() }));
  },
  reset: () => {
    set({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS, updatedAt: new Date().toISOString() });
  },
});

/** Factory: create the accessibility store with a custom storage adapter. Defaults to web localStorage. */
export function createA11yStore(
  adapter: A11yStorageAdapter = createWebStorageAdapter()
): UseBoundStore<Mutate<StoreApi<A11yStore>, [['zustand/persist', AccessibilityPreferences]]>> {
  return create<A11yStore>()(
    persist(stateCreator, {
      name: A11Y_STORAGE_KEY,
      storage: adapter,
      // Schema-driven, matching the server-sync extract: the stored blob is the
      // preference set plus its timestamp. Keeps `forcedReducedMotion` — host
      // runtime state, not a user setting — out of localStorage entirely.
      partialize: (state) => ({
        ...reconcileAccessibilityPreferences(state),
        updatedAt: state.updatedAt,
      }),
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
