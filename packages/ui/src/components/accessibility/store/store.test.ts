import { describe, it, expect, beforeEach } from 'vitest';
import type { StorageValue } from 'zustand/middleware';
import { createA11yStore, useA11yStore, A11Y_STORAGE_KEY, type A11yStore } from './store';
import type { A11yStorageAdapter } from './storage-adapter';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS, type AccessibilityPreferences } from './schema';

/** Build an in-memory adapter we can introspect during tests. */
function createMemoryAdapter(initial: Record<string, string> = {}): A11yStorageAdapter & {
  store: Map<string, string>;
  setCallCount: number;
} {
  const store = new Map(Object.entries(initial));
  let setCallCount = 0;
  return {
    store,
    get setCallCount() {
      return setCallCount;
    },
    getItem: (name) => {
      const raw = store.get(name);
      if (raw === undefined) return null;
      return JSON.parse(raw) as StorageValue<AccessibilityPreferences>;
    },
    setItem: (name, value) => {
      setCallCount += 1;
      store.set(name, JSON.stringify(value));
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

describe('A11Y_STORAGE_KEY', () => {
  it('is a stable, versioned constant', () => {
    expect(A11Y_STORAGE_KEY).toBe('hushbox.a11y.v1');
  });
});

describe('createA11yStore', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
  });

  describe('initial state', () => {
    it('hydrates with all schema defaults', () => {
      const store = createA11yStore(createMemoryAdapter());
      const state = store.getState();
      for (const [key, value] of Object.entries(ACCESSIBILITY_PREFERENCES_DEFAULTS)) {
        expect(state[key as keyof AccessibilityPreferences]).toEqual(value);
      }
    });

    it('exposes update and reset action handlers', () => {
      const store = createA11yStore(createMemoryAdapter());
      const state = store.getState();
      expect(typeof state.update).toBe('function');
      expect(typeof state.reset).toBe('function');
    });
  });

  describe('update', () => {
    it('applies a partial update to state', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().update({ theme: 'dark' });
      expect(store.getState().theme).toBe('dark');
    });

    it('only changes specified fields, leaving others untouched', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().update({ theme: 'dark', fontSize: '150' });
      const state = store.getState();
      expect(state.theme).toBe('dark');
      expect(state.fontSize).toBe('150');
      expect(state.contrast).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast);
    });

    it('preserves the action handlers across updates', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().update({ theme: 'dark' });
      expect(typeof store.getState().update).toBe('function');
      expect(typeof store.getState().reset).toBe('function');
    });
  });

  describe('reset', () => {
    it('restores all settings to schema defaults', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().update({
        theme: 'dark',
        fontSize: '200',
        invert: true,
      });
      store.getState().reset();
      const state = store.getState();
      expect(state.theme).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.theme);
      expect(state.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
      expect(state.invert).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.invert);
    });
  });

  describe('persistence', () => {
    it('writes via the configured adapter on every change', () => {
      const adapter = createMemoryAdapter();
      const store = createA11yStore(adapter);
      const initialSetCalls = adapter.setCallCount;
      store.getState().update({ theme: 'dark' });
      expect(adapter.setCallCount).toBeGreaterThan(initialSetCalls);
      const stored = adapter.store.get(A11Y_STORAGE_KEY);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!) as StorageValue<AccessibilityPreferences>;
      expect(parsed.state.theme).toBe('dark');
    });

    it('uses the supplied adapter rather than the default web adapter', () => {
      const adapter = createMemoryAdapter();
      const store = createA11yStore(adapter);
      store.getState().update({ theme: 'light' });
      // Confirms our adapter (not localStorage) received the write.
      expect(adapter.store.has(A11Y_STORAGE_KEY)).toBe(true);
      expect(globalThis.window.localStorage.getItem(A11Y_STORAGE_KEY)).toBeNull();
    });

    it('uses the web localStorage adapter by default', () => {
      const store = createA11yStore();
      store.getState().update({ theme: 'dark' });
      const raw = globalThis.window.localStorage.getItem(A11Y_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as StorageValue<AccessibilityPreferences>;
      expect(parsed.state.theme).toBe('dark');
    });
  });

  describe('hydration', () => {
    it('hydrates from a partial persisted state, filling missing keys with defaults', () => {
      const partialPersisted: StorageValue<Partial<AccessibilityPreferences>> = {
        state: { theme: 'dark' },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(partialPersisted),
      });
      const store = createA11yStore(adapter);
      const state = store.getState();
      expect(state.theme).toBe('dark');
      expect(state.contrast).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast);
      expect(state.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
    });

    it('falls back to defaults when persisted state contains an invalid value', () => {
      const corruptPersisted: StorageValue<Record<string, unknown>> = {
        state: { theme: 'neon-pink' as unknown as 'dark' },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(corruptPersisted),
      });
      // Constructing should not throw — the merge step should swallow Zod errors and use defaults.
      const store = createA11yStore(adapter);
      const state = store.getState();
      expect(state.theme).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.theme);
    });

    it('hydrates correctly when the persisted blob is fully valid', () => {
      const fullPersisted: StorageValue<AccessibilityPreferences> = {
        state: {
          ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
          theme: 'light',
          fontSize: '125',
        },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(fullPersisted),
      });
      const store = createA11yStore(adapter);
      const state = store.getState();
      expect(state.theme).toBe('light');
      expect(state.fontSize).toBe('125');
    });
  });

  describe('typing', () => {
    it('returned store satisfies the A11yStore interface', () => {
      const store = createA11yStore(createMemoryAdapter());
      const state: A11yStore = store.getState();
      expect(state.version).toBe(1);
    });
  });
});

describe('useA11yStore (default singleton)', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  it('exposes the same shape as createA11yStore', () => {
    const state = useA11yStore.getState();
    expect(state.theme).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.theme);
    expect(typeof state.update).toBe('function');
    expect(typeof state.reset).toBe('function');
  });

  it('persists updates to globalThis.window.localStorage by default', () => {
    useA11yStore.getState().update({ theme: 'dark' });
    const raw = globalThis.window.localStorage.getItem(A11Y_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as StorageValue<AccessibilityPreferences>;
    expect(parsed.state.theme).toBe('dark');
  });
});
