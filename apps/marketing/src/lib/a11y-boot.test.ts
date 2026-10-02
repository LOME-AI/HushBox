import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REDUCED_MOTION_CLASS } from '@hushbox/ui/accessibility';
import type { useA11yStore as UseA11yStore } from '@hushbox/ui/accessibility/store';

const { envMock } = vi.hoisted(() => ({ envMock: { isE2E: false } }));

vi.mock('./env.js', () => ({ env: envMock }));

describe('applyForcedReducedMotion', () => {
  beforeEach(() => {
    envMock.isE2E = false;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // `vi.resetModules()` gives every test a fresh module registry, so the store
  // handle must come from that registry — the one the boot module will import.
  const freshA11yStore = async (): Promise<typeof UseA11yStore> => {
    const storeModule = await import('@hushbox/ui/accessibility/store');
    return storeModule.useA11yStore;
  };

  it('forces reduced motion when the build is an E2E build', async () => {
    envMock.isE2E = true;
    const store = await freshA11yStore();
    const { applyForcedReducedMotion } = await import('./a11y-boot.js');

    applyForcedReducedMotion();

    expect(store.getState().forcedReducedMotion).toBe(true);
  });

  it('leaves reduced motion unforced on every other build', async () => {
    const store = await freshA11yStore();
    const { applyForcedReducedMotion } = await import('./a11y-boot.js');

    applyForcedReducedMotion();

    expect(store.getState().forcedReducedMotion).toBe(false);
  });
});

describe('forcedReducedMotionClass', () => {
  beforeEach(() => {
    envMock.isE2E = false;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('is the class the broadcaster toggles when the build is an E2E build', async () => {
    envMock.isE2E = true;

    const { forcedReducedMotionClass } = await import('./a11y-boot.js');

    expect(forcedReducedMotionClass).toBeDefined();
    expect(forcedReducedMotionClass).toBe(REDUCED_MOTION_CLASS);
  });

  it('is absent on every other build', async () => {
    const { forcedReducedMotionClass } = await import('./a11y-boot.js');

    expect(forcedReducedMotionClass).toBeUndefined();
  });
});
