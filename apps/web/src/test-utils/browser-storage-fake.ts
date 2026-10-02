import { vi } from 'vitest';

/** Steers a storage area into the failure modes a real browser can present. */
export interface StorageFakeControls {
  /** While true, every read throws — the shape of a browser with Web Storage disabled. */
  failRead: boolean;
}

/**
 * Real in-memory Web Storage. `test.setup.ts` installs a `localStorage` whose
 * `getItem` always returns null, so any test exercising a module that reads back
 * what it wrote needs this instead.
 */
export function createInMemoryStorage(controls?: StorageFakeControls): Storage {
  const steering = controls ?? { failRead: false };
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => {
      if (steering.failRead) throw new Error('storage read refused');
      return store[key] ?? null;
    },
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      Reflect.deleteProperty(store, key);
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

/** Steers the fake store into the failure and timing modes the real one can present. */
export interface IndexedDbFakeControls {
  /** While true, every `open()` reports an error instead of resolving. */
  failOpen: boolean;
  /** While true, a delete request parks until `releaseDelete()` runs it. */
  holdDelete: boolean;
  releaseDelete: () => void;
}

interface FakeRequest {
  onsuccess: (() => void) | null;
  addEventListener: (type: string, callback: () => void) => void;
  result: unknown;
  error: Error | null;
}

/** The listener slots `device-key-store` never subscribes to on a settled request. */
const ignoreListener = (): undefined => undefined;

/** A request that resolves on the next microtask with whatever `getResult` returns. */
function makeRequest(getResult: () => unknown): FakeRequest {
  const request: FakeRequest = {
    onsuccess: null,
    addEventListener: ignoreListener,
    result: undefined,
    error: null,
  };
  queueMicrotask(() => {
    request.result = getResult();
    request.onsuccess?.();
  });
  return request;
}

/**
 * Minimal in-memory IndexedDB matching the surface `device-key-store` uses.
 * Records are held by reference so a stored `CryptoKey` survives unchanged —
 * a structured clone would not preserve a non-extractable key handle.
 */
export function installFakeIndexedDB(): {
  data: Map<unknown, unknown>;
  controls: IndexedDbFakeControls;
} {
  const data = new Map<unknown, unknown>();
  const heldDeletes: (() => void)[] = [];
  const controls: IndexedDbFakeControls = {
    failOpen: false,
    holdDelete: false,
    releaseDelete: () => {
      for (const complete of heldDeletes.splice(0)) complete();
    },
  };
  const store = {
    put: (value: unknown, key: unknown) =>
      makeRequest(() => {
        data.set(key, value);
      }),
    get: (key: unknown) => makeRequest(() => data.get(key)),
    delete: (key: unknown) => {
      const request: FakeRequest = {
        onsuccess: null,
        addEventListener: ignoreListener,
        result: undefined,
        error: null,
      };
      const complete = (): void => {
        data.delete(key);
        request.onsuccess?.();
      };
      if (controls.holdDelete) heldDeletes.push(complete);
      else queueMicrotask(complete);
      return request;
    },
  };
  const db = {
    transaction: () => ({ objectStore: () => store }),
    createObjectStore: () => store,
    close: ignoreListener,
  };
  const fakeIndexedDB = {
    open: () => {
      const listeners: { error?: () => void } = {};
      const request: {
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        addEventListener: (type: string, callback: () => void) => void;
        result: unknown;
        error: Error | null;
      } = {
        onupgradeneeded: null,
        onsuccess: null,
        addEventListener: (type, callback) => {
          if (type === 'error') listeners.error = callback;
        },
        result: db,
        error: null,
      };
      queueMicrotask(() => {
        if (controls.failOpen) {
          request.error = new Error('fake idb open failure');
          listeners.error?.();
          return;
        }
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  vi.stubGlobal('indexedDB', fakeIndexedDB);
  return { data, controls };
}
