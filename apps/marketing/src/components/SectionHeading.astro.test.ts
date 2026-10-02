import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the headline is asserted against
// its source (mirrors ThemeScript.astro.test.ts).
const SECTION_HEADING = path.resolve(__dirname, './SectionHeading.astro');
const source = existsSync(SECTION_HEADING) ? readFileSync(SECTION_HEADING, 'utf8') : '';
const appDemoSource = readFileSync(path.resolve(__dirname, './AppDemo.astro'), 'utf8');

function wrapperClasses(): string[] {
  return (/<div class="([^"]*)">\s*<Heading /.exec(source)?.[1] ?? '').split(/\s+/);
}

describe('SectionHeading', () => {
  it('takes an optional level of 2 or 3 and an optional id', () => {
    expect(source).toMatch(/interface Props \{\s*level\?: 2 \| 3;\s*id\?: string;\s*\}/);
  });

  it('defaults to level 2', () => {
    expect(source).toMatch(/const \{ level = 2, id \} = Astro\.props;/);
  });

  it('renders its slot as a Heading in the site section role at the level given', () => {
    expect(source).toContain("import { Heading } from '@hushbox/ui/type'");
    expect(source).toMatch(
      /<Heading level=\{level\} variant="site-section"[^>]*>\s*<slot \/>\s*<\/Heading>/
    );
  });

  it('passes the id to the Heading', () => {
    expect(source).toMatch(/<Heading [^>]*\{\.\.\.\(?id === undefined \? \{\} : \{ id \}\)?\}/);
  });

  it('centres the headline', () => {
    expect(wrapperClasses()).toContain('text-center');
  });

  it('breaks a headline wider than its box inside the column', () => {
    expect(wrapperClasses()).toEqual(expect.arrayContaining(['min-w-0', 'wrap-break-word']));
  });

  it('adds nothing else to the headline column', () => {
    expect(wrapperClasses()).toEqual(['min-w-0', 'text-center', 'wrap-break-word']);
  });

  it('writes no raw heading element', () => {
    expect(source).not.toMatch(/<h[1-6]\b/);
  });
});

describe('the demo headline', () => {
  it('renders through SectionHeading', () => {
    expect(appDemoSource).toContain("import SectionHeading from './SectionHeading.astro'");
    expect(appDemoSource).toContain('<SectionHeading>See it in action</SectionHeading>');
  });

  it('writes no raw heading element', () => {
    expect(appDemoSource).not.toMatch(/<h[1-6]\b/);
  });
});
