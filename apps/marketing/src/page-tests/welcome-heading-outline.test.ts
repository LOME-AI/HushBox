import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No Astro DOM/container harness is wired into this project's vitest config, so
// (mirroring welcome.astro.test.ts and SiteLayout.astro.test.ts) the page and
// its word blocks are asserted against source. These tests guard the document
// heading outline: it must descend by one level at a time (h1 -> h2 -> h3 ...).
// A skipped level (h1 -> h3) breaks assistive-tech navigation. A word block takes
// its heading level from the caller, so the page controls the outline.
//
// This file lives outside `apps/marketing/src/pages/` because Astro routes every file under
// that directory; a page test there is built as a junk route that ENOENTs at
// build time reading `.astro` sources absent from `dist/`. `import.meta.url`
// resolves the page and block sources under ESM without relying on `__dirname`.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.resolve(currentDir, '../components');
const wordBlockSource = readFileSync(path.join(componentsDir, 'WordBlock.astro'), 'utf8');
// Components the outline does not inline: the word block and the section headline are read
// as heading tokens, PageHero's title branch is unused when the page slots its own title, and
// the layout's chrome sits outside the page content this outline covers.
const NOT_INLINED = new Set(['WordBlock', 'SectionHeading', 'PageHero', 'SiteLayout']);

const welcomeSource = inlineComponents(path.resolve(currentDir, '../pages/welcome.astro'));

describe('WordBlock heading level', () => {
  it('renders its heading at the level the caller gives', () => {
    expect(wordBlockSource).toMatch(/<Heading level=\{headingLevel\}/);
  });

  it('writes no heading of its own', () => {
    expect(wordBlockSource).not.toMatch(/<h[1-6]\b|<Heading level=\{[1-6]\}/);
  });
});

describe('welcome page heading outline', () => {
  it('descends one level at a time with no skipped headings', () => {
    const levels = extractHeadingLevels(welcomeSource);
    expect(levels[0]).toBe(1);
    for (let index = 1; index < levels.length; index += 1) {
      // Going deeper may only step by one; coming back up may jump freely.
      const step = levels[index]! - levels[index - 1]!;
      expect(step).toBeLessThanOrEqual(1);
    }
  });

  it('sets every value block heading at level two', () => {
    const levels = blockInstances(welcomeSource, 'value').map((instance) =>
      levelOfInstance(instance)
    );
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((level) => level === 2)).toBe(true);
  });

  it('sets every trust block heading at level three', () => {
    const levels = blockInstances(welcomeSource, 'trust').map((instance) =>
      levelOfInstance(instance)
    );
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((level) => level === 3)).toBe(true);
  });
});

function levelOfInstance(instance: string): number {
  const level = /\bheadingLevel=\{([23])\}/.exec(instance)?.[1];
  if (level === undefined) {
    throw new Error('A word block is placed without a heading level.');
  }
  return Number(level);
}

function blockInstances(pageSource: string, tone: 'value' | 'trust'): string[] {
  return [...pageSource.matchAll(/<WordBlock\b[\s\S]*?\/>/g)]
    .map((match) => match[0])
    .filter((instance) => instance.includes(`tone="${tone}"`));
}

// Builds the ordered list of heading levels the rendered page emits: literal
// <hN> tags in the page, plus each word block resolved to its heading level,
// in document order.
function extractHeadingLevels(pageSource: string): number[] {
  const tokens: { index: number; level: number }[] = [];

  for (const match of pageSource.matchAll(/<h([1-6])\b|<Heading level=\{([1-6])\}/g)) {
    tokens.push({ index: match.index, level: Number(match[1] ?? match[2]) });
  }

  for (const match of pageSource.matchAll(/<SectionHeading\b([^>]*)>/g)) {
    const level = /\blevel=\{([23])\}/.exec(match[1] ?? '')?.[1] ?? '2';
    tokens.push({ index: match.index, level: Number(level) });
  }

  for (const match of pageSource.matchAll(/<WordBlock\b[\s\S]*?\/>/g)) {
    tokens.push({ index: match.index, level: levelOfInstance(match[0]) });
  }

  return tokens.toSorted((a, b) => a.index - b.index).map((token) => token.level);
}

// The page as the reader meets it: each `.astro` component the page places, and each one
// those place, replaced by its own markup at the point it is placed, so headings keep
// document order across the section files.
function inlineComponents(file: string): string {
  const source = readFileSync(file, 'utf8');
  const markup = source.replace(/^---[\s\S]*?---/, '');
  const imports = [...source.matchAll(/^import (\w+) from '([^']+\.astro)';$/gm)];
  let result = markup;
  for (const [, name, specifier] of imports) {
    if (name === undefined || specifier === undefined || NOT_INLINED.has(name)) continue;
    const child = inlineComponents(path.resolve(path.dirname(file), specifier));
    result = result.replaceAll(new RegExp(String.raw`<${name}\b[^>]*>`, 'g'), child);
  }
  return result;
}
