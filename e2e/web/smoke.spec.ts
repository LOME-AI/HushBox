import { test, expect } from '@playwright/test';
import { execa, type ResultPromise } from 'execa';

const PREVIEW_URL = 'http://localhost:4173';

test.use({ baseURL: PREVIEW_URL });

let previewProcess: ResultPromise | undefined;

async function isPortReachable(): Promise<boolean> {
  try {
    const response = await fetch(PREVIEW_URL, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Preview server on ${PREVIEW_URL} did not start within ${String(timeoutMs)}ms`);
}

test.describe('Production Build Smoke Tests', () => {
  test.beforeAll(async () => {
    if (await isPortReachable()) return;

    await execa('pnpm', ['--filter', '@hushbox/web', 'build'], { stdio: 'inherit' });
    previewProcess = execa('pnpm', ['--filter', '@hushbox/web', 'preview', '--port', '4173'], {
      stdio: 'inherit',
    });
    await waitForServer();
  });

  test.afterAll(() => {
    if (previewProcess) {
      previewProcess.kill();
      previewProcess = undefined;
    }
  });

  test('core pages load correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/chat');

    await expect(page.getByRole('textbox', { name: 'Ask me anything...' })).toBeVisible();

    await page.goto('/projects');
    await expect(page.locator('body')).toContainText('Projects');
  });
});
