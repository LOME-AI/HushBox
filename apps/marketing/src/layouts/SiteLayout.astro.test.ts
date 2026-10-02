import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// No DOM harness renders `.astro` files in this app, so the layout is asserted
// against its source; which head a page gets is decided by `siteHead`, whose
// own tests pin the values. The og:image and canonical URLs must be absolute at
// build time, otherwise crawlers fetch a relative path and the card breaks.
const source = readFileSync(path.resolve(__dirname, './SiteLayout.astro'), 'utf8');

function count(pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function indexOf(pattern: RegExp): number {
  return source.search(pattern);
}

describe('SiteLayout head', () => {
  it('derives the head from the configured site and the page path', () => {
    expect(source).toContain('siteHead(Astro.props, requireSite(Astro.site), Astro.url.pathname)');
  });

  it('emits the absolute og:image', () => {
    expect(source).toMatch(/<meta property="og:image" content=\{head\.ogImage\} \/>/);
  });

  it('emits the absolute canonical link', () => {
    expect(source).toMatch(/<link rel="canonical" href=\{head\.canonicalUrl\} \/>/);
  });

  it('emits og:url and og:site_name', () => {
    expect(source).toContain('<meta property="og:url" content={head.canonicalUrl} />');
    expect(source).toContain('<meta property="og:site_name" content="HushBox" />');
  });

  it('emits the twitter summary_large_image card with its image', () => {
    expect(source).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(source).toContain('<meta name="twitter:image" content={head.ogImage} />');
  });

  it('links the blog feed only when the head carries it', () => {
    expect(source).toMatch(
      /\{\s*head\.rss && \(?\s*<link\s+rel="alternate"\s+type="application\/rss\+xml"/
    );
  });

  it('writes the article meta only for an article', () => {
    expect(source).toMatch(/\{\s*article && <meta property="article:published_time"/);
    expect(source).toMatch(/\{\s*article && <meta property="article:author"/);
    expect(source).toMatch(/\{\s*article\?\.tags\.map\(/);
  });

  it('publishes structured data only when the head carries it', () => {
    expect(source).toMatch(/\{\s*head\.jsonLd && \(?\s*<script\s[^>]*type="application\/ld\+json"/);
  });
});

describe('SiteLayout page frame', () => {
  it('renders the site header once', () => {
    expect(count(/<SiteHeader\b/g)).toBe(1);
  });

  it('renders the site footer once', () => {
    expect(count(/<SiteFooter\b/g)).toBe(1);
  });

  it('renders one main landmark', () => {
    expect(count(/<main\b/g)).toBe(1);
  });

  it('identifies the main landmark as #main', () => {
    expect(source).toMatch(/<main\b[^>]*\sid="main"/);
  });

  it('puts the page content inside the main landmark', () => {
    expect(source).toMatch(/<main\b[^>]*>\s*<slot \/>\s*<\/main>/);
  });

  it('renders the header before the main landmark', () => {
    expect(indexOf(/<SiteHeader\b/)).toBeLessThan(indexOf(/<main\b/));
  });

  it('renders the footer after the main landmark', () => {
    expect(indexOf(/<SiteFooter\b/)).toBeGreaterThan(indexOf(/<\/main>/));
  });
});

describe('SiteLayout forced-reduced-motion stamp', () => {
  // The class has to be in the served bytes. This is a multi-island static
  // site: every island hydrates ahead of the React effect that would otherwise
  // install the class, so a layout that stops stamping it reinstates exactly
  // the first-frame animation the build-time flag exists to suppress, and
  // nothing else in any suite would notice.
  it('stamps the build-time reduced-motion class on the document element', () => {
    expect(source).toMatch(/<html\b[^>]*\sclass=\{forcedReducedMotionClass\}/);
    expect(source).toContain("import { forcedReducedMotionClass } from '../lib/a11y-boot'");
  });
});
