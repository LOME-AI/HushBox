import { expect, test, type Page } from '@playwright/test';

export async function getHtmlClass(page: Page): Promise<string> {
  return await page.evaluate(() => document.documentElement.className);
}

export async function walkAccessibilityToggles(page: Page): Promise<void> {
  await test.step('cycle Contrast', async () => {
    await page.getByRole('button', { name: /^Contrast: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-contrast-increased');
  });

  await test.step('toggle Animations off', async () => {
    await page.getByRole('button', { name: /^Animations: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-stop-animations');
  });

  await test.step('cycle Text size', async () => {
    await page.getByRole('button', { name: /^Text size: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-font-scale-125');
  });

  await test.step('toggle Underline links', async () => {
    await page.getByRole('button', { name: /^Underline links: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-highlight-links');
  });

  await test.step('toggle Align text left', async () => {
    await page.getByRole('button', { name: /^Align text left: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-force-left');
  });

  await test.step('cycle Focus ring thickness', async () => {
    await page.getByRole('button', { name: /^Focus ring thickness: / }).click();
    const cls = await getHtmlClass(page);
    expect.soft(cls).toContain('a11y-focus-strong');
  });
}

export async function expectAllTogglesPersisted(page: Page): Promise<void> {
  const cls = await getHtmlClass(page);
  expect.soft(cls).toContain('a11y-contrast-increased');
  expect.soft(cls).toContain('a11y-font-scale-125');
  expect.soft(cls).toContain('a11y-highlight-links');
  expect.soft(cls).toContain('a11y-force-left');
  expect.soft(cls).toContain('a11y-focus-strong');
}
