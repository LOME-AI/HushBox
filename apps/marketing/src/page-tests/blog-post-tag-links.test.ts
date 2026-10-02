import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No DOM harness renders `.astro` files in this app, so the page is asserted
// against its source (mirrors blog-post-hydration.test.ts). This file lives
// outside `apps/marketing/src/pages/` because Astro routes every file under that directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(currentDir, '../pages/blog/[slug].astro'), 'utf8');

describe('[slug].astro tag links', () => {
  it('builds tag hrefs through the shared tagUrl builder', () => {
    expect(source).toContain('href={tagUrl(tag)}');
  });

  it('draws each tag as a topic tag linking to its topic', () => {
    expect(source).toMatch(
      /\{post\.data\.tags\.map\(\(tag\) => \(\s*<TopicTag href=\{tagUrl\(tag\)\}>\{tag\}<\/TopicTag>\s*\)\)\}/
    );
  });

  it('takes the topic tag from the blog index filter', () => {
    expect(source).toContain("import { TopicTag } from '../../components/blog/TopicTag';");
  });

  it('draws no badge for a tag', () => {
    expect(source).not.toMatch(/<Badge\b/);
  });

  it('interpolates no tag into a query string of its own', () => {
    // The unencoded form truncates a tag at its first `#` or `&`; the encoding
    // tagUrl applies instead is pinned in blog.test.ts.
    expect(source).not.toMatch(/\?tag=\$\{/);
  });
});
