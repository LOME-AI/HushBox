import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSite } from './site-url';

const marketingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Source extensions only, minus this app's test files: a test naming the literal
// is asserting about it, not re-typing it.
function productSourceFiles(): string[] {
  const sourceDir = path.join(marketingRoot, 'src');
  return readdirSync(sourceDir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.(ts|tsx|astro|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => path.join(sourceDir, entry));
}

describe('requireSite', () => {
  it('returns the configured site URL', () => {
    const site = new URL('https://example.test');
    expect(requireSite(site)).toBe(site);
  });

  it('throws naming the missing config key when the site is absent', () => {
    const configWithoutSite: { site?: URL } = {};
    expect(() => requireSite(configWithoutSite.site)).toThrow(/site/);
  });
});

describe('the canonical site URL', () => {
  it('is typed once, in astro.config.mjs', () => {
    const config = readFileSync(path.join(marketingRoot, 'astro.config.mjs'), 'utf8');
    expect(config.match(/https:\/\/hushbox\.ai/g)).toHaveLength(1);
  });

  it('is re-typed in no source file under src', () => {
    const offenders = productSourceFiles()
      .filter((file) => readFileSync(file, 'utf8').includes('https://hushbox.ai'))
      .map((file) => path.relative(marketingRoot, file));
    expect(offenders).toEqual([]);
  });
});
