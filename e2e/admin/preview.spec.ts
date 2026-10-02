import { adminPreviewPath, MARKETING_BASE_URL, ROUTES } from '@hushbox/shared';

import { expectConsoleErrors } from '../fixtures.js';
import { test as base, expect } from './fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { startAdminDevServer } from './helpers/dev-server.js';
import { openMarketingPreview } from './helpers/preview.js';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/**
 * The admin shell's robots meta. The shell is the document the development
 * server used to answer the framed path with, so this marker is what tells the
 * two documents apart from the shell's side; the copy's canonical link,
 * derived below, tells them apart from the copy's side.
 */
const ADMIN_SHELL_MARKER = 'noindex, nofollow';

/**
 * The framed copy runs the marketing site's announcement banner
 * (`apps/marketing/src/components/AnnouncementBanner.astro`), whose script
 * fetches the API cross-origin — and the admin origin keeps `connect-src 'self'`
 * on the framed block, because `scripts/generate-headers.ts` relaxes framing
 * there and nothing else. The browser refusing that connection is the policy
 * working: a page this origin serves has no business reaching the API. The
 * banner catches the rejection and still sets its settled marker, so the page
 * these tests read is whole.
 *
 * Two patterns because the engine reports the policy decision and the Fetch
 * API's failure on separate lines. Each is pinned to the banner endpoint AND to
 * the connection refusal, so a refusal naming another URL, a violation of
 * another directive, and a non-CSP failure of this same fetch all still fail
 * the test.
 */
const BANNER_CONNECT_REFUSED: RegExp[] = [
  /^Connecting to 'https?:\/\/[^'\s]+\/announcements\/banner' violates the following Content Security Policy directive: "connect-src 'self'"\./,
  /^Fetch API cannot load https?:\/\/\S+\/announcements\/banner\. Refused to connect because it violates the document's Content Security Policy\.$/,
];

const test = base.extend<{ adminDevServerUrl: string }>({
  /**
   * A development server of the admin package's own, so this file drives it
   * beside the `vite preview` server the rest of the file drives rather than
   * replacing it. The preview server is the reference the development server
   * is being matched to, so a check that stopped driving it could not see the
   * two drift apart.
   */
  // eslint-disable-next-line no-empty-pattern -- the empty pattern is the only shape a dependency-free fixture can take
  adminDevServerUrl: async ({}, use) => {
    const server = await startAdminDevServer();
    try {
      await use(server.url);
    } finally {
      await server.stop();
    }
  },
});

/**
 * The marketing copy the admin origin serves for the click overlay to frame.
 * The copy has to be in the origin's assets, and the origin's headers have to
 * let a page on this origin frame it. Both are build-time wiring, which is why
 * they are checked against the served origin rather than against the files
 * that produce it.
 */
test.describe('The framed marketing preview', SPEC_MATRIX, () => {
  test('serves a copied marketing page from the admin origin', async ({ adminPage }) => {
    expectConsoleErrors(adminPage, BANNER_CONNECT_REFUSED);
    await openMarketingPreview(adminPage, ROUTES.MARKETING);
    // The copy's own canonical link, which the admin shell has no counterpart
    // for: a landmark role would not tell the two documents apart, so an
    // assertion on one passes against whichever document the origin served.
    // Read through the DOM because a `link` in the head carries no role and no
    // text, so no semantic locator reaches it.
    const canonical = await adminPage.evaluate(
      () => document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
    );
    expect(canonical).toBe(`${MARKETING_BASE_URL}${adminPreviewPath(ROUTES.MARKETING)}`);
  });

  test('lets a page on the admin origin frame it', async ({ adminPage }) => {
    expectConsoleErrors(adminPage, BANNER_CONNECT_REFUSED);
    await openMarketingPreview(adminPage, ROUTES.MARKETING);
    const framed = adminPage.url();
    await adminPage.goto('/');
    const loaded = await adminPage.evaluate(
      (source) =>
        new Promise<boolean>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = source;
          frame.addEventListener('load', () => {
            resolve(frame.contentDocument !== null);
          });
          document.body.append(frame);
        }),
      framed
    );
    expect(loaded).toBe(true);
  });

  test('serves that same copied page from the development server', async ({
    request,
    adminDevServerUrl,
  }) => {
    const shellResponse = await request.get(`${adminDevServerUrl}/`);
    const framedResponse = await request.get(
      `${adminDevServerUrl}${adminPreviewPath(ROUTES.MARKETING)}`
    );
    const shell = await shellResponse.text();
    const framed = await framedResponse.text();

    // The marker only separates the two documents while the shell carries it,
    // so the shell is read first: without this, a marker that had moved would
    // leave the next assertion passing against either document.
    expect(shell).toContain(ADMIN_SHELL_MARKER);
    expect(framed).not.toContain(ADMIN_SHELL_MARKER);
    expect(framed).toContain(
      `<link rel="canonical" href="${MARKETING_BASE_URL}${adminPreviewPath(ROUTES.MARKETING)}">`
    );
  });
});
