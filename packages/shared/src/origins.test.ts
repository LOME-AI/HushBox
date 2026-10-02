import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capacitorOrigins, nativeWebViewServer } from './origins.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const WRANGLER_CONFIG_NAMES = new Set(['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']);

/**
 * The text of every Worker config in the repo, keyed by its repo-relative path:
 * every file named `wrangler.toml`, `wrangler.json` or `wrangler.jsonc` at any
 * depth that git tracks or would track (`git ls-files --cached --others
 * --exclude-standard`), so ignored paths such as installed dependencies and
 * build output are not scanned. A Worker config is where a route or custom
 * domain is declared, and a custom domain has wrangler provision its DNS record
 * and certificate. Each file is read whole rather than parsed, so any syntax
 * that names a hostname is caught.
 */
function workerConfigs(): Map<string, string> {
  const listing = spawnSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool wherever this repo is checked out
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    // The file list grows with the checkout and has no bound under spawnSync's default buffer; an overflow makes the scan throw.
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (listing.status !== 0) {
    throw new Error(`git ls-files failed: ${listing.error?.message ?? listing.stderr}`);
  }
  return new Map(
    listing.stdout
      .split('\0')
      .filter((file) => WRANGLER_CONFIG_NAMES.has(path.posix.basename(file)))
      .filter((file) => existsSync(path.join(REPO_ROOT, file)))
      .map((file): [string, string] => [file, readFileSync(path.join(REPO_ROOT, file), 'utf8')])
  );
}

describe('nativeWebViewServer', () => {
  it('serves the production bundle over https from the app-owned hostname', () => {
    expect(nativeWebViewServer(true)).toEqual({
      hostname: 'native.hushbox.ai',
      androidScheme: 'https',
    });
  });

  it('serves every other mode over http from localhost', () => {
    expect(nativeWebViewServer(false)).toEqual({ hostname: 'localhost', androidScheme: 'http' });
  });
});

describe('capacitorOrigins', () => {
  it('is the iOS and Android origins of the app-owned hostname in production', () => {
    expect(capacitorOrigins(true)).toEqual([
      'capacitor://native.hushbox.ai',
      'https://native.hushbox.ai',
    ]);
  });

  it('is the iOS and Android localhost origins outside production', () => {
    expect(capacitorOrigins(false)).toEqual(['capacitor://localhost', 'http://localhost']);
  });

  it('names no localhost origin in production', () => {
    for (const origin of capacitorOrigins(true)) {
      expect(new URL(origin).hostname).not.toBe('localhost');
    }
  });
});

describe('the production native hostname', () => {
  it('appears in no Worker config, so nothing publishes it in DNS', () => {
    const { hostname } = nativeWebViewServer(true);
    const naming = [...workerConfigs()]
      .filter(([, text]) => text.includes(hostname))
      .map(([file]) => file);
    expect(naming).toEqual([]);
  });

  it('is checked against configs that do name hostnames', () => {
    // The control that makes the Worker-config scan evidence: it reads a
    // hostname a custom-domain route publishes.
    const texts = [...workerConfigs().values()];
    expect(texts.some((text) => text.includes('sandbox.hushbox.ai'))).toBe(true);
  });
});
