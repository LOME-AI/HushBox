import { describe, it, expect, beforeEach } from 'vitest';
import { useAccessibilityPanelStore } from './accessibility-panel';

describe('useAccessibilityPanelStore', () => {
  beforeEach(() => {
    useAccessibilityPanelStore.setState({ open: false });
  });

  it('starts closed', () => {
    expect(useAccessibilityPanelStore.getState().open).toBe(false);
  });

  it('opens through setOpen', () => {
    useAccessibilityPanelStore.getState().setOpen(true);

    expect(useAccessibilityPanelStore.getState().open).toBe(true);
  });

  it('closes through setOpen', () => {
    useAccessibilityPanelStore.setState({ open: true });

    useAccessibilityPanelStore.getState().setOpen(false);

    expect(useAccessibilityPanelStore.getState().open).toBe(false);
  });
});
