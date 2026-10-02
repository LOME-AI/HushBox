import { TEST_IDS } from '@hushbox/shared';
import { test as base, expect } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import { BANNER_LOCK_TEST_TIMEOUT_MS, withBannerLock } from './helpers/banner-lock.js';
import {
  bannerMessageLink,
  mintBannerAdminContext,
  setBanner,
  waitForBannerSettled,
} from './helpers/banner.js';
import type { BannerSetInput } from './helpers/banner.js';
import type { Locator, Page } from './fixtures.js';

/**
 * End-to-end coverage of the admin-controlled announcement banner on both
 * merged-preview surfaces: the React app (banner mounts app-wide in the root
 * route) and the compiled-Astro marketing site (no React island — the same
 * shared `createBanner` controller). Seeding is deterministic via the
 * registered `banner.set` admin op over HTTP.
 *
 * GLOBAL STATE: `banner_config` is one global row with no per-test isolation
 * seam, so this file (a) re-seeds immediately before every fresh load instead
 * of assuming carryover, (b) holds the banner lock, whose release restores the
 * disabled state even on failure so enabled windows stay short for the rest of
 * the matrix,
 * (c) runs its tests sequentially in one worker (`mode: 'default'`), and
 * (d) is gated to the chromium project — six projects concurrently mutating
 * one global row would clobber each other's seeded sets deterministically.
 * The admin-project banner spec mutates the same row from another worker
 * process, which no in-file mechanism can exclude: the two are serialized
 * against each other by the filesystem lock each seeding fixture holds.
 */

interface BannerOps {
  set: (input: BannerSetInput) => Promise<void>;
}

type AdminRequest = Parameters<typeof mintBannerAdminContext>[0];

/**
 * Admin-op seeding handle, held inside the banner lock, whose release restores
 * the disabled banner — in fixture teardown, never in the test body, so it runs
 * on failure too and other specs never inherit an enabled banner. The lock
 * spans the whole window in which this file can leave the row enabled — first
 * seed through the restore on release — so a failed or timed-out test frees
 * the row for the admin project rather than stranding it.
 */
async function holdBannerOps(
  request: AdminRequest,
  use: (ops: BannerOps) => Promise<void>
): Promise<void> {
  await withBannerLock(async () => {
    const api = await mintBannerAdminContext(request);
    try {
      await use({ set: (input) => setBanner(api, input) });
    } finally {
      await api.dispose();
    }
  });
}

/**
 * One handle per page fixture, each depending on the page fixture its test
 * uses, so Playwright tears the lock down before that page: teardown runs in
 * reverse setup order and skips whatever is left once one teardown spends the
 * test's budget, so a lock torn down after a hung page never restores. A
 * single handle depending on both would open the other test's page too, and
 * one depending on the built-in `page` would put the page fixture first.
 */
const test = base.extend<{ appBannerOps: BannerOps; marketingBannerOps: BannerOps }>({
  appBannerOps: async ({ playwright, authenticatedPage: _page }, use) => {
    await holdBannerOps(playwright.request, use);
  },
  marketingBannerOps: async ({ playwright, unauthenticatedPage: _page }, use) => {
    await holdBannerOps(playwright.request, use);
  },
});

function banner(page: Page): Locator {
  return page.getByTestId(TEST_IDS.announcementBanner);
}

/** `.first()`: in scroll/marquee mode the track is cloned, so per-message
 * test-ids appear twice per message. */
function messageByText(page: Page, text: string): Locator {
  return page.getByTestId(TEST_IDS.announcementBannerMessage).filter({ hasText: text }).first();
}

async function dismissBanner(page: Page): Promise<void> {
  // Keyboard activation, not click: dev/E2E builds mount the CrawlerEye badge
  // (fixed top-right, z-toast) directly over the banner's dismiss button, so a
  // pointer click is intercepted. Production builds drop the badge; the
  // keyboard path is the same handler.
  await banner(page).getByRole('button', { name: 'Dismiss announcement' }).press('Enter');
}

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'desktop',
  reason:
    'Both tests mutate the single global banner_config row, so the suite must hold exactly one project at a time; the banner itself renders no engine-specific behaviour.',
});

