import { test, expect } from '@playwright/test';

/**
 * End-to-end coverage of the public /roadmap page. The page is built by
 * Astro, merged on top of the web app's dist by
 * `scripts/merge-marketing-into-web.ts`, then served by `vite preview` —
 * the same merged layout Cloudflare Pages serves in production. The
 * roadmap's React island fetches `/api/roadmap`, which in E2E mode uses
 * the Linear mock client, so the response is deterministic.
 */

test.describe('Public roadmap', () => {
  test('loads the roadmap shell and the constellation', async ({ page }) => {
    await page.goto('/roadmap');
    await expect(page.getByRole('heading', { name: 'Roadmap', level: 1 })).toBeVisible();
    await expect(page.locator('[data-roadmap-constellation]')).toBeVisible({ timeout: 10_000 });
    const nodeCount = await page.locator('[data-node]').count();
    expect(nodeCount).toBeGreaterThan(0);
  });

  test('renders status and type filter chips', async ({ page }) => {
    await page.goto('/roadmap');
    for (const label of ['In progress', 'Planned', 'Shipped', 'Features', 'Bugs']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('toggling a chip updates the URL and the visible node set', async ({ page }) => {
    await page.goto('/roadmap');
    await page.locator('[data-roadmap-constellation]').waitFor({ state: 'visible' });
    const fullNodeCount = await page.locator('[data-node]').count();

    await page.getByRole('button', { name: 'Shipped' }).click();

    await expect.poll(async () => new URL(page.url()).searchParams.get('status')).toContain(
      'in_progress',
    );
    const filteredCount = await page.locator('[data-node]').count();
    expect(filteredCount).toBeLessThan(fullNodeCount);
  });

  test('clicking a node dims unrelated nodes (Sonar Ping)', async ({ page }) => {
    await page.goto('/roadmap');
    await page.locator('[data-roadmap-constellation]').waitFor({ state: 'visible' });
    const nodes = page.locator('[data-node]');
    const firstNode = nodes.nth(0);
    await firstNode.click();
    // At least one other node should be dimmed.
    await expect(page.locator('[data-node][data-dimmed="true"]').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('shipping a URL with non-default filters opens with that state pre-applied', async ({
    page,
  }) => {
    await page.goto('/roadmap?status=in_progress&type=feature');
    await expect(page.getByRole('button', { name: 'Shipped' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByRole('button', { name: 'In progress' })).toHaveAttribute(
      'aria-pressed',
      'true',
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
