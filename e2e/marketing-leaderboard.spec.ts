import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { test } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import { expect } from './helpers/expect.js';
import { openMobileLandingMenuIfNeeded } from './helpers/marketing-nav.js';
import { waitForStatsSettled, statsReadyBoard } from './helpers/page-signals.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

const PHONE_VIEWPORT = { width: 390, height: 844 };
const TABLET_VIEWPORT = { width: 834, height: 1194 };
const LEADERBOARD_URL = /\/leaderboard/;

/**
 * End-to-end coverage of the public /leaderboard page. Like /roadmap, the page
 * is built by Astro, merged on top of the web app's dist, and served by
 * `vite preview`. The stats React island fetches `/api/public/stats`, whose
 * payload is a snapshot built by the real cron entry from the deterministic
 * `db:seed` usage records (see scripts/lib/seed/fixtures.ts).
 *
 * The snapshot aggregates the WHOLE usage_records table (deliberately no
 * userId conjunct), so on a shared local database it also folds in residue
 * from vitest integration runs. Assertions therefore pin only facts the seed
 * guarantees under any superset of usage rows: both seeded modalities appear,
 * text has data in every window, the ranking is non-empty, and the
 * selection-driven labels — never exact row counts, model names, or the
 * Others row, all of which shift with unrelated usage.
 */

test.describe('Public leaderboard', SPEC_MATRIX, () => {
  test('renders seeded stats, switches windows, and is reachable from landing nav', async ({
    unauthenticatedPage: page,
  }) => {
    await page.goto('/welcome');
    await openMobileLandingMenuIfNeeded(page);
    // `.filter({ visible: true })` picks whichever of the two nav variants
    // (desktop nav or the now-open mobile drawer) is currently rendered;
    // the other lives in DOM but with `display: none` via Tailwind.
    await page.getByRole('link', { name: 'Leaderboard' }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/leaderboard/);

    await expect(page.getByRole('heading', { name: 'Leaderboard', level: 1 })).toBeVisible();
    await waitForStatsSettled(page);
    // Settled AND ready: the seeded snapshot loaded with data (not the
    // unavailable branch, which is settled but never ready).
    await expect(statsReadyBoard(page)).toBeVisible();

    // Modality tabs come from the payload: the seed writes text + image usage.
    const modalityTabs = page.getByRole('group', { name: 'Modality' });
    await expect(modalityTabs.getByRole('button', { name: 'Text' })).toBeVisible();
    await expect(modalityTabs.getByRole('button', { name: 'Image' })).toBeVisible();

    // Window pills; the board defaults to the 30-day window.
    const windowPills = page.getByRole('group', { name: 'Window' });
    for (const name of ['7 days', '30 days', 'All time']) {
      await expect(windowPills.getByRole('button', { name })).toBeVisible();
    }
    await expect(windowPills.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Ranked list (the chart's text alternative): seeded text usage
    // guarantees at least one displayed model, and every row carries its
    // share percentage.
    const ranking = page.getByRole('list', { name: 'Model share ranking' });
    await expect(ranking.getByRole('listitem').first()).toBeVisible();
    await expect(ranking.getByRole('listitem').first()).toContainText('%');

    // Trend figure: its accessible name pins modality + window.
    await expect(page.getByRole('img', { name: /Model share for Text, 30 days/ })).toBeVisible();

    // Cost by model section with its per-message basis annotation.
    await expect(page.getByRole('heading', { name: 'Cost by model' })).toBeVisible();
    await expect(page.getByText('average per message')).toBeVisible();

    // Switch windows: aria-pressed moves and the trend chart re-labels for
    // the all-time window (its content, not just the pill, updated).
    await windowPills.getByRole('button', { name: 'All time' }).click();
    await expect(windowPills.getByRole('button', { name: 'All time' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(windowPills.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(page.getByRole('img', { name: /Model share for Text, all time/ })).toBeVisible();
  });

  // The test sets its own width, so every project, tablet included, drives the phone band.
  test('the phone site menu opens, traps nothing behind it and marks the current page', async ({
    unauthenticatedPage: page,
  }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    // The menu script is a module script, so the `load` event goto awaits has run it.
    await page.goto(ROUTES.MARKETING);

    const toggle = page.getByTestId(TEST_IDS.landingMenuToggle);
    const panel = page.getByTestId(TEST_IDS.landingMobileMenu);
    const accessibilityButton = page.getByRole('button', { name: 'Accessibility settings' });

    await expect(toggle).toHaveAccessibleName('Open menu');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();

    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAccessibleName('Close menu');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute(
      'aria-controls',
      (await panel.getAttribute('id')) ?? 'the menu panel has no id'
    );

    await expect(panel.getByRole('link')).toHaveText([
      'Welcome',
      'Blog',
      'Roadmap',
      'Leaderboard',
      /GitHub/,
      'Open HushBox',
    ]);
    await expect(panel.getByRole('link', { name: 'Welcome' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(panel.getByRole('link', { name: 'Open HushBox' })).toHaveAttribute(
      'href',
      ROUTES.CHAT
    );
    await expect(panel.getByTestId(TEST_IDS.cipherWall)).toBeVisible();

    // Actionability fails when another element takes the click point: the panel leaves it free.
    // It runs before the keyboard walk: in WebKit, a Shift+Tab after a trial click leaves
    // focus where it is.
    await accessibilityButton.click({ trial: true });

    // The page behind is inert, so the Tab after the panel's last control skips `main` and
    // the footer and lands on the floating accessibility button, which stays reachable.
    const tabOrder = [
      panel.getByRole('link', { name: 'Welcome' }),
      panel.getByRole('link', { name: 'Blog' }),
      panel.getByRole('link', { name: 'Roadmap' }),
      panel.getByRole('link', { name: 'Leaderboard' }),
      panel.getByRole('link', { name: /^GitHub/ }),
      panel.getByRole('link', { name: 'Open HushBox' }),
      accessibilityButton,
    ];
    await toggle.focus();
    for (const expected of tabOrder) {
      await page.keyboard.press('Tab');
      await expect(expected).toBeFocused();
    }

    // The menu takes Escape only from inside the header or with nothing focused, leaving
    // Escape elsewhere to the accessibility sheet above it, so focus returns into the panel.
    await page.keyboard.press('Shift+Tab');
    await expect(panel.getByRole('link', { name: 'Open HushBox' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAccessibleName('Open menu');
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(panel).toBeVisible();
    await page.setViewportSize(TABLET_VIEWPORT);
    await expect(panel).toBeHidden();
    await expect(toggle).toBeHidden();
    await expect(
      page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Leaderboard' })
    ).toBeVisible();
    await page.setViewportSize(PHONE_VIEWPORT);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();

    await toggle.click();
    await panel.getByRole('link', { name: 'Leaderboard' }).click();
    // Waits for the new page's `load` event, which has run its menu script.
    await page.waitForURL(LEADERBOARD_URL);
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Leaderboard' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(panel.getByRole('link', { name: 'Welcome' })).not.toHaveAttribute('aria-current');
  });
});
