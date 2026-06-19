import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// No DOM harness renders `.astro` files in this app, so social meta is asserted
// against the layout source (mirrors welcome.astro.test.ts). The og:image and
// canonical URLs must resolve to absolute URLs at build time via Astro.site,
// otherwise crawlers fetch a relative path and the card breaks.
const source = readFileSync(path.resolve(__dirname, './LandingLayout.astro'), 'utf8');

describe('LandingLayout social meta', () => {
  it('builds an absolute og:image URL from Astro.site', () => {
    expect(source).toContain("new URL('og-default.png', Astro.site)");
    expect(source).toContain('property="og:image"');
  });

  it('emits an absolute canonical link', () => {
    expect(source).toContain('rel="canonical"');
    expect(source).toContain('new URL(Astro.url.pathname, Astro.site)');
  });

  it('emits og:url and og:site_name', () => {
    expect(source).toContain('property="og:url"');
    expect(source).toContain('property="og:site_name"');
    expect(source).toContain('content="HushBox"');
  });

  it('emits twitter summary_large_image card and image', () => {
    expect(source).toContain('name="twitter:card"');
    expect(source).toContain('content="summary_large_image"');
    expect(source).toContain('name="twitter:image"');
  });

  it('allows per-page override of the og image via props', () => {
    expect(source).toMatch(/image\??\s*:\s*string/);
    expect(source).toContain('image ??');
  });
});
