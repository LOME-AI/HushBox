import { describe, it, expect } from 'vitest';
import { createCounterStore } from './create-counter-store.js';

const config = {
  count: 'pending',
  increment: 'start',
  decrement: 'finish',
} as const;

describe('createCounterStore', () => {
  it('starts the count at zero', () => {
    const useStore = createCounterStore(config);

    expect(useStore.getState().pending).toBe(0);
  });

  it('increments the count via the named increment action', () => {
    const useStore = createCounterStore(config);

    useStore.getState().start();

    expect(useStore.getState().pending).toBe(1);
  });

  it('decrements the count via the named decrement action', () => {
    const useStore = createCounterStore(config);
    useStore.getState().start();

    useStore.getState().finish();

    expect(useStore.getState().pending).toBe(0);
  });

  it('never decrements below zero', () => {
    const useStore = createCounterStore(config);

    useStore.getState().finish();

    expect(useStore.getState().pending).toBe(0);
  });

  it('creates independent store instances', () => {
    const useStoreA = createCounterStore(config);
    const useStoreB = createCounterStore(config);

    useStoreA.getState().start();

    expect(useStoreA.getState().pending).toBe(1);
    expect(useStoreB.getState().pending).toBe(0);
  });

  it('supports resetting the count via setState on the named field', () => {
    const useStore = createCounterStore(config);
    useStore.getState().start();

    useStore.setState({ pending: 0 });

    expect(useStore.getState().pending).toBe(0);
  });
});
