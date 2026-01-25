import { test as setup } from '@playwright/test';
import { TEST_PERSONAS } from '../scripts/seed.js';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '.auth');

// Filter to verified personas only (unverified cannot log in)
const verifiedPersonas = TEST_PERSONAS.filter((p) => p.emailVerified);

// Ensure auth directory exists
setup.beforeAll(() => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
});

// Each persona gets its own test - runs in parallel up to worker limit
for (const persona of verifiedPersonas) {
  setup(`authenticate ${persona.name}`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/dev/personas?type=test');
    await page.locator(`[data-testid="persona-card-${persona.name}"]`).click();
    await page.waitForURL('/chat', { timeout: 30_000 });

    await context.storageState({ path: path.join(authDir, `${persona.name}.json`) });
    await context.close();
  });
}
