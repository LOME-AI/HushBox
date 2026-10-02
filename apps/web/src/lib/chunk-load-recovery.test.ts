import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { useAppVersionStore } from '@/stores/app-version';
import { installChunkLoadRecovery } from './chunk-load-recovery';
import type { MockInstance } from 'vitest';

// The tab's version is parsed once, when the API client module loads, so it is
// stubbed before any import runs. A version no deployment skips keeps the
// equal-version case about equality rather than about the skip set.
const { TAB_VERSION } = vi.hoisted(() => {
  const version = 'tab-build';
  vi.stubEnv('VITE_APP_VERSION', version);
  return { TAB_VERSION: version };
});

const NEWER_VERSION = 'newer-build';

function requestPath(input: Parameters<typeof fetch>[0]): string {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url).pathname;
}

describe('chunk-load recovery', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  /** The network answers `/updates/current` with `servedVersion`, and every other path with a 404. */
  function serve(servedVersion: string): void {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        requestPath(input) === '/updates/current'
          ? Response.json({ version: servedVersion }, { status: 200 })
          : Response.json({ code: 'NOT_FOUND' }, { status: 404 })
      )
    );
  }

  function failChunkLoad(): Event {
    const event = new Event('vite:preloadError', { cancelable: true });
    globalThis.dispatchEvent(event);
    return event;
  }

  /** Resolves once the lookup the event started has been answered and every continuation it queued has run. */
  async function lookupSettled(): Promise<void> {
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeAll(() => {
    installChunkLoadRecovery();
  });

  beforeEach(() => {
    useAppVersionStore.setState({ upgradeRequired: false, currentVersion: null, updateUrl: null });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('raises Update Required with the served version when a newer deployment is live', async () => {
    serve(NEWER_VERSION);

    failChunkLoad();

    await vi.waitFor(() => {
      expect(useAppVersionStore.getState()).toMatchObject({
        upgradeRequired: true,
        currentVersion: NEWER_VERSION,
      });
    });
  });

  it('leaves Update Required down when the tab runs the served version', async () => {
    serve(TAB_VERSION);

    failChunkLoad();
    await lookupSettled();

    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('leaves Update Required down when the version lookup cannot reach the server', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    failChunkLoad();
    await lookupSettled();

    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('leaves Update Required down when the version lookup answers an error', async () => {
    fetchSpy.mockResolvedValue(Response.json({ code: 'INTERNAL' }, { status: 500 }));

    failChunkLoad();
    await lookupSettled();

    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('lets no rejection escape when the version lookup fails', async () => {
    const escaped = vi.fn();
    process.on('unhandledRejection', escaped);
    try {
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

      failChunkLoad();
      await lookupSettled();

      expect(escaped).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', escaped);
    }
  });

  it('never prevents the event default, so the failed import still rejects', async () => {
    serve(NEWER_VERSION);

    const event = failChunkLoad();
    const preventedDuringDispatch = event.defaultPrevented;
    // The flag rising proves the listener ran during that dispatch.
    await vi.waitFor(() => {
      expect(useAppVersionStore.getState().upgradeRequired).toBe(true);
    });

    expect(preventedDuringDispatch).toBe(false);
  });
});
