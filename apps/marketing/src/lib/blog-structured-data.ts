import { scriptSafeJson } from '@hushbox/shared/script-safe-json';

/** The post metadata a blog article's structured-data block is built from. */
interface BlogArticleMetadata {
  readonly title: string;
  readonly description: string;
  readonly date: Date;
  readonly author: string | undefined;
  readonly canonicalUrl: string;
  readonly siteOrigin: string;
}

/**
 * Build the schema.org Article JSON-LD a blog page publishes, ready to embed in
 * a `<script type="application/ld+json">` body. Serialized through the shared
 * script-safe encoder because Astro's `set:html` does not escape: a post title
 * carrying a closing script tag would otherwise end the element early.
 */
export function buildBlogArticleJsonLd(post: BlogArticleMetadata): string {
  return scriptSafeJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.description,
    datePublished: post.date.toISOString(),
    author: { '@type': 'Person', name: post.author ?? 'HushBox Team' },
    publisher: {
      '@type': 'Organization',
      name: 'HushBox',
      url: post.siteOrigin,
    },
    mainEntityOfPage: post.canonicalUrl,
  });
}
