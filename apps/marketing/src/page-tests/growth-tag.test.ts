import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { NON_ROUTE_MARKETING_PAGES } from '@hushbox/shared';

// The anonymous visitor count is only as trustworthy as the number of beacons a
// page fires: a second copy of the script doubles every pageview, every scroll
// threshold and every click on that page, and nothing downstream can tell the
// double from real traffic because both arrive as ordinary bodies from the same
// visitor. Two beacons is therefore silent corruption of a number kept forever,
// which is why it is pinned here rather than left to review.
//
// "Exactly one per built page" is established as a chain over the sources
// rather than over `dist/`: each layout renders the script exactly once, each
// page wraps its content in exactly one of those layouts, and no page renders
// the script itself. The built pages are the product of those three facts. The
// built output is not read because `dist/` is git-ignored and the `test` turbo
// task does not depend on `build`, so a guard that read it would pass or fail
// on whether someone happened to have built the site.
//
// Lives outside `apps/marketing/src/pages/` for the same reason as the other page tests: Astro
// routes every file under that directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const layoutsDir = path.resolve(currentDir, '../layouts');
const pagesDir = path.resolve(currentDir, '../pages');

/** The layouts that wrap every counted marketing page. */
const LAYOUTS = ['SiteLayout.astro'] as const;

/** The site chrome the layout owns, as elements a page could render itself. */
const LAYOUT_CHROME = ['SiteHeader', 'SiteFooter'] as const;

/** The constant holding the beacon's inline script body, by the name the layouts render. */
const BEACON_CONSTANT = 'GROWTH_INIT_SCRIPT';

/** An inline `<script>` element whose body is the beacon constant. */
const beaconScript = new RegExp(String.raw`<script\b[^>]*\bset:html=\{${BEACON_CONSTANT}\}`, 'g');

/** A layout used as an element. `</SiteLayout>` cannot match: the closing form has no `<Site`. */
const layoutNames = LAYOUTS.map((layout) => layout.replace('.astro', '')).join('|');
const layoutOpening = new RegExp(String.raw`<(${layoutNames})\b`, 'g');

/** Astro pages that must carry the beacon, i.e. every page but the exempt error pages. */
function countedPages(): string[] {
  return readdirSync(pagesDir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.astro'))
    .filter((entry) => {
      const base = entry.split(/[\\/]/).pop() ?? entry;
      return !(NON_ROUTE_MARKETING_PAGES as readonly string[]).includes(base);
    })
    .map((entry) => entry.split(path.sep).join('/'))
    .toSorted((left, right) => left.localeCompare(right));
}

function matchCount(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

describe('the marketing beacon script', () => {
  for (const layout of LAYOUTS) {
    it(`is rendered exactly once by ${layout}`, () => {
      const source = readFileSync(path.join(layoutsDir, layout), 'utf8');
      expect(matchCount(source, beaconScript)).toBe(1);
    });
  }
});

describe('every counted marketing page', () => {
  for (const page of countedPages()) {
    it(`wraps ${page} in exactly one layout`, () => {
      const source = readFileSync(path.join(pagesDir, page), 'utf8');
      expect(matchCount(source, layoutOpening)).toBe(1);
    });

    it(`leaves the beacon script to the layout on ${page}`, () => {
      const source = readFileSync(path.join(pagesDir, page), 'utf8');
      expect(source).not.toContain(BEACON_CONSTANT);
    });

    for (const chrome of LAYOUT_CHROME) {
      it(`leaves ${chrome} to the layout on ${page}`, () => {
        const source = readFileSync(path.join(pagesDir, page), 'utf8');
        expect(source).not.toMatch(new RegExp(String.raw`<${chrome}\b`));
      });
    }
  }
});
