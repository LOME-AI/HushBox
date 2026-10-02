import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type * as React from 'react';
import type { useA11yStore as UseA11yStore } from '@hushbox/ui/accessibility/store';

const { envMock } = vi.hoisted(() => ({ envMock: { isE2E: false } }));

vi.mock('../lib/env.js', () => ({ env: envMock }));

vi.mock('@hushbox/ui/accessibility', () => ({
  A11yProvider: (): React.JSX.Element => <div data-testid="library-a11y-provider" />,
  REDUCED_MOTION_CLASS: 'reduced-motion',
}));

describe('A11yProvider island', () => {
  beforeEach(() => {
    envMock.isE2E = false;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // `vi.resetModules()` gives every test a fresh registry, so the store handle
  // must come from that registry — the one the island module will import.
  const freshA11yStore = async (): Promise<typeof UseA11yStore> => {
    const storeModule = await import('@hushbox/ui/accessibility/store');
    return storeModule.useA11yStore;
  };

  it('hands the store the host override at module evaluation, before any render', async () => {
    envMock.isE2E = true;
    const store = await freshA11yStore();
    expect(store.getState().forcedReducedMotion).toBe(false);

    await import('./a11y-provider.js');

    expect(store.getState().forcedReducedMotion).toBe(true);
  });

  it('leaves the override unset on every non-E2E build', async () => {
    const store = await freshA11yStore();

    await import('./a11y-provider.js');

    expect(store.getState().forcedReducedMotion).toBe(false);
  });

  it("renders the library's accessibility provider", async () => {
    const { A11yProvider } = await import('./a11y-provider.js');

    render(<A11yProvider />);

    expect(screen.getByTestId('library-a11y-provider')).toBeInTheDocument();
  });
});
