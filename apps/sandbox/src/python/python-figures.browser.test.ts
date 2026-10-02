import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchBrowser, startSandboxOrigin, type SandboxOrigin } from '../embed-harness.js';
import { openPythonPage, type PythonPage } from './browser-harness.js';
import type { Browser } from '@playwright/test';

/**
 * Isolated so the heavy matplotlib wheel load does not pile onto the core file's
 * runtime — each browser file stays well under the pole threshold.
 */

let sandbox: SandboxOrigin;
let browser: Browser;
let page: PythonPage;

beforeAll(async () => {
  sandbox = await startSandboxOrigin();
  browser = await launchBrowser();
  page = await openPythonPage(browser, sandbox.origin);
}, 120_000);

afterAll(async () => {
  await page.close();
  await browser.close();
  await sandbox.close();
});

describe('python matplotlib figures (real browser)', () => {
  it('returns every matplotlib figure a document plots as an image/png output', async () => {
    const code = `import matplotlib.pyplot as plt
for exponent in (1, 2, 3):
    plt.figure()
    plt.plot([0, 1, 2, 3], [value ** exponent for value in (0, 1, 2, 3)])
    plt.title("power %d" % exponent)`;
    const messages = await page.run(code, 'fig-1');

    expect(messages.some((m) => m.type === 'error')).toBe(false);
    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    const outputs = result?.outputs ?? [];
    expect(outputs.length).toBe(3);
    expect(outputs.map((output) => output.type)).toEqual(['image/png', 'image/png', 'image/png']);
    // A base64-encoded PNG always begins with the signature bytes 89 50 4E 47,
    // which encode to `iVBORw0KGgo` — proof the Agg backend produced a real image.
    for (const output of outputs) expect(output.data).toMatch(/^iVBORw0KGgo/);
    expect(page.pageErrors).toEqual([]);
  }, 120_000);
});
