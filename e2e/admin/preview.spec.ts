import {
  ADMIN_PREVIEW_PREFIX,
  adminPreviewPath,
  MARKETING_BASE_URL,
  ROUTES,
} from '@hushbox/shared';

import { expectConsoleErrors } from '../fixtures.js';
import { test as base, expect } from './fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { startAdminDevServer } from './helpers/dev-server.js';
import { openMarketingPreview } from './helpers/preview.js';
import type { ConsoleErrorMatcher } from '../fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/**
 * The admin shell's robots meta. The shell is the document the development
 * server used to answer the framed path with, so this marker is what tells the
 * two documents apart from the shell's side; the copy's canonical link,
 * derived below, tells them apart from the copy's side.
 */
const ADMIN_SHELL_MARKER = 'noindex, nofollow';

/**
 * The engine's refusal to run a script on a copied page.
 *
 * The admin origin serves every copied page a CSP `sandbox` without
 * `allow-scripts`, so the page runs none of its scripts whether it is loaded
 * top-level or framed, and the engine logs one error per script it refuses.
 * That refusal is the policy working. Admitted only from a copied page's own
 * URL, so a script refused anywhere else on the admin origin still fails the
 * test.
 */
const SCRIPT_REFUSED_TEXT =
  /^Blocked script execution in '[^']+' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;

const copiedPageScriptRefused: ConsoleErrorMatcher = (error) =>
  SCRIPT_REFUSED_TEXT.test(error.text) &&
  URL.canParse(error.url) &&
  new URL(error.url).pathname.startsWith(`/${ADMIN_PREVIEW_PREFIX}/`);

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
    expectConsoleErrors(adminPage, [copiedPageScriptRefused]);
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
    expectConsoleErrors(adminPage, [copiedPageScriptRefused]);
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
