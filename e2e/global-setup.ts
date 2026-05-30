/**
 * Prints which GL renderer each browser engine resolves to, once per run.
 *
 * Purely informational — no assertions, no gating. It answers "are the
 * browsers actually using the GPU, or silently falling back to software?"
 * without any OS-specific tool (no vulkaninfo/glxinfo): it asks the browser
 * itself via WebGL's UNMASKED_RENDERER_WEBGL, so it works identically on any
 * platform. Runs once (≤3 engine launches), never per-test.
 */

import { chromium, firefox, webkit } from '@playwright/test';
import type { BrowserType } from '@playwright/test';

const ENGINES: readonly { name: string; type: BrowserType }[] = [
  { name: 'chromium', type: chromium },
  { name: 'firefox', type: firefox },
  { name: 'webkit', type: webkit },
];

function classify(renderer: string): 'hardware' | 'software' {
  return /swiftshader|llvmpipe|software|\bwarp\b/i.test(renderer) ? 'software' : 'hardware';
}

async function readRenderer(type: BrowserType): Promise<string> {
  const browser = await type.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl') ??
        canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
      if (!gl) return 'no WebGL';
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      const value: unknown = extension
        ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      return typeof value === 'string' && value.length > 0 ? value : 'unknown';
    });
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(): Promise<void> {
  const lines = ['', 'GPU renderers (this run):'];
  for (const { name, type } of ENGINES) {
    try {
      const renderer = await readRenderer(type);
      lines.push(`  ${name.padEnd(9)} ${renderer}  [${classify(renderer)}]`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`  ${name.padEnd(9)} (probe skipped: ${message})`);
    }
  }
  // eslint-disable-next-line no-console -- informational once-per-run diagnostic
  console.log(lines.join('\n'));
}
