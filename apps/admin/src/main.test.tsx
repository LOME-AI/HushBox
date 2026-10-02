import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { useA11yStore as UseA11yStore } from '@hushbox/ui/accessibility/store';

const { renderMock, createRootMock, envMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  createRootMock: vi.fn(),
  envMock: { isE2E: false },
}));

vi.mock('./router', () => ({ router: {} }));
vi.mock('react-dom/client', () => ({ createRoot: createRootMock }));
vi.mock('./lib/env', () => ({ env: envMock }));

describe('main entry', () => {
  beforeEach(() => {
    renderMock.mockClear();
    createRootMock.mockReset();
    createRootMock.mockImplementation(() => ({ render: renderMock }));
    envMock.isE2E = false;
    vi.resetModules();
  });

  // `vi.resetModules()` gives every test a fresh module registry, so the store
  // handle must come from that registry — the one `./main.js` will import.
  const freshA11yStore = async (): Promise<typeof UseA11yStore> => {
    const storeModule = await import('@hushbox/ui/accessibility/store');
    return storeModule.useA11yStore;
  };

  afterEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
  });

  it('mounts the router into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main.js');
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when #root is missing', async () => {
    document.body.innerHTML = '';
    await expect(import('./main.js')).rejects.toThrow('Root element not found');
  });

  it('forces reduced motion in the a11y store when env.isE2E is true', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    envMock.isE2E = true;
    const store = await freshA11yStore();
    await import('./main.js');
    expect(store.getState().forcedReducedMotion).toBe(true);
  });

  it('leaves reduced motion unforced when env.isE2E is false', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const store = await freshA11yStore();
    await import('./main.js');
    expect(store.getState().forcedReducedMotion).toBe(false);
  });

  // The ordering proof: whatever React is handed cannot render — let alone paint —
  // before `createRoot` is called, so a flag already set at that instant is set
  // before first paint.
  it('has forced reduced motion already applied by the time the root is created', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    envMock.isE2E = true;
    const store = await freshA11yStore();
    let forcedAtRootCreation: boolean | null = null;
    createRootMock.mockImplementation(() => {
      forcedAtRootCreation = store.getState().forcedReducedMotion;
      return { render: renderMock };
    });

    await import('./main.js');

    expect(forcedAtRootCreation).toBe(true);
  });
});