test.describe('Announcement banner', SPEC_MATRIX, () => {
  // Both tests mutate the single global banner_config row; file-level grouping
  // (not serial — tests stay order-independent) keeps them out of concurrent
  // workers so their seeds cannot clobber each other under fullyParallel. The
  // lock module owns the budget: it covers the seeding fixture waiting out the
  // admin project's hold on the same row and then holding it for a test of its
  // own. Configured on the describe, not in a body, because fixture setup — the
  // wait — spends most of it.
  test.describe.configure({ mode: 'default', timeout: BANNER_LOCK_TEST_TIMEOUT_MS });

  test('web app: renders seeded messages, dismisses by message-set hash, re-shows on change, and disables', async ({
    appBannerOps: bannerOps,
    authenticatedPage: page,
  }) => {
    // Short tag: long texts push the banner into scroll/marquee mode; the
    // static layout is the deterministic surface these assertions target.
    const runTag = crypto.randomUUID().slice(0, 8);
    const infoText = `E2E info ${runTag}`;
    const warningText = `E2E warning ${runTag}`;
    const linkText = 'Status page';
    const href = 'https://status.hushbox.ai/e2e';
    const initialSet: BannerSetInput = {
      enabled: true,
      messages: [
        { variant: 'info', text: infoText, href, linkText },
        { variant: 'warning', text: warningText },
      ],
    };

    // Seed an enabled two-variant set, then fresh-load an app page (the banner
    // payload is cached for the page's lifetime, so every step asserts after a
    // fresh load, never against a live update).
    await bannerOps.set(initialSet);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForBannerSettled(page);
    await expect(banner(page)).toBeVisible();

    // Layout regression net: with the banner occupying height above the app
    // shell, the desktop sidebar must inherit the remaining height (h-full
    // under the root h-dvh authority), not re-declare the viewport — a
    // viewport-height sidebar pushes its bottom controls off-screen.
    const sidebarFooter = page.getByTestId(TEST_IDS.sidebarFooter);
    await expect(sidebarFooter).toBeVisible();
    const viewport = page.viewportSize();
    expect(viewport, 'viewport size is required').not.toBeNull();
    const footerBox = await sidebarFooter.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport!.height);

    // Both messages render with their own variant hook.
    const infoMessage = messageByText(page, infoText);
    const warningMessage = messageByText(page, warningText);
    await expect(infoMessage).toBeVisible();
    await expect(infoMessage).toHaveAttribute('data-variant', 'info');
    await expect(warningMessage).toBeVisible();
    await expect(warningMessage).toHaveAttribute('data-variant', 'warning');

    // The seeded link carries its label and href.
    const link = bannerMessageLink(infoMessage);
    await expect(link).toHaveText(linkText);
    await expect(link).toHaveAttribute('href', href);

    // Dismiss: the banner leaves the DOM.
    await dismissBanner(page);
    await expect(banner(page)).toHaveCount(0);

    // Reload with the SAME set (re-seeded — no carryover assumption): the
    // stored message-set hash keeps it dismissed.
    await bannerOps.set(initialSet);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBannerSettled(page);
    await expect(banner(page)).toHaveCount(0);

    // A changed message set hashes differently, invalidating the dismissal.
    const updatedText = `E2E updated ${runTag}`;
    await bannerOps.set({
      enabled: true,
      messages: [{ variant: 'critical', text: updatedText }],
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBannerSettled(page);
    await expect(banner(page)).toBeVisible();
    const updatedMessage = messageByText(page, updatedText);
    await expect(updatedMessage).toBeVisible();
    await expect(updatedMessage).toHaveAttribute('data-variant', 'critical');

    // Disable via the op: settled with no banner (signal distinguishes
    // "no banner" from "not loaded").
    await bannerOps.set({ enabled: false, messages: [] });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBannerSettled(page);
    await expect(banner(page)).toHaveCount(0);
  });

  test('marketing site: renders the seeded banner and dismisses locally', async ({
    marketingBannerOps: bannerOps,
    unauthenticatedPage: page,
  }) => {
    // unauthenticatedPage: a fresh empty-storage context, so the shared-origin
    // localStorage dismissal state cannot leak in from other tests.
    const text = `E2E marketing ${crypto.randomUUID().slice(0, 8)}`;
    const seed: BannerSetInput = { enabled: true, messages: [{ variant: 'info', text }] };

    await bannerOps.set(seed);
    await page.goto('/welcome', { waitUntil: 'domcontentloaded' });
    await waitForBannerSettled(page);
    await expect(banner(page)).toBeVisible();
    const message = messageByText(page, text);
    await expect(message).toBeVisible();
    await expect(message).toHaveAttribute('data-variant', 'info');

    // Dismissal works on the compiled-Astro path too, and persists locally
    // across a fresh load of the same (re-seeded) set.
    await dismissBanner(page);
    await expect(banner(page)).toHaveCount(0);
    await bannerOps.set(seed);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBannerSettled(page);
    await expect(banner(page)).toHaveCount(0);
  });
});
