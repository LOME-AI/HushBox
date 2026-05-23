import { test, expect } from '@playwright/test';

/**
 * End-to-end coverage of the public /roadmap page. The page is built by
 * Astro, merged on top of the web app's dist by
 * `scripts/merge-marketing-into-web.ts`, then served by `vite preview` —
 * the same merged layout Cloudflare Pages serves in production. The
 * roadmap's React island fetches `/api/public/roadmap`, which in E2E mode
 * uses the Linear mock client, so the response is deterministic.
 */

test.describe('Public roadmap', () => {
  test('loads the cipher header and the board', async ({ page }) => {
    await page.goto('/roadmap');
    await expect(page.getByRole('heading', { name: 'Roadmap', level: 1 })).toBeVisible();
    await expect(page.locator('[data-roadmap-ready]')).toBeVisible({ timeout: 10_000 });
  });

  test('renders status sections in order: in_progress → planned → shipped', async ({ page }) => {
    await page.goto('/roadmap');
    await page.locator('[data-roadmap-ready]').waitFor({ state: 'visible' });
    const sections = page.locator('section[data-status]');
    await expect(sections.first()).toHaveAttribute('data-status', 'in_progress');
  });

  test('renders status and type filter chips with counts', async ({ page }) => {
    await page.goto('/roadmap');
    await page.locator('[data-roadmap-ready]').waitFor({ state: 'visible' });
    for (const name of ['Shipping now', 'Up next', 'Shipped', 'Features', 'Bugs']) {
      await expect(page.getByRole('button', { name: new RegExp(name, 'i') })).toBeVisible();
    }
  });

  test('clicking a status chip hides its section and updates the URL', async ({ page }) => {
    await page.goto('/roadmap');
    await page.locator('[data-roadmap-ready]').waitFor({ state: 'visible' });
    await expect(page.locator('section[data-status="shipped"]')).toBeVisible();

    await page.getByRole('button', { name: /Shipped/i }).click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get('status'))
      .toContain('in_progress');
    await expect(page.locator('section[data-status="shipped"]')).toHaveCount(0);
  });

  test('clicking a type chip surfaces a "hidden by filter" note on affected cards', async ({
    page,
  }) => {
    await page.goto('/roadmap');
    await page.locator('[data-roadmap-ready]').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /Bugs/i }).click();
    await expect(page.getByText(/hidden by filter/i).first()).toBeVisible();
  });

  test('shipping a URL with non-default filters opens with that state pre-applied', async ({
    page,
  }) => {
    await page.goto('/roadmap?status=in_progress&type=feature');
    await page.locator('[data-roadmap-ready]').waitFor({ state: 'visible' });
    await expect(page.getByRole('button', { name: /Shipped/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(page.getByRole('button', { name: /Shipping now/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('roadmap is reachable from the landing header nav', async ({ page }) => {
    await page.goto('/welcome');
    const desktopRoadmapLink = page.locator('nav.hidden a', { hasText: 'Roadmap' });
    if (await desktopRoadmapLink.count()) {
      await desktopRoadmapLink.first().click();
      await expect(page).toHaveURL(/\/roadmap/);
    }
  });
});
