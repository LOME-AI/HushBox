import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

type ClientModule = typeof import('@/lib/api-client');
type ProviderModule = typeof import('./query-provider.js');

/**
 * Both modules come from one registry generation per test: the provider
 * branches on `instanceof`, and its access-denied state is module-level, so a
 * stale copy of either would break identity or leak a denial between tests.
 */
async function importModules(): Promise<{ client: ClientModule; provider: ProviderModule }> {
  const client = await import('@/lib/api-client');
  const provider = await import('./query-provider.js');
  return { client, provider };
}

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
});

describe('QueryProvider', () => {
  it('renders its children', async () => {
    const { provider } = await importModules();
    render(
      <provider.QueryProvider>
        <div>child content</div>
      </provider.QueryProvider>
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('never refetches on window focus (ops tool, not a live feed)', async () => {
    const { provider } = await importModules();
    expect(provider.queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });

  it('installs the retry policy as the query default', async () => {
    const { provider } = await importModules();
    expect(provider.queryClient.getDefaultOptions().queries?.retry).toBe(
      provider.retryUnlessClientError
    );
  });
});

describe('retryUnlessClientError', () => {
  it('never retries a definitive 4xx ApiError', async () => {
    const { client, provider } = await importModules();
    expect(provider.retryUnlessClientError(0, new client.ApiError('NOT_FOUND', 404))).toBe(false);
    expect(provider.retryUnlessClientError(0, new client.ApiError('VALIDATION', 400))).toBe(false);
    expect(provider.retryUnlessClientError(0, new client.ApiError('RATE_LIMITED', 429))).toBe(
      false
    );
  });

  it('retries a 5xx ApiError up to three times', async () => {
    const { client, provider } = await importModules();
    expect(provider.retryUnlessClientError(0, new client.ApiError('INTERNAL', 500))).toBe(true);
    expect(provider.retryUnlessClientError(2, new client.ApiError('INTERNAL', 503))).toBe(true);
    expect(provider.retryUnlessClientError(3, new client.ApiError('INTERNAL', 500))).toBe(false);
  });

  it('retries a transport failure up to three times', async () => {
    const { provider } = await importModules();
    expect(provider.retryUnlessClientError(0, new TypeError('fetch failed'))).toBe(true);
    expect(provider.retryUnlessClientError(3, new TypeError('fetch failed'))).toBe(false);
  });

  it('never retries an Access expiry (the login page is not a transient failure)', async () => {
    const { client, provider } = await importModules();
    expect(provider.retryUnlessClientError(0, new client.AccessExpiredError())).toBe(false);
  });

  it('never retries a permanent refusal (the identical request is refused identically)', async () => {
    const { client, provider } = await importModules();
    expect(provider.retryUnlessClientError(0, new client.AdminNotAuthorizedError())).toBe(false);
  });
});

describe('Access-expiry re-auth', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    reloadSpy = vi.fn();
    originalLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { reload: reloadSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.useRealTimers();
  });

  it('reloadForReauth navigates so Access re-runs its challenge', async () => {
    const { provider } = await importModules();
    provider.reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of expiries into a single reload', async () => {
    const { provider } = await importModules();
    provider.reloadForReauth();
    provider.reloadForReauth();
    provider.reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reload again inside the loop-guard window after a prior reload', async () => {
    const { provider } = await importModules();
    // A reload timestamp already present (as if written just before a reload)
    // must suppress a fresh reload — a challenge that did not clear the cookie
    // cannot spin into a loop.
    sessionStorage.setItem('hushbox.admin.reauthReloadAt', String(Date.now()));
    provider.reloadForReauth();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads again once the loop-guard window has elapsed', async () => {
    const { provider } = await importModules();
    vi.useFakeTimers();
    provider.reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11_000);
    provider.reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });

  it('stops reloading for good once the reload budget is spent', async () => {
    const { provider } = await importModules();
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      provider.reloadForReauth();
      vi.advanceTimersByTime(11_000);
    }
    expect(reloadSpy).toHaveBeenCalledTimes(3);
  });

  it('shows the terminal screen once the reload budget is spent', async () => {
    const { provider } = await importModules();
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      provider.reloadForReauth();
      vi.advanceTimersByTime(11_000);
    }
    vi.useRealTimers();
    render(
      <provider.QueryProvider>
        <div>child content</div>
      </provider.QueryProvider>
    );
    expect(screen.getByText('Not authorized')).toBeInTheDocument();
  });

  it('clears the spent budget on a successful response, so a later expiry still recovers', async () => {
    const { provider } = await importModules();
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      provider.reloadForReauth();
      vi.advanceTimersByTime(11_000);
    }
    expect(reloadSpy).toHaveBeenCalledTimes(3);
    provider.clearReauthReloads();
    provider.reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(4);
  });

  it('handleAccessError reloads on an AccessExpiredError', async () => {
    const { client, provider } = await importModules();
    provider.handleAccessError(new client.AccessExpiredError());
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('handleAccessError does not reload on a normal ApiError', async () => {
    const { client, provider } = await importModules();
    provider.handleAccessError(new client.ApiError('FORBIDDEN', 403));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('handleAccessError never reloads on a permanent refusal', async () => {
    const { client, provider } = await importModules();
    provider.handleAccessError(new client.AdminNotAuthorizedError());
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('wires the access-error handler into both the query and mutation caches', async () => {
    const { provider } = await importModules();
    expect(provider.queryClient.getQueryCache().config.onError).toBe(provider.handleAccessError);
    expect(provider.queryClient.getMutationCache().config.onError).toBe(provider.handleAccessError);
  });

  it('wires the budget reset into the query cache success path', async () => {
    const { provider } = await importModules();
    expect(provider.queryClient.getQueryCache().config.onSuccess).toBe(provider.clearReauthReloads);
  });
});

describe('the permanently-refused terminal state', () => {
  it('replaces the app with the not-authorized screen', async () => {
    const { client, provider } = await importModules();
    provider.handleAccessError(new client.AdminNotAuthorizedError());
    render(
      <provider.QueryProvider>
        <div>child content</div>
      </provider.QueryProvider>
    );
    expect(screen.getByText('Not authorized')).toBeInTheDocument();
    expect(screen.queryByText('child content')).not.toBeInTheDocument();
  });

  it('takes over an app that is already on screen when the refusal arrives', async () => {
    const { client, provider } = await importModules();
    render(
      <provider.QueryProvider>
        <div>child content</div>
      </provider.QueryProvider>
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
    act(() => {
      provider.handleAccessError(new client.AdminNotAuthorizedError());
    });
    expect(screen.getByText('Not authorized')).toBeInTheDocument();
    expect(screen.queryByText('child content')).not.toBeInTheDocument();
  });

  it('appears without the app having been reloaded even once', async () => {
    const reloadSpy = vi.fn();
    const originalLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { reload: reloadSpy },
    });
    try {
      const { client, provider } = await importModules();
      provider.handleAccessError(new client.AdminNotAuthorizedError());
      render(
        <provider.QueryProvider>
          <div>child content</div>
        </provider.QueryProvider>
      );
      expect(screen.getByText('Not authorized')).toBeInTheDocument();
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });

  it('names no cause, so the screen is not an identity oracle', async () => {
    const { client, provider } = await importModules();
    provider.handleAccessError(new client.AdminNotAuthorizedError());
    render(
      <provider.QueryProvider>
        <div>child content</div>
      </provider.QueryProvider>
    );
    const text = screen.getByRole('alert').textContent;
    for (const cause of ['allowlist', 'expired', 'email', 'signature', 'claim', 'assertion']) {
      expect(text.toLowerCase()).not.toContain(cause);
    }
  });
});
