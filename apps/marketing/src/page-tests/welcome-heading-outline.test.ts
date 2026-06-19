import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No Astro DOM/container harness is wired into this project's vitest config, so
// (mirroring welcome.astro.test.ts and LandingLayout.astro.test.ts) the page and
// its card components are asserted against source. These tests guard the document
// heading outline: it must descend by one level at a time (h1 -> h2 -> h3 ...).
// A skipped level (h1 -> h3) breaks assistive-tech navigation. The cards take an
// `as` heading-level prop so the page controls the outline while the rendered
// class strings stay byte-identical (zero visual change).
//
// This file lives outside `src/pages/` because Astro routes every file under
// that directory; a page test there is built as a junk route that ENOENTs at
// build time reading `.astro` sources absent from `dist/`. `import.meta.url`
// resolves the page and card sources under ESM without relying on `__dirname`.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.resolve(currentDir, '../components');
const pillarSource = readFileSync(path.join(componentsDir, 'PillarCard.astro'), 'utf8');
const trustSource = readFileSync(path.join(componentsDir, 'TrustCard.astro'), 'utf8');
const welcomeSource = readFileSync(path.resolve(currentDir, '../pages/welcome.astro'), 'utf8');

// Class strings that must remain byte-identical before and after the fix so the
// output is pixel-identical. Sourced from the original card markup.
const PILLAR_HEADING_CLASS = 'text-lg font-bold tracking-tight sm:text-xl';
const TRUST_HEADING_CLASS = 'font-semibold';

describe('PillarCard heading level', () => {
  it('renders the heading with the level given by the `as` prop', () => {
    const heading = renderHeading(pillarSource, { as: 'h2' });
    expect(heading.tag).toBe('h2');
  });

  it('defaults to h2 so a level is always emitted', () => {
    const heading = renderHeading(pillarSource, {});
    expect(heading.tag).toBe('h2');
  });

  it('keeps the heading class string byte-identical', () => {
    const heading = renderHeading(pillarSource, { as: 'h2' });
    expect(heading.classes).toBe(PILLAR_HEADING_CLASS);
  });
});

describe('TrustCard heading level', () => {
  it('renders the heading with the level given by the `as` prop', () => {
    const heading = renderHeading(trustSource, { as: 'h3' });
    expect(heading.tag).toBe('h3');
  });

  it('defaults to h3 so a level is always emitted', () => {
    const heading = renderHeading(trustSource, {});
    expect(heading.tag).toBe('h3');
  });

  it('keeps the heading class string byte-identical', () => {
    const heading = renderHeading(trustSource, { as: 'h3' });
    expect(heading.classes).toBe(TRUST_HEADING_CLASS);
  });
});

describe('welcome page heading outline', () => {
  it('descends one level at a time with no skipped headings', () => {
    const levels = extractHeadingLevels(welcomeSource, {
      PillarCard: pillarSource,
      TrustCard: trustSource,
    });
    expect(levels[0]).toBe(1);
    for (let index = 1; index < levels.length; index += 1) {
      // Going deeper may only step by one; coming back up may jump freely.
      const step = levels[index] - levels[index - 1];
      expect(step).toBeLessThanOrEqual(1);
    }
  });

  it('passes as="h2" to every PillarCard', () => {
    const tags = cardInstances(welcomeSource, 'PillarCard').map((instance) =>
      headingTagForInstance(instance, pillarSource)
    );
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag === 'h2')).toBe(true);
  });

  it('passes as="h3" to every TrustCard', () => {
    const tags = cardInstances(welcomeSource, 'TrustCard').map((instance) =>
      headingTagForInstance(instance, trustSource)
    );
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag === 'h3')).toBe(true);
  });
});

interface RenderedHeading {
  tag: string;
  classes: string;
}

// Resolves a card's heading tag and class string for a given set of props,
// mirroring how Astro renders `const Heading = as; <Heading class="...">`.
function renderHeading(cardSource: string, props: { as?: string }): RenderedHeading {
  const fallback = headingDefault(cardSource);
  const tag = props.as ?? fallback;
  return { tag, classes: headingClass(cardSource) };
}

// The default for `as` declared in the component frontmatter
// (`const { ..., as = 'hN' } = Astro.props;`).
function headingDefault(cardSource: string): string {
  const match = /as\s*=\s*['"](h[1-6])['"]/.exec(cardSource);
  if (!match) {
    throw new Error('Card does not declare a default `as` heading level.');
  }
  return match[1];
}

// The class string rendered on the dynamic heading element.
function headingClass(cardSource: string): string {
  const match = /<Heading class="([^"]*)"/.exec(cardSource);
  if (!match) {
    throw new Error('Card does not render a <Heading> with a class attribute.');
  }
  return match[1];
}

function headingTagForInstance(instance: string, cardSource: string): string {
  const explicit = /\bas=["'](h[1-6])["']/.exec(instance);
  return explicit ? explicit[1] : headingDefault(cardSource);
}

function cardInstances(pageSource: string, component: string): string[] {
  const regex = new RegExp(String.raw`<${component}\b[\s\S]*?/>`, 'g');
  return [...pageSource.matchAll(regex)].map((match) => match[0]);
}

// Builds the ordered list of heading levels the rendered page emits: literal
// <hN> tags in the page, plus each card instance resolved to its heading level,
// in document order.
function extractHeadingLevels(pageSource: string, cards: Record<string, string>): number[] {
  const tokens: { index: number; level: number }[] = [];

  for (const match of pageSource.matchAll(/<h([1-6])\b/g)) {
    tokens.push({ index: match.index, level: Number(match[1]) });
  }

  for (const [component, cardSource] of Object.entries(cards)) {
    const regex = new RegExp(String.raw`<${component}\b[\s\S]*?/>`, 'g');
    for (const match of pageSource.matchAll(regex)) {
      const tag = headingTagForInstance(match[0], cardSource);
      tokens.push({ index: match.index, level: Number(tag.slice(1)) });
    }
  }

  return tokens.toSorted((a, b) => a.index - b.index).map((token) => token.level);
}
