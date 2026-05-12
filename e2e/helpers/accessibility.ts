import { expect, test, type Page } from '@playwright/test';

export async function getHtmlClass(page: Page): Promise<string> {
  return await page.evaluate(() => document.documentElement.className);
}

/**
 * Click through a representative set of accessibility-panel cards and confirm
 * each one writes the expected class onto `<html>`. Used by both the in-app
 * `/accessibility` walk and the marketing widget walk.
 *
 * Each step uses `expect.soft` so a single mismatch doesn't abort the rest of
 * the walk — the caller sees the full set of failures at end-of-test.
 */
export async function walkAccessibilityToggles(page: Page): Promise<void> {
  await test.step('cycle Contrast', async () => {
    // Default 'normal' → next is 'increased' which sets the increased class.
    await page.getByRole('button', { name: /^Contrast: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-contrast-increased');
  });

  await test.step('toggle Animations off', async () => {
    // Default 'Allow' → 'Stop' applies the stop-animations class.
    await page.getByRole('button', { name: /^Animations: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-stop-animations');
  });

  await test.step('cycle Text size', async () => {
    // Default '100' (Normal) → '125' (Larger) → a11y-font-scale-125.
    await page.getByRole('button', { name: /^Text size: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-font-scale-125');
  });

  await test.step('cycle Focus ring thickness', async () => {
    // Default 'Off' (focusWidth '0') → 'Thin' (focusWidth '2'). Any non-off
    // width applies the a11y-focus-strong class.
    await page.getByRole('button', { name: /^Focus ring thickness: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-focus-strong');
  });
}

export async function expectAllTogglesPersisted(page: Page): Promise<void> {
  const cls = await getHtmlClass(page);
  expect.soft(cls).toContain('a11y-contrast-increased');
  expect.soft(cls).toContain('a11y-stop-animations');
  expect.soft(cls).toContain('a11y-font-scale-125');
  expect.soft(cls).toContain('a11y-focus-strong');
}
