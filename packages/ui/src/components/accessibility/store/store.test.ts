import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_START,
  isoAt,
  setClock,
} from '@hushbox/shared/test-time';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { A11Y_STORAGE_KEY } from '@hushbox/shared';
import { createA11yStore, useA11yStore, type A11yStore } from './store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS, type AccessibilityPreferences } from './schema';
import type { StorageValue } from 'zustand/middleware';
import type { A11yStorageAdapter } from './storage-adapter';

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
      expectExposes(state, 'update', 'reset');
    });
  });

  describe('update', () => {
    it('applies a partial update to state', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().update({ contrast: 'high' });
      expect(store.getState().contrast).toBe('high');
    });

    it('only changes specified fields, leaving others untouched', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().update({ contrast: 'high', fontSize: '141' });
      const state = store.getState();
      expect(state.contrast).toBe('high');
      expect(state.fontSize).toBe('141');
      expect(state.saturation).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.saturation);
    });

    it('preserves the action handlers across updates', () => {
      const store = createA11yStore(createMemoryAdapter());
      const { update, reset } = store.getState();
      store.getState().update({ contrast: 'high' });
      expect(store.getState().update).toBe(update);
      expect(store.getState().reset).toBe(reset);
    });
  });

  describe('reset', () => {
    it('restores all settings to schema defaults', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().update({
        contrast: 'high',
        fontSize: '141',
        magnifier: true,
      });
      store.getState().reset();
      const state = store.getState();
      expect(state.contrast).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast);
      expect(state.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
      expect(state.magnifier).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.magnifier);
    });
  });

  describe('forcedReducedMotion', () => {
    it('defaults to off', () => {
      const store = createA11yStore(createMemoryAdapter());
      expect(store.getState().forcedReducedMotion).toBe(false);
    });

    it('turns on when the host sets it', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().setForcedReducedMotion(true);
      expect(store.getState().forcedReducedMotion).toBe(true);
    });

    it('leaves updatedAt alone, so the server-sync subscriber ignores the write', () => {
      const store = createA11yStore(createMemoryAdapter());
      const before = store.getState().updatedAt;
      store.getState().setForcedReducedMotion(true);
      expect(store.getState().updatedAt).toBe(before);
    });

    it('survives a preference update', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().setForcedReducedMotion(true);
      store.getState().update({ contrast: 'high' });
      expect(store.getState().forcedReducedMotion).toBe(true);
    });

    it('survives a reset, which restores preferences and not host state', () => {
      const store = createA11yStore(createMemoryAdapter());
      store.getState().setForcedReducedMotion(true);
      store.getState().reset();
      expect(store.getState().forcedReducedMotion).toBe(true);
    });

    it('is never written to storage', () => {
      const adapter = createMemoryAdapter();
      const store = createA11yStore(adapter);
      store.getState().setForcedReducedMotion(true);
      store.getState().update({ contrast: 'high' });
      const parsed = JSON.parse(adapter.store.get(A11Y_STORAGE_KEY)!) as StorageValue<
        Record<string, unknown>
      >;
      expect(parsed.state).not.toHaveProperty('forcedReducedMotion');
    });
  });

  describe('persistence', () => {
    it('writes via the configured adapter on every change', () => {
      const adapter = createMemoryAdapter();
      const store = createA11yStore(adapter);
      const initialSetCalls = adapter.setCallCount;
      store.getState().update({ contrast: 'high' });
      expect(adapter.setCallCount).toBeGreaterThan(initialSetCalls);
      const stored = adapter.store.get(A11Y_STORAGE_KEY);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!) as StorageValue<AccessibilityPreferences>;
      expect(parsed.state.contrast).toBe('high');
    });

    it('uses the supplied adapter rather than the default web adapter', () => {
      const adapter = createMemoryAdapter();
      const store = createA11yStore(adapter);
      store.getState().update({ contrast: 'low' });
      expect(adapter.store.has(A11Y_STORAGE_KEY)).toBe(true);
      expect(globalThis.window.localStorage.getItem(A11Y_STORAGE_KEY)).toBeNull();
    });

    it('uses the web localStorage adapter by default', () => {
      const store = createA11yStore();
      store.getState().update({ contrast: 'high' });
      const raw = globalThis.window.localStorage.getItem(A11Y_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as StorageValue<AccessibilityPreferences>;
      expect(parsed.state.contrast).toBe('high');
    });
  });

  describe('hydration', () => {
    it('hydrates from a partial persisted state, filling missing keys with defaults', () => {
      const partialPersisted: StorageValue<Partial<AccessibilityPreferences>> = {
        state: { contrast: 'high' },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(partialPersisted),
      });
      const store = createA11yStore(adapter);
      const state = store.getState();
      expect(state.contrast).toBe('high');
      expect(state.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
    });

    it('falls back to defaults when persisted state contains an invalid value', () => {
      const corruptPersisted: StorageValue<Record<string, unknown>> = {
        state: { contrast: 'neon-pink' },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(corruptPersisted),
      });
      const store = createA11yStore(adapter);
      const state = store.getState();
      expect(state.contrast).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast);
    });

    it('hydrates correctly when the persisted blob is fully valid', () => {
      const fullPersisted: StorageValue<AccessibilityPreferences> = {
        state: {
          ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
          contrast: 'low',
          fontSize: '112',
        },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(fullPersisted),
      });
      const store = createA11yStore(adapter);
      const state = store.getState();
      expect(state.contrast).toBe('low');
      expect(state.fontSize).toBe('112');
    });
  });

  describe('typing', () => {
    it('returned store satisfies the A11yStore interface', () => {
      const store = createA11yStore(createMemoryAdapter());
      const state: A11yStore = store.getState();
      expect(state.version).toBe(1);
    });
  });

  describe('schema-driven hydration', () => {
    it('preserves valid fields and only defaults invalid ones', () => {
      const corrupt: StorageValue<Record<string, unknown>> = {
        state: {
          contrast: 'high',
          fontSize: 'huge',
          magnifier: true,
          saturation: 'rainbow',
          fontFamily: 'atkinson',
        },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(corrupt),
      });
      const store = createA11yStore(adapter);
      const state = store.getState();
      expect(state.contrast).toBe('high');
      expect(state.magnifier).toBe(true);
      expect(state.fontFamily).toBe('atkinson');
      expect(state.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
      expect(state.saturation).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.saturation);
    });

    it('drops unknown keys without overwriting schema fields', () => {
      const blob: StorageValue<Record<string, unknown>> = {
        state: {
          contrast: 'high',
          legacyDeprecatedField: 'something',
          anotherUnknown: { nested: true },
        },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(blob),
      });
      const store = createA11yStore(adapter);
      const state = store.getState() as A11yStore & Record<string, unknown>;
      expect(state.contrast).toBe('high');
      expect(state['legacyDeprecatedField']).toBeUndefined();
      expect(state['anotherUnknown']).toBeUndefined();
    });
  });

  describe('updatedAt', () => {
    it('has updatedAt: null in initial state', () => {
      const store = createA11yStore(createMemoryAdapter());
      expect(store.getState().updatedAt).toBeNull();
    });

    it('stamps updatedAt with current ISO timestamp on update()', () => {
      vi.useFakeTimers();
      try {
        setClock(TEST_DAY_START);
        const store = createA11yStore(createMemoryAdapter());
        store.getState().update({ contrast: 'high' });
        expect(store.getState().updatedAt).toBe(isoAt(TEST_DAY_START));
      } finally {
        vi.useRealTimers();
      }
    });

    it('stamps a fresh updatedAt on reset()', () => {
      vi.useFakeTimers();
      try {
        setClock(TEST_DAY_START);
        const store = createA11yStore(createMemoryAdapter());
        store.getState().update({ contrast: 'high' });

        setClock(TEST_DAY_START + 5 * SECOND_MS);
        store.getState().reset();
        expect(store.getState().updatedAt).toBe(isoAt(TEST_DAY_START + 5 * SECOND_MS));
      } finally {
        vi.useRealTimers();
      }
    });

    it('persists updatedAt through the adapter', () => {
      vi.useFakeTimers();
      try {
        setClock(TEST_DAY_START);
        const adapter = createMemoryAdapter();
        const store = createA11yStore(adapter);
        store.getState().update({ contrast: 'high' });
        const raw = adapter.store.get(A11Y_STORAGE_KEY);
        expect(raw).toBeDefined();
        const parsed = JSON.parse(raw!) as { state: { updatedAt: string } };
        expect(parsed.state.updatedAt).toBe(isoAt(TEST_DAY_START));
      } finally {
        vi.useRealTimers();
      }
    });

    it('hydrates updatedAt from a valid persisted ISO string', () => {
      const persisted: StorageValue<Record<string, unknown>> = {
        state: {
          ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 8 * HOUR_MS + 30 * MINUTE_MS),
        },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(persisted),
      });
      const store = createA11yStore(adapter);
      expect(store.getState().updatedAt).toBe(isoAt(TEST_DAY_START + 8 * HOUR_MS + 30 * MINUTE_MS));
    });

    it('defaults updatedAt to null when persisted blob omits it (legacy storage)', () => {
      const persisted: StorageValue<AccessibilityPreferences> = {
        state: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(persisted),
      });
      const store = createA11yStore(adapter);
      expect(store.getState().updatedAt).toBeNull();
    });

    it('defaults updatedAt to null when persisted value is not a valid ISO string', () => {
      const persisted: StorageValue<Record<string, unknown>> = {
        state: {
          ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: 'not-a-date',
        },
        version: 0,
      };
      const adapter = createMemoryAdapter({
        [A11Y_STORAGE_KEY]: JSON.stringify(persisted),
      });
      const store = createA11yStore(adapter);
      expect(store.getState().updatedAt).toBeNull();
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
    expect(state.contrast).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast);
    expectExposes(state, 'update', 'reset');
  });

  it('persists updates to globalThis.window.localStorage by default', () => {
    useA11yStore.getState().update({ contrast: 'high' });
    const raw = globalThis.window.localStorage.getItem(A11Y_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as StorageValue<AccessibilityPreferences>;
    expect(parsed.state.contrast).toBe('high');
  });
});
