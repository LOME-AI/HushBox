import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { startAssetsRuntime } from './assets-runtime.js';

/**
 * The assets runtime, started for a test, must leave nothing behind beside the
 * config it was pointed at.
 *
 * Wrangler's local persistence path defaults to a directory beside the config
 * when no persistence setting is given, so a suite pointed at this package's own
 * `wrangler.toml` fills a store inside the checkout on every run. That failure
 * is silent and arrives late — a directory nobody can account for, days after
 * the run that made it — which is why it is pinned by execution here rather than
 * left to the setting being read correctly.
 *
 * The config is copied to a temporary directory before the runtime is pointed at
 * it: a failure of this assertion writes the store, so asserting against the
 * real package directory would itself create the thing being refused.
 */

const PACKAGE_ROOT = path.join(import.meta.dirname, '..');

describe('the assets runtime started for a test', () => {
  it('creates nothing beside the config it is pointed at', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sandbox-persistence-'));
    try {
      const configPath = path.join(root, 'wrangler.toml');
      copyFileSync(path.join(PACKAGE_ROOT, 'wrangler.toml'), configPath);
      const assets = path.join(root, 'assets');
      mkdirSync(assets);
      writeFileSync(path.join(assets, 'index.html'), '<!doctype html>');

      const worker = await startAssetsRuntime(configPath, assets);
      try {
        const response = await fetch(new URL('/index.html', String(await worker.url)));
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      } finally {
        await worker.dispose();
      }

      expect(readdirSync(root).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'assets',
        'wrangler.toml',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
