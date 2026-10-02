import { describe, it, expect } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { buildBlogArticleJsonLd } from './blog-structured-data';

const post = {
  title: 'A quieter release',
  description: 'What changed this cycle.',
  date: new Date(TEST_DAY_START),
  author: 'HushBox Engineering',
  canonicalUrl: 'https://example.test/blog/a-quieter-release',
  siteOrigin: 'https://example.test',
};

describe('buildBlogArticleJsonLd', () => {
  it('serializes the post metadata as parseable JSON-LD', () => {
    expect(JSON.parse(buildBlogArticleJsonLd(post))).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'A quieter release',
      description: 'What changed this cycle.',
      datePublished: new Date(TEST_DAY_START).toISOString(),
      author: { '@type': 'Person', name: 'HushBox Engineering' },
      publisher: {
        '@type': 'Organization',
        name: 'HushBox',
        url: 'https://example.test',
      },
      mainEntityOfPage: 'https://example.test/blog/a-quieter-release',
    });
  });

  it('attributes a post that declares no author to the team', () => {
    const json = JSON.parse(buildBlogArticleJsonLd({ ...post, author: undefined })) as {
      author: { name: string };
    };
    expect(json.author.name).toBe('HushBox Team');
  });

  it('escapes `<` so a title cannot terminate the structured-data block', () => {
    const title = 'Reading </script><img src=x> tags';
    expect(buildBlogArticleJsonLd({ ...post, title })).not.toContain('</script>');
  });

  it('preserves a title that carries a closing script tag as literal text', () => {
    const title = 'Reading </script><img src=x> tags';
    const json = JSON.parse(buildBlogArticleJsonLd({ ...post, title })) as { headline: string };
    expect(json.headline).toBe(title);
  });
});
