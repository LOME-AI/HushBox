import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StorageValue } from 'zustand/middleware';
import { createWebStorageAdapter } from './storage-adapter';
import type { AccessibilityPreferences } from './schema';

const FAKE_VALUE: StorageValue<AccessibilityPreferences> = {
  state: { theme: 'dark' } as unknown as AccessibilityPreferences,
  version: 0,
};

describe('createWebStorageAdapter', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
  });

  describe('with localStorage available', () => {
    it('setItem stores a JSON-encoded value', () => {
      const adapter = createWebStorageAdapter();
      adapter.setItem('test-key', FAKE_VALUE);
      const raw = globalThis.window.localStorage.getItem('test-key');
      expect(raw).toBe(JSON.stringify(FAKE_VALUE));
    });

    it('getItem retrieves and JSON-parses a stored value', () => {
      globalThis.window.localStorage.setItem('test-key', JSON.stringify(FAKE_VALUE));
      const adapter = createWebStorageAdapter();
      const result = adapter.getItem('test-key');
      expect(result).toEqual(FAKE_VALUE);
    });

    it('getItem returns null when the key is missing', () => {
      const adapter = createWebStorageAdapter();
      expect(adapter.getItem('does-not-exist')).toBeNull();
    });

    it('getItem returns null when stored JSON is corrupt', () => {
      globalThis.window.localStorage.setItem('bad-key', '{not valid json');
      const adapter = createWebStorageAdapter();
      expect(adapter.getItem('bad-key')).toBeNull();
    });

    it('removeItem deletes the stored key', () => {
      globalThis.window.localStorage.setItem('removable', JSON.stringify(FAKE_VALUE));
      const adapter = createWebStorageAdapter();
      adapter.removeItem('removable');
      expect(globalThis.window.localStorage.getItem('removable')).toBeNull();
    });
  });

  describe('SSR safety (no window)', () => {
    let originalWindow: typeof globalThis.window | undefined;

    beforeEach(() => {
      originalWindow = globalThis.window;
      // Simulate SSR: window is undefined.
      Object.defineProperty(globalThis, 'window', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        writable: true,
        configurable: true,
      });
    });

    it('getItem returns null when window is undefined', () => {
      const adapter = createWebStorageAdapter();
      expect(adapter.getItem('any')).toBeNull();
    });

    it('setItem is a no-op when window is undefined', () => {
      const adapter = createWebStorageAdapter();
      expect(() => {
        adapter.setItem('any', FAKE_VALUE);
      }).not.toThrow();
    });

    it('removeItem is a no-op when window is undefined', () => {
      const adapter = createWebStorageAdapter();
      expect(() => {
        adapter.removeItem('any');
      }).not.toThrow();
    });
  });

  describe('safety when localStorage is unavailable', () => {
    let originalLocalStorage: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis.window, 'localStorage');
      Object.defineProperty(globalThis.window, 'localStorage', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      if (originalLocalStorage) {
        Object.defineProperty(globalThis.window, 'localStorage', originalLocalStorage);
      }
    });

    it('getItem returns null when window.localStorage is unavailable', () => {
      const adapter = createWebStorageAdapter();
      expect(adapter.getItem('any')).toBeNull();
    });

    it('setItem is a no-op when window.localStorage is unavailable', () => {
      const adapter = createWebStorageAdapter();
      expect(() => {
        adapter.setItem('any', FAKE_VALUE);
      }).not.toThrow();
    });

    it('removeItem is a no-op when window.localStorage is unavailable', () => {
      const adapter = createWebStorageAdapter();
      expect(() => {
        adapter.removeItem('any');
      }).not.toThrow();
    });
  });

  describe('returns a fresh instance each call', () => {
    it('two adapters share the same backing storage', () => {
      const a = createWebStorageAdapter();
      const b = createWebStorageAdapter();
      a.setItem('shared', FAKE_VALUE);
      expect(b.getItem('shared')).toEqual(FAKE_VALUE);
    });
  });

  it('exposes getItem, setItem, removeItem', () => {
    const adapter = createWebStorageAdapter();
    expect(typeof adapter.getItem).toBe('function');
    expect(typeof adapter.setItem).toBe('function');
    expect(typeof adapter.removeItem).toBe('function');
  });
});
