import { describe, it, expect, beforeEach } from 'vitest';
import { useTouchOverrideStore } from './touch-override';

describe('useTouchOverrideStore', () => {
  beforeEach(() => {
    useTouchOverrideStore.setState({ override: null });
  });

  it('starts with null override', () => {
    expect(useTouchOverrideStore.getState().override).toBe(null);
  });

  it('toggle sets override to true from null', () => {
    useTouchOverrideStore.getState().toggle();
    expect(useTouchOverrideStore.getState().override).toBe(true);
  });

  it('toggle sets override back to null from true', () => {
    useTouchOverrideStore.setState({ override: true });
    useTouchOverrideStore.getState().toggle();
    expect(useTouchOverrideStore.getState().override).toBe(null);
  });

  it('toggle cycles correctly: null → true → null', () => {
    expect(useTouchOverrideStore.getState().override).toBe(null);

    useTouchOverrideStore.getState().toggle();
    expect(useTouchOverrideStore.getState().override).toBe(true);

    useTouchOverrideStore.getState().toggle();
    expect(useTouchOverrideStore.getState().override).toBe(null);
  });
});
