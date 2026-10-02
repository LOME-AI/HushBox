import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import type { useA11yStore as UseA11yStore } from '@hushbox/ui/accessibility/store';

// The E2E DOM flag is driven purely by `env.isE2E` (env-mode detection), never
// by the raw VITE_E2E var. A hoisted, mutable mock lets each test flip the mode
// (and the demo-path gate) before the entry module's top-level side effect runs.
const { envMock, isDemoPathMock, mountDemoMock, renderMock, createRootMock, prewarmMock } =
  vi.hoisted(() => ({
    envMock: { isE2E: false },
    isDemoPathMock: vi.fn((_path: string) => false),
    mountDemoMock: vi.fn(),
    renderMock: vi.fn(),
    createRootMock: vi.fn(() => ({ render: renderMock })),
    prewarmMock: vi.fn(),
  }));

vi.mock('./lib/platform/env', () => ({ env: envMock }));
vi.mock('./router', () => ({ router: {} }));
vi.mock('react-dom/client', () => ({ createRoot: createRootMock }));
vi.mock('./lib/platform/is-demo-path', () => ({ isDemoPath: isDemoPathMock }));
vi.mock('./demo/bootstrap', () => ({ mountDemo: mountDemoMock }));
vi.mock('./lib/tts/prewarm-tts', () => ({ prewarmTtsIfEnabled: prewarmMock }));

describe('main entry', () => {
  beforeEach(() => {
    delete document.documentElement.dataset['e2e'];
    document.body.innerHTML = '<div id="root"></div>';
    envMock.isE2E = false;
    isDemoPathMock.mockReturnValue(false);
    mountDemoMock.mockClear();
    renderMock.mockClear();
    createRootMock.mockReset();
    createRootMock.mockImplementation(() => ({ render: renderMock }));
    mountDemoMock.mockImplementation(() => undefined);
    prewarmMock.mockClear();
    vi.resetModules();
  });

  // `vi.resetModules()` gives every test a fresh module registry, so the store
  // handle must come from that registry — the one `./main.js` will import.
  const freshA11yStore = async (): Promise<typeof UseA11yStore> => {
    const storeModule = await import('@hushbox/ui/accessibility/store');
    return storeModule.useA11yStore;
  };

  afterEach(() => {
    delete document.documentElement.dataset['e2e'];
    vi.resetModules();
  });

  it('sets data-e2e on <html> when env.isE2E is true', async () => {
    envMock.isE2E = true;
    await import('./main.js');
    // main.tsx sets the flag via `dataset.e2e = ''` — an empty-string value.
    expect(document.documentElement.dataset['e2e']).toBe('');
  });

  it('does not set data-e2e on <html> when env.isE2E is false', async () => {
    envMock.isE2E = false;
    await import('./main.js');
    expect(document.documentElement.dataset['e2e']).toBeUndefined();
  });

  it('forces reduced motion in the a11y store when env.isE2E is true', async () => {
    envMock.isE2E = true;
    const store = await freshA11yStore();
    await import('./main.js');
    expect(store.getState().forcedReducedMotion).toBe(true);
  });

  it('leaves reduced motion unforced when env.isE2E is false', async () => {
    envMock.isE2E = false;
    const store = await freshA11yStore();
    await import('./main.js');
    expect(store.getState().forcedReducedMotion).toBe(false);
  });

  // The ordering proof: whatever React is handed cannot render — let alone paint —
  // before `createRoot` is called, so a flag already set at that instant is set
  // before first paint.
  it('has forced reduced motion already applied by the time the root is created', async () => {
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

  it('has forced reduced motion already applied by the time the demo bundle mounts', async () => {
    envMock.isE2E = true;
    isDemoPathMock.mockReturnValue(true);
    const store = await freshA11yStore();
    let forcedAtDemoMount: boolean | null = null;
    mountDemoMock.mockImplementation(() => {
      forcedAtDemoMount = store.getState().forcedReducedMotion;
    });

    await import('./main.js');

    expect(forcedAtDemoMount).toBe(true);
  });

  it('throws when the #root element is missing', async () => {
    document.body.innerHTML = '';
    await expect(import('./main.js')).rejects.toThrow('Root element not found');
  });

  it('mounts the real app (createRoot + prewarm) on a normal path', async () => {
    await import('./main.js');
    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(prewarmMock).toHaveBeenCalledTimes(1);
    expect(mountDemoMock).not.toHaveBeenCalled();
  });

  it('boots the demo bundle on a demo path instead of the real app', async () => {
    isDemoPathMock.mockReturnValue(true);
    await import('./main.js');
    expect(mountDemoMock).toHaveBeenCalledTimes(1);
    expect(createRootMock).not.toHaveBeenCalled();
    expect(prewarmMock).not.toHaveBeenCalled();
  });

  it('listens for failed chunk loads from app start', async () => {
    const addListenerSpy = vi.spyOn(globalThis, 'addEventListener');
    onTestFinished(() => {
      addListenerSpy.mockRestore();
    });

    await import('./main.js');

    expect(addListenerSpy).toHaveBeenCalledWith('vite:preloadError', expect.any(Function));
  });
});
