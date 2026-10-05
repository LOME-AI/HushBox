import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envConfig, Mode, resolveRaw } from '@hushbox/shared/env.config';
import { buildSandbox, sandboxBundleOptions } from './build.js';
import { buildSandboxConfigScript } from './config.js';
import { collectBundleViolations } from '../../../scripts/verify-bundle.js';

describe('buildSandbox', () => {
  let root: string;
  let publicDir: string;
  let distributionDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sandbox-build-'));
    publicDir = path.join(root, 'public');
    distributionDir = path.join(root, 'dist');
    mkdirSync(publicDir);
    writeFileSync(path.join(publicDir, 'render.html'), '<!doctype html>render');
    mkdirSync(path.join(publicDir, 'pyodide'));
    writeFileSync(path.join(publicDir, 'pyodide', 'core.wasm'), Buffer.from([0x00, 0x61]));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies the public pages into dist', () => {
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=1;' });
    expect(readFileSync(path.join(distributionDir, 'render.html'), 'utf8')).toBe(
      '<!doctype html>render'
    );
  });

  it('copies nested pyodide assets into dist', () => {
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=1;' });
    expect(existsSync(path.join(distributionDir, 'pyodide', 'core.wasm'))).toBe(true);
  });

  it('writes the env-derived config.js into dist', () => {
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=42;' });
    expect(readFileSync(path.join(distributionDir, 'config.js'), 'utf8')).toBe('globalThis.X=42;');
  });

  it('clears a stale dist so a rebuild leaves no orphaned files', () => {
    mkdirSync(distributionDir);
    writeFileSync(path.join(distributionDir, 'orphan.html'), 'old');
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=1;' });
    expect(existsSync(path.join(distributionDir, 'orphan.html'))).toBe(false);
    expect(existsSync(path.join(distributionDir, 'render.html'))).toBe(true);
  });
});

describe('the sandbox dist the build verifies', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  let root: string;
  let distributionDir: string;

  /** A production registry literal, as the shipping build reads it. */
  const productionValue = (key: 'ESM_CDN_URL' | 'SANDBOX_ORIGIN_URL'): string => {
    const raw = resolveRaw(envConfig[key], Mode.Production);
    if (typeof raw !== 'string') throw new TypeError(`${key} has no production literal`);
    return raw;
  };

  /** What a shipping build verifies, pointed at this test's dist. */
  const shippingViolations = (): Promise<string[]> =>
    collectBundleViolations({
      ...sandboxBundleOptions(repoRoot, Mode.Production),
      distributionDir,
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sandbox-verify-'));
    distributionDir = path.join(root, 'dist');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('holds a shipping build to an empty frontend supply', () => {
    expect(sandboxBundleOptions(repoRoot, Mode.Production).stackEnvFile).toBeNull();
  });

  it('compares nothing for a build that ships nothing', () => {
    expect(sandboxBundleOptions(repoRoot, Mode.E2E).stackEnvFile).toBeUndefined();
  });

  it('fails a shipping dist that bakes any frontend value', async () => {
    buildSandbox({
      publicDir: path.join(import.meta.dirname, '..', 'public'),
      distDir: distributionDir,
      configScript: 'globalThis.X={VITE_API_URL:"https://api.example.test"};',
    });

    const violations = await shippingViolations();

    expect(violations.filter((violation) => violation.includes('VITE_API_URL'))).toHaveLength(1);
  });

  it('passes the dist the shipping build assembles from the committed pages', async () => {
    buildSandbox({
      publicDir: path.join(import.meta.dirname, '..', 'public'),
      distDir: distributionDir,
      configScript: buildSandboxConfigScript({
        ESM_CDN_URL: productionValue('ESM_CDN_URL'),
        SANDBOX_ORIGIN_URL: productionValue('SANDBOX_ORIGIN_URL'),
      }),
    });

    expect(await shippingViolations()).toEqual([]);
  });
});
