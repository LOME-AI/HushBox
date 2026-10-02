import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { serviceWorkerBuildPlugin } from './service-worker-build-plugin.js';

/**
 * A throwaway app root with the two entries the real one has: the app's own,
 * which the outer build compiles, and the worker's, which the plugin compiles
 * in a second pass. Real builds rather than an inspected config object, because
 * what the criterion is about is which directory receives bytes.
 */
async function createAppRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sw-plugin-'));
  await mkdir(path.join(root, 'src', 'sw'), { recursive: true });
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const appEntry = 1;\n');
  await writeFile(path.join(root, 'src', 'sw', 'sw.ts'), 'export const workerEntry = 2;\n');
  return root;
}

async function buildApp(root: string, outDir: string): Promise<void> {
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [serviceWorkerBuildPlugin(path.join(root, 'src', 'sw', 'sw.ts'))],
    build: {
      outDir,
      minify: false,
      lib: {
        entry: path.join(root, 'src', 'main.ts'),
        formats: ['iife'],
        name: 'appUnderTest',
        fileName: () => 'main.js',
      },
    },
  });
}

describe('the service-worker build plugin', () => {
  let root: string;

  beforeEach(async () => {
    root = await createAppRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('emits the worker into the configured output directory', async () => {
    await buildApp(root, 'dist-other');

    expect(await readdir(path.join(root, 'dist-other'))).toContain('sw.js');
  });

  it('writes nothing into the default output directory when another is configured', async () => {
    await buildApp(root, 'dist-other');

    expect(existsSync(path.join(root, 'dist'))).toBe(false);
  });

  it('emits the worker into the default output directory when none is configured', async () => {
    await buildApp(root, 'dist');

    expect(await readdir(path.join(root, 'dist'))).toContain('sw.js');
  });
});
