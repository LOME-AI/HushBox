import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the card is asserted against its source.
const source = readFileSync(path.resolve(__dirname, './FeatureCard.astro'), 'utf8');

function classOf(marker: string): string[] {
  const tag = new RegExp(String.raw`<[a-z]+\b[^>]*${marker}[^>]*>`).exec(source)?.[0] ?? '';
  return (/class=\{?[`"]([^`"]*)[`"]/.exec(tag)?.[1] ?? '').split(/\s+/);
}

describe('FeatureCard', () => {
  it('sets two cards per row on phones', () => {
    expect(source).toContain('w-[calc((100%_-_0.75rem)/2)]');
  });

  it('sets three shipped cards per row from 768', () => {
    expect(source).toContain("'md:w-[calc((100%_-_1.5rem)/3)]'");
  });

  it('sets four coming-soon cards per row from 768', () => {
    expect(source).toContain("'md:w-[calc((100%_-_2.25rem)/4)]'");
  });

  it('steps at 768 and at no other width', () => {
    expect(source).not.toMatch(/\b(?:sm|lg|xl|2xl):/);
  });

  it('lets a card shrink below its content', () => {
    expect(classOf('data-feature-card')).toContain('min-w-0');
  });

  it('breaks a name wider than its card anywhere rather than overflowing', () => {
    expect(source).toMatch(/<span class="min-w-0 wrap-anywhere">\{featureName\}<\/span>/);
  });

  it('wraps the name and description inside the card', () => {
    expect(source).toMatch(
      /<div class="min-w-0 wrap-break-word">\s*<p class="flex items-center gap-2/
    );
  });

  it('keeps the icon apart from the name', () => {
    expect(source).toMatch(/<p class="flex items-center gap-2 text-sm font-medium">/);
  });

  it('takes no width from its caller', () => {
    expect(source).not.toMatch(/class\?: string/);
  });
});
