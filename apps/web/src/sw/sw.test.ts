import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const alphabetical = (values: readonly string[]): string[] =>
  [...values].toSorted((a, b) => a.localeCompare(b));

describe('service worker entry', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** The two globals the push-only surface is recognised by, which jsdom lacks. */
  function stubWorkerScope(): void {
    vi.stubGlobal('clients', { matchAll: vi.fn(), openWindow: vi.fn(), claim: vi.fn() });
    vi.stubGlobal('registration', {
      showNotification: vi.fn(),
      pushManager: { subscribe: vi.fn() },
    });
  }

  it('refuses a global that carries none of the push-only worker surface', async () => {
    vi.spyOn(globalThis, 'addEventListener').mockImplementation(() => {});

    await expect(import('./sw.js')).rejects.toThrow(/service worker scope/);
  });

  it('registers the worker lifecycle and push listeners against the worker global on load', async () => {
    const addEventListener = vi.spyOn(globalThis, 'addEventListener').mockImplementation(() => {});
    stubWorkerScope();

    await import('./sw.js');

    const registered = addEventListener.mock.calls.map((call) => call[0]);
    expect(alphabetical(registered)).toEqual([
      'activate',
      'notificationclick',
      'push',
      'pushsubscriptionchange',
    ]);
    expect(registered).not.toContain('fetch');
  });
});
