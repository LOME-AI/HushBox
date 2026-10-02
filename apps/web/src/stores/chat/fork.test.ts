import { describe, it, expect, beforeEach } from 'vitest';
import { useForkStore } from './fork.js';

describe('useForkStore', () => {
  beforeEach(() => {
    useForkStore.setState({ activeForkId: null });
  });

  it('starts with no active fork', () => {
    const state = useForkStore.getState();
    expect(state.activeForkId).toBeNull();
  });

  it('sets active fork', () => {
    useForkStore.getState().setActiveFork('fork-1');

    const state = useForkStore.getState();
    expect(state.activeForkId).toBe('fork-1');
  });

  it('clears active fork with null', () => {
    useForkStore.getState().setActiveFork('fork-1');
    useForkStore.getState().setActiveFork(null);

    const state = useForkStore.getState();
    expect(state.activeForkId).toBeNull();
  });

  it('replaces active fork', () => {
    useForkStore.getState().setActiveFork('fork-1');
    useForkStore.getState().setActiveFork('fork-2');

    const state = useForkStore.getState();
    expect(state.activeForkId).toBe('fork-2');
  });
});
