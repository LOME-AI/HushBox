import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBanners, patchCryptoWithSeed } from './generate-banner.js';

describe('patchCryptoWithSeed', () => {
  it('makes crypto.getRandomValues deterministic for a given seed', () => {
    patchCryptoWithSeed('seed-a');
    const a1 = new Uint32Array(4);
    crypto.getRandomValues(a1);

    patchCryptoWithSeed('seed-a');
    const a2 = new Uint32Array(4);
    crypto.getRandomValues(a2);

    expect([...a1]).toEqual([...a2]);
  });

  it('produces different sequences for different seeds', () => {
    patchCryptoWithSeed('seed-a');
    const a = new Uint32Array(4);
    crypto.getRandomValues(a);

    patchCryptoWithSeed('seed-b');
    const b = new Uint32Array(4);
    crypto.getRandomValues(b);

    expect([...a]).not.toEqual([...b]);
  });
});

describe('generateBanners', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'banner-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('creates both banner-dark.gif and banner-light.gif with non-trivial size', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    generateBanners(temporaryDir, repoRoot);

    const files = readdirSync(temporaryDir);
    expect(files).toContain('banner-dark.gif');
    expect(files).toContain('banner-light.gif');

    const darkSize = statSync(path.join(temporaryDir, 'banner-dark.gif')).size;
    const lightSize = statSync(path.join(temporaryDir, 'banner-light.gif')).size;
    expect(darkSize).toBeGreaterThan(10_000);
    expect(lightSize).toBeGreaterThan(10_000);
  }, 180_000);
});
