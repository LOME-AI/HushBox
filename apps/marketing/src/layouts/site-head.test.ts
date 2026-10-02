import { describe, it, expect } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { buildBlogArticleJsonLd } from '../lib/blog-structured-data';
import { siteHead } from './site-head';
import type { SiteArticle } from './site-head';

const site = new URL('https://example.test');

const article: SiteArticle = {
  author: 'HushBox Engineering',
  date: new Date(TEST_DAY_START),
  tags: ['privacy'],
};

describe('siteHead on a site page', () => {
  it('suffixes the document title with the site name', () => {
    expect(siteHead({ title: 'Roadmap' }, site, '/roadmap').documentTitle).toBe(
      'Roadmap | HushBox'
    );
  });

  it('gives the twitter card the suffixed title', () => {
    expect(siteHead({ title: 'Roadmap' }, site, '/roadmap').twitterTitle).toBe('Roadmap | HushBox');
  });

  it('is typed as a website', () => {
    expect(siteHead({ title: 'Roadmap' }, site, '/roadmap').ogType).toBe('website');
  });

  it('links no feed', () => {
    expect(siteHead({ title: 'Roadmap' }, site, '/roadmap').rss).toBe(false);
  });

  it('publishes no structured data', () => {
    expect(siteHead({ title: 'Roadmap' }, site, '/roadmap').jsonLd).toBeUndefined();
  });
});

describe('siteHead absolute URLs', () => {
  it('builds the canonical URL from the site and the path', () => {
    expect(siteHead({ title: 'Roadmap' }, site, '/roadmap').canonicalUrl).toBe(
      'https://example.test/roadmap'
    );
  });

  it('falls back to the absolute default share image', () => {
    expect(siteHead({ title: 'Roadmap' }, site, '/roadmap').ogImage).toBe(
      'https://example.test/og-default.png'
    );
  });

  it('uses the share image a page passes', () => {
    const head = siteHead({ title: 'Post', image: '/cover.png' }, site, '/blog/post');
    expect(head.ogImage).toBe('/cover.png');
  });
});

describe('siteHead on a blog page', () => {
  it('suffixes the document title with the blog name', () => {
    expect(siteHead({ title: 'Blog', blog: true }, site, '/blog').documentTitle).toBe(
      'Blog | HushBox Blog'
    );
  });

  it('gives the twitter card the bare title', () => {
    expect(siteHead({ title: 'Blog', blog: true }, site, '/blog').twitterTitle).toBe('Blog');
  });

  it('links the feed', () => {
    expect(siteHead({ title: 'Blog', blog: true }, site, '/blog').rss).toBe(true);
  });

  it('stays typed as a website without an article', () => {
    expect(siteHead({ title: 'Blog', blog: true }, site, '/blog').ogType).toBe('website');
  });

  it('publishes no structured data without an article', () => {
    expect(siteHead({ title: 'Blog', blog: true }, site, '/blog').jsonLd).toBeUndefined();
  });
});

describe('siteHead on a blog article', () => {
  const props = { title: 'Post', description: 'About the post.', article };

  it('takes the blog head without the blog flag', () => {
    const head = siteHead(props, site, '/blog/post');
    expect(head.documentTitle).toBe('Post | HushBox Blog');
  });

  it('links the feed', () => {
    expect(siteHead(props, site, '/blog/post').rss).toBe(true);
  });

  it('is typed as an article', () => {
    expect(siteHead(props, site, '/blog/post').ogType).toBe('article');
  });

  it('publishes the article structured data', () => {
    expect(siteHead(props, site, '/blog/post').jsonLd).toBe(
      buildBlogArticleJsonLd({
        title: 'Post',
        description: 'About the post.',
        date: article.date,
        author: article.author,
        canonicalUrl: 'https://example.test/blog/post',
        siteOrigin: 'https://example.test',
      })
    );
  });

  it('refuses an article without a description', () => {
    expect(() => siteHead({ title: 'Post', article }, site, '/blog/post')).toThrow(/description/);
  });
});
