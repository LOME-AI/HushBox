import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalFonts } from '@napi-rs/canvas';
import {
  collectBannerInputs,
  generateBanners,
  registerBannerFonts,
  type GenerateBannerGifOptions,
} from './generate-banner.js';
import { getBrandColors, type ThemeColors } from './brand.js';

interface RenderCall {
  outputPath: string;
  theme: ThemeColors;
  seed: string | undefined;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Writes a stub file so the cache's output-existence check sees both banners.
 * Keeps these tests free of a real (~114s) GIF render — the renders are
 * exercised by the per-variant files.
 */
function stubRender(outputPath: string): void {
  writeFileSync(outputPath, 'stub');
}

describe('collectBannerInputs', () => {
  // withCache skips hash persistence entirely when any input is missing, so an
  // unresolvable input silently turns the cache off instead of failing.
  it('declares only paths that exist on disk', () => {
    const missing = collectBannerInputs(REPO_ROOT).filter((file) => !existsSync(file));

    expect(missing).toEqual([]);
  });

  // The renderer seeds crypto.getRandomValues and the cipher engine draws every
  // cell placement through this module, so its arithmetic decides pixels while
  // no import in this directory names it.
  it('declares the randomness module the cipher engine draws through', () => {
    const inputs = collectBannerInputs(REPO_ROOT);

    expect(inputs).toContain(
      realpathSync(path.join(REPO_ROOT, 'packages/shared/src/utils/random.ts'))
    );
  });

  // Each of these three shapes the bytes — the PRNG stream behind every cell
  // position, the rasterizer, the encoder — and all three sit on caret ranges,
  // so an ordinary dependency bump moves them. Compared by the name each
  // manifest declares rather than by its path, because `@types/seedrandom` lives
  // at a path ending "seedrandom/package.json" while carrying a version that
  // does not track the library producing the stream — the exact mis-resolution
  // the compiler makes, and the reason these pins are not derived from it.
  it('declares a manifest for every third-party library that shapes the frames', () => {
    const declared = collectBannerInputs(REPO_ROOT)
      .filter((file) => file.endsWith('package.json'))
      .map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { name: string }).name);

    expect(declared).toEqual(
      expect.arrayContaining(['seedrandom', '@napi-rs/canvas', 'gif-encoder-2'])
    );
  });
});

describe('registerBannerFonts', () => {
  // registerFromPath returns null for an unreadable path instead of throwing,
  // so a stale font location renders the wordmark and cipher grid in whatever
  // the canvas falls back to, with nothing failing anywhere.
  it('makes the banner font families available to the canvas', () => {
    registerBannerFonts(REPO_ROOT);

    expect([GlobalFonts.has('JetBrains Mono'), GlobalFonts.has('Merriweather')]).toEqual([
      true,
      true,
    ]);
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

  it('renders dark then light through the injected renderer with per-variant seeds, defaulting repoRoot to cwd', () => {
    const brand = getBrandColors(REPO_ROOT);
    const calls: RenderCall[] = [];
    const fakeRender = (
      outputPath: string,
      theme: ThemeColors,
      options?: GenerateBannerGifOptions
    ): void => {
      calls.push({ outputPath, theme, seed: options?.seed });
      stubRender(outputPath);
    };

    const previousCwd = process.cwd();
    process.chdir(REPO_ROOT);
    try {
      // No repoRoot argument: exercises the `repoRoot ?? process.cwd()` default
      // against the real source tree (cold cache in a fresh temp outputDir).
      generateBanners(temporaryDir, undefined, fakeRender);
    } finally {
      process.chdir(previousCwd);
    }

    const darkPath = path.join(temporaryDir, 'banner-dark.gif');
    const lightPath = path.join(temporaryDir, 'banner-light.gif');

    expect(calls).toEqual([
      { outputPath: darkPath, theme: brand.dark, seed: 'hushbox-banner-dark' },
      { outputPath: lightPath, theme: brand.light, seed: 'hushbox-banner-light' },
    ]);
    expect(existsSync(darkPath)).toBe(true);
    expect(existsSync(lightPath)).toBe(true);
  });

  it('records the freshness hash inside the directory it generated into', () => {
    generateBanners(temporaryDir, REPO_ROOT, stubRender);

    expect(existsSync(path.join(temporaryDir, '.cache/banner.hash'))).toBe(true);
  });

  // The hash certifies that a set of outputs matches the inputs. Stamping it
  // against the repository while the GIFs went somewhere else lets the
  // pre-commit hook skip regeneration and commit stale artifacts under a hash
  // that says they are fresh.
  it('leaves the repository freshness hash untouched', () => {
    const repositoryHash = path.join(REPO_ROOT, '.github/readme/.cache/banner.hash');
    const before = statSync(repositoryHash, { bigint: true }).mtimeNs;

    generateBanners(temporaryDir, REPO_ROOT, stubRender);

    expect(statSync(repositoryHash, { bigint: true }).mtimeNs).toBe(before);
  });
});
