import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Both layouts fall back to `/og-default.png` (BlogLayout via `${Astro.site}`,
 * LandingLayout via `new URL('og-default.png', Astro.site)`). Astro serves
 * `public/` at the site root, so the fallback only resolves if this file is
 * committed. This guards against the OG 404 the file backfills.
 */
const ogPath = path.resolve(__dirname, '../../public/og-default.png');

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('og-default.png public asset', () => {
  it('exists in the marketing public directory', () => {
    expect(existsSync(ogPath)).toBe(true);
  });

  it('is a 1200x630 PNG', () => {
    const { width, height } = readPngDimensions(readFileSync(ogPath));
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });
});
