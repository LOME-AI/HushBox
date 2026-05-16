import { test, expect } from './fixtures.js';
import {
  accessibilityPreferencesSchema,
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
} from '@hushbox/shared';

const STORAGE_KEY = 'hushbox.a11y.v1';
const PREFS_URL_FRAGMENT = '/api/user-preferences/accessibility';

/**
 * Authenticated DB persistence for accessibility preferences (the LWW sync
 * wired up by `useAccessibilitySync` on the `_app` layout).
 *
 * The shared `expectAllTogglesPersisted` helper in `accessibility-app.spec.ts`
 * covers the localStorage round-trip; these tests cover the second leg — that
 * server state is the durable source when localStorage is gone, and that a
 * second authenticated browser sees the same settings.
 */

test.describe('Authenticated DB sync for accessibility preferences', () => {
  test.beforeEach(async ({ authenticatedRequest }) => {
    // Server-side reset: PUT defaults with a fresh timestamp so prior runs
    // don't bleed in via LWW. The route's `lte` predicate accepts this if
    // it's at least as new as whatever's there.
    const response = await authenticatedRequest.put(PREFS_URL_FRAGMENT, {
      data: {
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: new Date().toISOString(),
      },
    });
    expect(response.ok()).toBe(true);
  });

  test('a toggle PUTs the new state and the server accepts it', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => {
      globalThis.localStorage.removeItem(key);
    }, STORAGE_KEY);
    await page.goto('/accessibility', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Quick starts', level: 2 })).toBeVisible();

    const putPromise = page.waitForRequest(
      (req) => req.url().includes(PREFS_URL_FRAGMENT) && req.method() === 'PUT',
      { timeout: 15_000 }
    );
    await page.getByRole('button', { name: /^Contrast: / }).click();

    const putRequest = await putPromise;
    const body = JSON.parse(putRequest.postData() ?? '{}') as {
      preferences: Record<string, unknown>;
      updatedAt: string;
    };
    expect(body.preferences['contrast']).toBe('increased');
    expect(() => accessibilityPreferencesSchema.parse(body.preferences)).not.toThrow();
    expect(Number.isFinite(new Date(body.updatedAt).getTime())).toBe(true);

    const response = await putRequest.response();
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    const respBody = (await response!.json()) as { accepted: boolean };
    expect(respBody.accepted).toBe(true);
  });

  test('cleared localStorage rehydrates from the server on reload', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    const page = authenticatedPage;

    await authenticatedRequest.put(PREFS_URL_FRAGMENT, {
      data: {
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
        updatedAt: new Date().toISOString(),
      },
    });

    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => {
      globalThis.localStorage.removeItem(key);
    }, STORAGE_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect
      .poll(() => page.evaluate(() => document.documentElement.className), { timeout: 10_000 })
      .toContain('a11y-contrast-high');
  });

  test('a second authenticated context sees changes made in the first', async ({
    authenticatedPage,
    createPage,
  }) => {
    const contextA = authenticatedPage;
    await contextA.goto('/chat', { waitUntil: 'domcontentloaded' });
    await contextA.evaluate((key) => {
      globalThis.localStorage.removeItem(key);
    }, STORAGE_KEY);
    await contextA.goto('/accessibility', { waitUntil: 'domcontentloaded' });
    await expect(contextA.getByRole('heading', { name: 'Quick starts', level: 2 })).toBeVisible();

    const putPromise = contextA.waitForRequest(
      (req) => req.url().includes(PREFS_URL_FRAGMENT) && req.method() === 'PUT',
      { timeout: 15_000 }
    );
    await contextA.getByRole('button', { name: /^Contrast: / }).click();
    await putPromise;

    const contextB = await createPage('e2e/.auth/test-alice.json');
    await contextB.evaluate((key) => {
      try {
        globalThis.localStorage.removeItem(key);
      } catch {
        // localStorage may not exist on about:blank — ignore.
      }
    }, STORAGE_KEY);
    await contextB.goto('/chat', { waitUntil: 'domcontentloaded' });

    await expect
      .poll(() => contextB.evaluate(() => document.documentElement.className), { timeout: 10_000 })
      .toContain('a11y-contrast-increased');
  });
});
