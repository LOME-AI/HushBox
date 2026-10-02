import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from './network';

describe('useNetworkStore', () => {
  beforeEach(() => {
    useNetworkStore.setState({ isOffline: false });
  });

  it('starts with isOffline as false', () => {
    expect(useNetworkStore.getState().isOffline).toBe(false);
  });

  it('sets isOffline to true', () => {
    useNetworkStore.getState().setIsOffline(true);

    expect(useNetworkStore.getState().isOffline).toBe(true);
  });

  it('can be set back to false', () => {
    useNetworkStore.getState().setIsOffline(true);
    useNetworkStore.getState().setIsOffline(false);

    expect(useNetworkStore.getState().isOffline).toBe(false);
  });
});
