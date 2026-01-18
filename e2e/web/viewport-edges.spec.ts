import { test, expect } from '../fixtures.js';

/**
 * Viewport edge visibility tests.
 * Ensures all four corners of the UI are visible and nothing overflows.
 * These tests run on ALL devices (desktop, mobile, tablet) to catch
 * viewport height issues like the iOS Safari 100vh bug.
 */
test.describe('Viewport edge visibility', () => {
  test('all corner elements are visible and within viewport', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/chat');

    // Wait for the page to be fully loaded
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const viewportSize = page.viewportSize();
    if (!viewportSize) {
      throw new Error('Viewport size not available');
    }

    // Top-left: Sidebar header (desktop only - hidden on mobile)
    const sidebarHeader = page.getByTestId('sidebar-header');
    if (viewportSize.width >= 768) {
      await expect(sidebarHeader).toBeVisible();
      await expect(sidebarHeader).toBeInViewport();

      const headerBox = await sidebarHeader.boundingBox();
      if (!headerBox) throw new Error('Expected header bounding box');
      expect(headerBox.y).toBeGreaterThanOrEqual(0);
      expect(headerBox.x).toBeGreaterThanOrEqual(0);
    }

    // Bottom-left: Sidebar footer / account button (desktop only)
    const sidebarFooter = page.getByTestId('sidebar-footer');
    if (viewportSize.width >= 768) {
      await expect(sidebarFooter).toBeVisible();
      await expect(sidebarFooter).toBeInViewport();

      const footerBox = await sidebarFooter.boundingBox();
      if (!footerBox) throw new Error('Expected footer bounding box');
      // Bottom of footer should be within viewport
      expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewportSize.height);
    }

    // Top-right: Model selector button (visible on all viewports)
    const modelSelector = page.getByTestId('model-selector-button');
    await expect(modelSelector).toBeVisible();
    await expect(modelSelector).toBeInViewport();

    const modelBox = await modelSelector.boundingBox();
    if (!modelBox) throw new Error('Expected model selector bounding box');
    expect(modelBox.y).toBeGreaterThanOrEqual(0);
    expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(viewportSize.width);

    // Bottom-right: Prompt input (visible on all viewports)
    const promptInput = page.getByRole('textbox', { name: 'Ask me anything...' });
    await expect(promptInput).toBeVisible();
    await expect(promptInput).toBeInViewport();

    const inputBox = await promptInput.boundingBox();
    if (!inputBox) throw new Error('Expected prompt input bounding box');
    // Bottom of input should be within viewport
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(viewportSize.height);
  });

  test('app shell does not overflow viewport', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/chat');

    await expect(page.getByTestId('app-shell')).toBeVisible();

    const viewportSize = page.viewportSize();
    if (!viewportSize) {
      throw new Error('Viewport size not available');
    }

    // Check that app-shell exactly matches viewport (no overflow)
    const appShell = page.getByTestId('app-shell');
    const shellBox = await appShell.boundingBox();
    if (!shellBox) throw new Error('Expected app shell bounding box');

    // Shell should start at top-left
    expect(shellBox.x).toBe(0);
    expect(shellBox.y).toBe(0);

    // Shell should not exceed viewport dimensions
    expect(shellBox.width).toBeLessThanOrEqual(viewportSize.width);
    expect(shellBox.height).toBeLessThanOrEqual(viewportSize.height);

    // Check body has no scrollbars (overflow: hidden should prevent this)
    const hasVerticalScrollbar = await page.evaluate(() => {
      return document.documentElement.scrollHeight > document.documentElement.clientHeight;
    });
    expect(hasVerticalScrollbar).toBe(false);

    const hasHorizontalScrollbar = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScrollbar).toBe(false);
  });

  test('sidebar does not overflow its container (desktop)', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/chat');

    const viewportSize = page.viewportSize();
    if (!viewportSize || viewportSize.width < 768) {
      // Skip on mobile - sidebar is hidden
      test.skip();
      return;
    }

    await expect(page.getByTestId('app-shell')).toBeVisible();

    // Get sidebar dimensions via header and footer
    const sidebarHeader = page.getByTestId('sidebar-header');
    const sidebarFooter = page.getByTestId('sidebar-footer');

    await expect(sidebarHeader).toBeVisible();
    await expect(sidebarFooter).toBeVisible();

    const headerBox = await sidebarHeader.boundingBox();
    const footerBox = await sidebarFooter.boundingBox();

    if (!headerBox) throw new Error('Expected header bounding box');
    if (!footerBox) throw new Error('Expected footer bounding box');

    // Header should be at top
    expect(headerBox.y).toBe(0);

    // Footer bottom should be at viewport bottom (not cut off)
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewportSize.height);

    // Sidebar elements should be left-aligned
    expect(headerBox.x).toBe(0);
    expect(footerBox.x).toBe(0);
  });
});
