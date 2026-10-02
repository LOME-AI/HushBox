import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { AccessibilityPreferences } from './schema';

/** Adapter for persisting accessibility settings. Implementations: web (localStorage), Capacitor (Preferences plugin). */
export type A11yStorageAdapter = PersistStorage<AccessibilityPreferences>;

/** Default web adapter — wraps localStorage with JSON encoding. */
export function createWebStorageAdapter(): A11yStorageAdapter {
  return {
    getItem: (name) => {
      const storage = getLocalStorage();
      if (storage === null) return null;
      const raw = storage.getItem(name);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as StorageValue<AccessibilityPreferences>;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      const storage = getLocalStorage();
      if (storage === null) return;
      storage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name) => {
      const storage = getLocalStorage();
      if (storage === null) return;
      storage.removeItem(name);
    },
  };
}

/** Returns localStorage if it's available, else null. Safe under SSR or sandboxed iframes. */
function getLocalStorage(): Storage | null {
  // Cast through unknown so the SSR-undefined and missing-localStorage branches type-check
  // even when DOM lib types claim window/localStorage are always present.
  const win = (globalThis as { window?: Window }).window;
  if (!win) return null;
  const storage = (win as { localStorage?: Storage }).localStorage;
  if (!storage) return null;
  return storage;
}
