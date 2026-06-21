import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(stylesDir, '../../../../../../');

const SOURCE_ROOTS = ['apps', 'packages'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.astro', '.turbo', 'coverage']);

const TAILWIND_CONFIG = path.join(repoRoot, 'packages/config/tailwind/index.css');

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file);
}

function collectSourceFiles(dir: string, accumulator: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(full, accumulator);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      accumulator.push(full);
    }
  }
}

function findMatches(needle: string, allow: (file: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const files: string[] = [];
    collectSourceFiles(path.join(repoRoot, root), files);
    for (const file of files) {
      if (allow(file)) continue;
      if (readFileSync(file, 'utf8').includes(needle)) offenders.push(file);
    }
  }
  return offenders;
}

describe('token canonicalization guards', () => {
  it('no source file uses the non-canonical text-foreground-muted utility', () => {
    // The alias DEFINITION (--color-foreground-muted) in the tailwind config is
    // intentionally retained; only the utility CLASS usage is banned. Test files
    // (including this guard) name the banned string and are excluded.
    const offenders = findMatches(
      'text-foreground-muted',
      (file) => file === TAILWIND_CONFIG || isTestFile(file)
    );
    expect(offenders).toEqual([]);
  });

  it('no source file hardcodes the brand-red hex via text-[#ec4755]', () => {
    const offenders = findMatches('text-[#ec4755]', isTestFile);
    expect(offenders).toEqual([]);
  });
});
