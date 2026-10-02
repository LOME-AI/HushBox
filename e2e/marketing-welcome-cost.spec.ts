import { TEST_SIGNALS } from '@hushbox/shared';
import { expectApiErrors, expectConsoleErrors, test, type Request } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import { requireEnv } from './helpers/env.js';
import { expect } from './helpers/expect.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

// Both islands of the cost section, the figures and the provider strip.
const ISLANDS = 2;

const API_URL = requireEnv('VITE_API_URL');

// A cookie the browser holds for the API host, so a catalog read sent with
// credentials would carry it and the no-cookie assertion has something to catch.
const PLANTED_COOKIE = 'welcome-cost-probe';

function isCatalogRead(request: Request): boolean {
  return new URL(request.url()).pathname.endsWith('/models');
}

/**
 * The welcome page's cost section reads the model catalog in the visitor's
 * browser, not at build time: the built page carries no HushBox figure, and
 * the figures, the model count and the providers arrive from one public
 * `GET /models` that carries no cookie, no query and no custom header.
 */
test.describe('Welcome cost section', SPEC_MATRIX, () => {
  test('prices HushBox from one uncredentialed catalog read', async ({
    unauthenticatedPage: page,
  }) => {
    await page
      .context()
      .addCookies([{ name: PLANTED_COOKIE, value: '1', url: API_URL, sameSite: 'Lax' }]);
    const catalogReads: Request[] = [];
    page.on('request', (request) => {
      if (isCatalogRead(request)) catalogReads.push(request);
    });

    await page.goto('/welcome');

    const ready = page.locator(`[${TEST_SIGNALS.costReady}]`);
    await expect(ready).toHaveCount(ISLANDS);
    await expect(page.getByText(/^\$\d+\.\d{2}\/mo · ALL \d+\+ models$/)).toBeVisible();
    await expect(page.getByText(/^\d+ models available$/)).toBeVisible();

    expect(catalogReads).toHaveLength(1);
    const [read] = catalogReads;
    if (read === undefined) throw new Error('no catalog read observed');
    expect(read.method()).toBe('GET');
    expect(new URL(read.url()).search).toBe('');
    const planted = await page.context().cookies(API_URL);
    expect(planted.map((cookie) => cookie.name)).toContain(PLANTED_COOKIE);
    const headers = await read.allHeaders();
    expect(headers).not.toHaveProperty('cookie');
    expect(Object.keys(headers).filter((name) => name.startsWith('x-'))).toEqual([]);
  });

  // The real catalog cannot be made to fail on demand, so the failure is fabricated here.
  test('says pricing is unavailable when the catalog read fails', async ({
    unauthenticatedPage: page,
  }) => {
    expectApiErrors(page, [/503 GET \S*\/models$/m]);
    expectConsoleErrors(page, [
      (error) => error.url.endsWith('/models') && error.text.includes('status of 503'),
    ]);
    await page.route(
      (url) => url.pathname.endsWith('/models'),
      (route) => route.fulfill({ status: 503, body: '' })
    );

    await page.goto('/welcome');

    const settled = page.locator(`[${TEST_SIGNALS.costSettled}="true"]`);
    await expect(settled).toHaveCount(ISLANDS);
    await expect(page.locator(`[${TEST_SIGNALS.costReady}]`)).toHaveCount(0);
    await expect(page.getByText('Live pricing is unavailable right now.')).toBeVisible();
    await expect(page.getByText('The model list is unavailable right now.')).toBeVisible();
  });
});
