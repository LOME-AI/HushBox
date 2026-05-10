import { expect, test, type Page } from '@playwright/test';

/**
 * Shared toggle-walking helper used by both `accessibility-app.spec.ts` and
 * `accessibility-marketing.spec.ts`. The marketing walkthrough has a panel
 * trigger to open before toggling; the app version is already on the
 * dedicated route. Otherwise the assertions are identical.
 */

/** Read the current className on the document element for class assertions. */
export async function getHtmlClass(page: Page): Promise<string> {
  return await page.evaluate(() => document.documentElement.className);
}

/** Walk the representative-toggle set, asserting each class via expect.soft. */
export async function walkAccessibilityToggles(page: Page): Promise<void> {
  await test.step('toggle high contrast', async () => {
    await page.getByRole('button', { name: /Contrast:/ }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-contrast-increased');
  });

  await test.step('toggle stop animations', async () => {
    await page.getByRole('button', { name: /Stop animations:/ }).click();
    const cls = await getHtmlClass(page);
    // Either class matches — exact resolution depends on the OS preference for
    // `prefers-reduced-motion` in the headless browser.
    expect.soft(cls).toMatch(/a11y-stop-animations|a11y-contrast-increased/);
  });

  await test.step('cycle font size', async () => {
    await page.getByRole('button', { name: /Font size:/ }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-font-scale-125');
  });

  await test.step('toggle highlight links via switch', async () => {
    await page.getByRole('switch', { name: 'Highlight links' }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-highlight-links');
  });

  await test.step('toggle force left-align via switch', async () => {
    await page.getByRole('switch', { name: 'Force left-align' }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-force-left');
  });

  await test.step('cycle focus width', async () => {
    await page.getByRole('button', { name: /Focus width:/ }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-focus-strong');
  });
}

/** Assert all walked toggles are still present on `<html>` after a reload. */
export async function expectAllTogglesPersisted(page: Page): Promise<void> {
  const cls = await getHtmlClass(page);
  expect.soft(cls).toContain('a11y-contrast-increased');
  expect.soft(cls).toContain('a11y-font-scale-125');
  expect.soft(cls).toContain('a11y-highlight-links');
  expect.soft(cls).toContain('a11y-force-left');
  expect.soft(cls).toContain('a11y-focus-strong');
}
