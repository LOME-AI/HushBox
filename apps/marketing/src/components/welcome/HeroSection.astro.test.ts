import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the hero is asserted against its source.
const FILE = path.resolve(__dirname, './HeroSection.astro');
const source = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

function classesOf(marker: RegExp): string[] {
  const tag = marker.exec(source)?.[0] ?? '';
  return (/class=\{?[`"]([^`"]*)[`"]/.exec(tag)?.[1] ?? '').split(/\s+/);
}

describe('HeroSection', () => {
  it('sets the title as the level-one heading in the site hero role', () => {
    expect(source).toContain("import { Heading } from '@hushbox/ui/type'");
    expect(source).toContain('<Heading level={1} variant="site-hero">');
  });

  it('writes no raw heading element', () => {
    expect(source).not.toMatch(/<h[1-6]\b/);
  });

  it('takes the tagline from the shared sentences', () => {
    expect(source).toContain('PRODUCT_TAGLINE_SENTENCES.map(');
  });

  it('types none of the tagline itself', () => {
    expect(source).not.toMatch(/One interface|Every feature/);
  });

  it('breaks the title after every sentence but the last', () => {
    expect(source).toMatch(/\{sentence\}\s*<br \/>/);
  });

  it('sets the last sentence in Signal Red', () => {
    expect(source).toMatch(
      /index === lastIndex \?\s*\(?\s*<span class="text-primary">\{sentence\}<\/span>/
    );
  });

  it('stacks the calls to action on phones and sets them side by side from 768', () => {
    const row = classesOf(/<div\b[^>]*data-hero-cta[^>]*>/);
    expect(row).toEqual(
      expect.arrayContaining(['flex', 'flex-col', 'md:flex-row', 'md:justify-center'])
    );
  });

  it('sizes the sub-line fluidly', () => {
    expect(source).toContain('text-[length:clamp(1.125rem,1.05rem_+_0.3vw,1.25rem)]');
  });

  it('wraps a call to action inside the screen when its label outgrows it', () => {
    expect(source).toMatch(/const CTA_FIT = '[^']*\bmax-w-full\b[^']*\bwhitespace-normal\b/);
  });

  it('steps at 768 and at no other width', () => {
    expect(source).not.toMatch(/\b(?:sm|lg|xl|2xl):/);
  });

  it('keeps the calls to action', () => {
    expect(source).toContain('Try HushBox Free');
    expect(source).toContain('See How It Works &rarr;');
  });

  it('keeps the note under the calls to action', () => {
    expect(source).toContain('No account required to try.');
  });

  it('draws the scroll arrow as the scroll chevron at the display size', () => {
    expect(source).toContain("import { Icon, ScrollChevron } from '@hushbox/ui/icons'");
    expect(source).toContain(
      '<Icon icon={ScrollChevron} size="display" className="text-primary" />'
    );
  });

  it('draws no raw svg', () => {
    expect(source).not.toMatch(/<svg\b/);
  });

  it('keeps the scroll arrow to the demo', () => {
    expect(source).toMatch(/id="scroll-arrow"\s+href="#demo"/);
  });
});
