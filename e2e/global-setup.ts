/**
 * Playwright global setup: a hard storage-readiness precondition and a
 * GPU-renderer diagnostic.
 *
 * The GPU probe is purely informational — no assertions, no gating. It answers
 * "are the browsers actually using the GPU, or silently falling back to
 * software?" without any OS-specific tool (no vulkaninfo/glxinfo): it asks the
 * browser itself via WebGL's UNMASKED_RENDERER_WEBGL, so it works identically
 * on any platform. Runs once (≤3 engine launches), never per-test.
 *
 * The bucket gate DOES block the run. Container health is not storage
 * readiness: MinIO can be healthy while the buckets the loaded environment
 * names for this stack do not exist (cold volume, a volume wiped under warm
 * containers, or a crash between MinIO start and setup), and a `storage.put`
 * against a bucket that is not there becomes `NoSuchBucket` → UNAVAILABLE
 * mid-run. Binding the gate here — not only to the stack bring-up in
 * ensure-stack/`db:up` — guarantees them for THIS `playwright test` invocation
 * however the stack was started. It reuses the single readiness mechanism
 * (`ensureStackBucketsReady`), never a second one.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';
import { execa } from 'execa';
import { ensureStackBucketsReady } from '../scripts/lib/stack/minio-bucket-ready.js';
import { createDockerBucketReadyDeps } from '../scripts/lib/stack/minio-bucket-ready-docker.js';
import { stackBucketsFrom } from '../scripts/lib/stack/stack-bucket.js';
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

async function ensureStackBuckets(): Promise<void> {
  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(e2eDir, '..');
  const deps = createDockerBucketReadyDeps(async (args, options) => {
    const result = await execa('docker', [...args], {
      cwd: repoRoot,
      stdio: options.inheritStdio ? 'inherit' : 'pipe',
      env: process.env,
      reject: false,
    });
    return { exitCode: result.exitCode ?? 1 };
  }, stackBucketsFrom(process.env));
  await ensureStackBucketsReady(deps);
}

/**
 * Playwright loads this file from the `globalSetup` path in
 * `playwright.config.ts` and calls its default export, so no module imports it.
 * @toolContract
 */
export default async function globalSetup(): Promise<void> {
  // Hard precondition first: a missing bucket must abort the run before any
  // browser launches, not surface later as a mid-run UNAVAILABLE.
  await ensureStackBuckets();

  // Probe engines concurrently (independent browsers); mapped in ENGINES order.
  const probes = await Promise.all(
    ENGINES.map(async ({ name, type }) => {
      try {
        const renderer = await readRenderer(type);
        return `  ${name.padEnd(9)} ${renderer}  [${classify(renderer)}]`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `  ${name.padEnd(9)} (probe skipped: ${message})`;
      }
    })
  );
  const lines = ['', 'GPU renderers (this run):', ...probes];
  // eslint-disable-next-line no-console -- informational once-per-run diagnostic
  console.log(lines.join('\n'));
}
