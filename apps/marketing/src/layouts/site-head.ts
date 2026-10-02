import { buildBlogArticleJsonLd } from '../lib/blog-structured-data';

/** The post facts a blog article's head publishes. */
export interface SiteArticle {
  readonly author: string;
  readonly date: Date;
  readonly tags: readonly string[];
}

/** What a page tells the site layout about itself. */
export interface SiteHeadProps {
  readonly title: string;
  readonly description?: string | undefined;
  readonly image?: string | undefined;
  readonly blog?: boolean;
  readonly article?: SiteArticle;
}

/** The values the site layout's `<head>` is written from. */
export interface SiteHead {
  readonly documentTitle: string;
  readonly twitterTitle: string;
  readonly canonicalUrl: string;
  readonly ogImage: string;
  readonly ogType: 'website' | 'article';
  readonly rss: boolean;
  readonly jsonLd: string | undefined;
}

function articleJsonLd(
  props: SiteHeadProps,
  article: SiteArticle,
  canonicalUrl: string,
  site: URL
): string {
  if (props.description === undefined) {
    throw new Error(`The blog article "${props.title}" needs a description for its head.`);
  }
  return buildBlogArticleJsonLd({
    title: props.title,
    description: props.description,
    date: article.date,
    author: article.author,
    canonicalUrl,
    siteOrigin: site.origin,
  });
}

/**
 * The head a page gets: the blog head (its own title suffix, the feed link,
 * and for an article the article type and structured data) when the page is
 * on the blog, the site head otherwise. Every URL is absolute on `site`.
 */
export function siteHead(props: SiteHeadProps, site: URL, pathname: string): SiteHead {
  const canonicalUrl = new URL(pathname, site).toString();
  const ogImage = props.image ?? new URL('og-default.png', site).toString();
  const onBlog = props.blog === true || props.article !== undefined;
  const documentTitle = `${props.title} | ${onBlog ? 'HushBox Blog' : 'HushBox'}`;
  return {
    documentTitle,
    twitterTitle: onBlog ? props.title : documentTitle,
    canonicalUrl,
    ogImage,
    ogType: props.article === undefined ? 'website' : 'article',
    rss: onBlog,
    jsonLd:
      props.article === undefined
        ? undefined
        : articleJsonLd(props, props.article, canonicalUrl, site),
  };
}
