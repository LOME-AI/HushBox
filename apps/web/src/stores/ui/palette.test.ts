import { describe, it, expect, beforeEach } from 'vitest';
import { usePaletteStore } from './palette';

describe('usePaletteStore', () => {
  beforeEach(() => {
    usePaletteStore.setState({ open: false });
  });

  it('starts closed', () => {
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('opens through setOpen', () => {
    usePaletteStore.getState().setOpen(true);
    expect(usePaletteStore.getState().open).toBe(true);
  });

  it('closes through setOpen', () => {
    usePaletteStore.setState({ open: true });
    usePaletteStore.getState().setOpen(false);
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('opens a closed palette on toggle', () => {
    usePaletteStore.getState().toggle();
    expect(usePaletteStore.getState().open).toBe(true);
  });

  it('closes an open palette on toggle', () => {
    usePaletteStore.setState({ open: true });
    usePaletteStore.getState().toggle();
    expect(usePaletteStore.getState().open).toBe(false);
  });
});
