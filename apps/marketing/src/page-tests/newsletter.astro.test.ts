import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWSLETTER_SENT_ATTRIBUTE } from '../components/newsletter/NewsletterSignup';

// No DOM harness renders `.astro` files in this app, so the page is asserted against source.
// Lives outside src/pages/ because Astro routes every file under that directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(currentDir, '../pages/newsletter.astro'), 'utf8');
const markup = source.replace(/^---[\s\S]*?---/, '');

function openingTagBefore(marker: string): string {
  const head = markup.slice(0, markup.indexOf(marker));
  const tags = [...head.matchAll(/<(section|div)\b[^>]*>/g)].map((match) => match[0]);
  return tags.at(-1) ?? '';
}

function classesOf(tag: string): string[] {
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean);
}

describe('newsletter.astro', () => {
  it('titles the hero "Newsletter" through the hero heading', () => {
    expect(markup).toMatch(
      /<PageHero title="Newsletter" messages=\{NEWSLETTER_CIPHER_MESSAGES\} \/>/
    );
  });

  it('writes no raw heading element', () => {
    expect(markup).not.toMatch(/<h[1-6]\b/);
  });

  it('steps no size at the sm or lg breakpoints', () => {
    expect(markup).not.toMatch(/\b(sm|lg):/);
  });

  it('keeps the rule under the hero', () => {
    expect(markup).toContain("<LabeledRule lines={['A few letters a year', 'No tracking']} />");
  });

  it('sets the form in the 36rem column', () => {
    expect(classesOf(openingTagBefore('<LabeledRule'))).toStrictEqual(
      expect.arrayContaining(['mx-auto', 'max-w-xl', 'px-6', 'pb-12'])
    );
  });

  it('imports the value blocks', () => {
    expect(source).toContain("import ValueBlocks from '../components/ValueBlocks.astro';");
  });

  it('renders the value blocks after the form', () => {
    expect(markup.indexOf('<ValueBlocks />')).toBeGreaterThan(
      markup.indexOf('</NewsletterSignup>')
    );
  });

  it('sets the value blocks in the 64rem column', () => {
    expect(classesOf(openingTagBefore('<ValueBlocks />'))).toStrictEqual(
      expect.arrayContaining(['mx-auto', 'max-w-5xl', 'px-6'])
    );
  });

  it('hides the value blocks while the page holds the sent state', () => {
    const section = [...markup.matchAll(/<section\b[^>]*>/g)].at(-1)?.[0] ?? '';
    expect(markup.indexOf(section)).toBeLessThan(markup.indexOf('<ValueBlocks />'));
    expect(classesOf(section)).toContain(
      `group-has-[[${NEWSLETTER_SENT_ATTRIBUTE}]]/newsletter:hidden`
    );
  });

  it('names the group the sent state is looked for in', () => {
    expect(classesOf(openingTagBefore('<PageHero'))).toContain('group/newsletter');
  });

  it('spaces the value blocks from the page end as a section', () => {
    const section = [...markup.matchAll(/<section\b[^>]*>/g)].at(-1)?.[0] ?? '';
    expect(classesOf(section)).toContain('pb-9');
  });
});
