import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the card and the index that places
// it are asserted against their source (mirrors SectionHeading.astro.test.ts).
const CARD = path.resolve(__dirname, './BlogPostCard.astro');
const INDEX = path.resolve(__dirname, '../../pages/blog/index.astro');
const source = existsSync(CARD) ? readFileSync(CARD, 'utf8') : '';
const indexSource = readFileSync(INDEX, 'utf8');

/** The class string the expression `lead ? '<lead>' : '<card>'` picks for the named element. */
function leadAndCardClasses(marker: string): { lead: string[]; card: string[] } {
  const match = new RegExp(String.raw`${marker}[\s\S]*?lead\s*\?\s*'([^']*)'\s*:\s*'([^']*)'`).exec(
    source
  );
  return {
    lead: (match?.[1] ?? '').split(/\s+/),
    card: (match?.[2] ?? '').split(/\s+/),
  };
}

function linkClasses(): string[] {
  return (/<a[\s\S]*?class:list=\{\[\s*'([^']*)'/.exec(source)?.[1] ?? '').split(/\s+/);
}

describe('BlogPostCard', () => {
  it('takes the post and an optional lead flag', () => {
    expect(source).toMatch(/interface Props \{\s*post: BlogPost;\s*lead\?: boolean;\s*\}/);
    expect(source).toMatch(/const \{ post, lead = false \} = Astro\.props;/);
  });

  it('keeps the card a link carrying the post tags for the topic filter', () => {
    expect(source).toMatch(
      /<a\s+href=\{`\/blog\/\$\{slug\}`\}\s+data-blog-card\s+data-tags=\{tags\.join\(','\)\}/
    );
  });

  it('keeps the card frame the other cards draw', () => {
    expect(linkClasses()).toEqual(
      expect.arrayContaining([
        'border-border',
        'bg-card',
        'hover:border-brand-red',
        'group',
        'flex',
        'flex-col',
        'rounded-xl',
        'border-2',
        'transition-colors',
      ])
    );
  });

  it('lets a card narrower than its longest word shrink to its column', () => {
    expect(linkClasses()).toContain('min-w-0');
  });

  it('breaks a title word wider than the card inside the card', () => {
    expect(source).toMatch(/<span class="[^"]*\bwrap-break-word\b[^"]*">\s*\{title\}\s*<\/span>/);
    expect(source).toMatch(/<h3\s+class="[^"]*\bwrap-break-word\b[^"]*"\s*>/);
  });

  it('spans both columns from 768 and pads the lead by the page width', () => {
    const { lead, card } = leadAndCardClasses('class:list');
    expect(lead).toHaveLength(2);
    expect(lead).toEqual(
      expect.arrayContaining(['md:col-span-2', 'p-[clamp(1.5rem,1rem+1.6vw,2.25rem)]'])
    );
    expect(card).toEqual(['p-6']);
  });

  it('marks only the lead with a red Latest badge above its title', () => {
    expect(source).toContain("import { Badge } from '@hushbox/ui/marks'");
    expect(source).toMatch(
      /\{\s*lead && \(\s*<span class="mb-3 flex self-start">\s*<Badge tone="brand">Latest<\/Badge>\s*<\/span>\s*\)\s*\}/
    );
  });

  it('sets the lead title in the site lead role as a level-three heading', () => {
    expect(source).toContain("import { Heading } from '@hushbox/ui/type'");
    expect(source).toMatch(/<Heading level=\{3\} variant="site-lead">/);
  });

  it('keeps the lead title turning to the hover red with the card', () => {
    expect(source).toMatch(
      /<Heading level=\{3\} variant="site-lead">\s*<span class="[^"]*\bgroup-hover:text-brand-red-hover\b[^"]*">\s*\{title\}\s*<\/span>\s*<\/Heading>/
    );
  });

  it('keeps every other title as today', () => {
    const title = (/<h3\s+class="([^"]*)"\s*>\s*\{title\}\s*<\/h3>/.exec(source)?.[1] ?? '').split(
      /\s+/
    );
    expect(title).toEqual(
      expect.arrayContaining([
        'text-brand-red',
        'group-hover:text-brand-red-hover',
        'text-lg',
        'font-semibold',
        'transition-colors',
      ])
    );
  });

  it('gives the lead summary three lines at most 44rem wide in larger type', () => {
    const { lead, card } = leadAndCardClasses('<p');
    expect(lead).toHaveLength(4);
    expect(lead).toEqual(
      expect.arrayContaining([
        'line-clamp-3',
        'max-w-176',
        'text-[length:clamp(0.9375rem,0.9rem_+_0.2vw,1.0625rem)]',
        'leading-[1.6]',
      ])
    );
    expect(card).toEqual(['line-clamp-2', 'text-sm']);
  });

  it('wraps the meta line between its parts when the card is too narrow for one line', () => {
    const meta = (/<div class="([^"]*)">\s*<span>\{author\}<\/span>/.exec(source)?.[1] ?? '').split(
      /\s+/
    );
    expect(meta).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'gap-x-2', 'gap-y-1']));
    expect(meta).not.toContain('gap-2');
  });

  it('draws each post tag in ink on the secondary fill', () => {
    expect(source).toMatch(
      /\{tags\.map\(\(tag\) => \(\s*<Badge tone="secondary">\{tag\}<\/Badge>\s*\)\)\}/
    );
  });

  it('takes its badges from the marks door alone', () => {
    expect(source).not.toMatch(/from '@hushbox\/ui';/);
    expect(source).not.toContain('variant="secondary"');
  });
});

describe('the blog index', () => {
  it('leads with the newest post', () => {
    expect(indexSource).toMatch(
      /allPosts\.map\(\(post, index\) => \(\s*<BlogPostCard post=\{post\} lead=\{index === 0\} \/>\s*\)\)/
    );
  });

  it('sets the posts a rem under the search and topics', () => {
    expect(indexSource).not.toContain('space-y-8');
    expect(indexSource).toMatch(
      /<BlogSearch [^>]*client:load \/>\s*\{\s*allPosts\.length > 0 && \(\s*<div class="grid gap-6 pt-4 md:grid-cols-2">/
    );
  });
});
