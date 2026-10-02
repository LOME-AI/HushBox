import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No DOM harness renders `.astro` files in this app, so the post page's layout is asserted
// against its source (mirrors blog-post-hydration.test.ts). This file lives outside
// `apps/marketing/src/pages/` because Astro routes every file under that directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(currentDir, '../pages/blog/[slug].astro'), 'utf8');
const stylesheet = readFileSync(path.resolve(currentDir, '../styles/global.css'), 'utf8');

/** The `@apply` list of the prose rule whose selector names `element`. */
function proseRule(element: string): string[] {
  const escaped = element.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const match = new RegExp(
    String.raw`\.prose-blog :where\(${escaped}\):not\(:where\(\[class~='not-prose'\] \*\)\) \{\s*@apply ([^;]*);`
  ).exec(stylesheet);
  return (match?.[1] ?? '').split(/\s+/);
}

/** The class list of the first element opened by `opening` (a tag with its leading attributes). */
function classesOf(opening: RegExp): string[] {
  const match = new RegExp(String.raw`${opening.source}[^>]*?class="([^"]*)"`).exec(source);
  return (match?.[1] ?? '').split(/\s+/);
}

describe('[slug].astro layout', () => {
  it('sets no step at the 640 band', () => {
    expect(source).not.toMatch(/\bsm:/);
  });

  it('steps at 1024 only for the "On this page" rail, its grid and the collapsed box', () => {
    const lgLines = source.split('\n').filter((line) => /\blg:/.test(line));
    expect(lgLines.map((line) => line.trim())).toEqual([
      "const CONTENT_GRID = 'lg:grid lg:grid-cols-[1fr_220px] lg:gap-10';",
      '<details class="border-border mt-4 rounded-lg border p-4 lg:hidden">',
      '<aside class="hidden lg:block">',
    ]);
  });

  it('draws the post title through the post-title type role', () => {
    expect(source).toMatch(
      /<Heading level=\{1\} variant="site-post-title">\s*\{post\.data\.title\}\s*<\/Heading>/
    );
  });

  it('fills each title line before it wraps instead of balancing the lines', () => {
    expect(classesOf(/<header/)).toContain('[&>h1]:text-wrap');
  });

  it('breaks a title word wider than the column inside the column', () => {
    expect(classesOf(/<header/)).toContain('[&>h1]:wrap-break-word');
  });

  it('breaks a word wider than the column inside the post text', () => {
    expect(classesOf(/<article/)).toContain('wrap-break-word');
  });

  it('lays the disclaimer and Copy link out as a row from 768', () => {
    const endRow = /<div\s+class="([^"]*)"\s*>\s*<BlogDisclaimer/.exec(source)?.[1] ?? '';
    expect(endRow.split(/\s+/)).toEqual(
      expect.arrayContaining([
        'flex',
        'flex-col',
        'md:flex-row',
        'md:items-start',
        'md:justify-between',
      ])
    );
  });

  it('shows "More from the blog" in three columns from 768', () => {
    const grid = /<div class="([^"]*)">\s*\{relatedPosts\.map/.exec(source)?.[1] ?? '';
    expect(grid.split(/\s+/)).toEqual(['grid', 'gap-6', 'md:grid-cols-3']);
  });
});

describe('prose tables', () => {
  it('render through the scrolling table wrapper', () => {
    expect(source).toContain("import ProseTable from '../../components/blog/ProseTable.astro';");
    expect(source).toMatch(/<Content components=\{\{ table: ProseTable \}\} \/>/);
  });

  it('stay a full-width table at every width', () => {
    expect(proseRule('table')).toContain('w-full');
    expect(proseRule('table').filter((token) => token.startsWith('max-md:'))).toEqual([]);
  });

  it('leave the space below a table to its wrapper', () => {
    expect(proseRule('table').filter((token) => /^m[by]?-/.test(token))).toEqual([]);
  });

  it('keep each header cell a readable width below 768', () => {
    expect(proseRule('th')).toContain('max-md:min-w-36');
  });

  it('keep each body cell a readable width below 768', () => {
    expect(proseRule('td')).toContain('max-md:min-w-36');
  });

  it('keep no step at the 640 band', () => {
    for (const element of ['table', 'th', 'td']) {
      expect(proseRule(element).filter((token) => token.startsWith('max-sm:'))).toEqual([]);
    }
  });
});
