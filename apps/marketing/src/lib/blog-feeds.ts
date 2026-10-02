import rss from '@astrojs/rss';
import { BLOG_DESCRIPTION } from './blog-utilities';

/**
 * The post fields the machine-readable blog surfaces read. Structural rather
 * than the content collection's entry type on purpose: that type arrives with
 * the `astro:content` runtime, which resolves only inside the Astro build, so
 * depending on it here would put these builders out of unit-test reach.
 */
export interface FeedPost {
  id: string;
  data: {
    title: string;
    description: string;
    date: Date;
    tags: string[];
  };
}

export function buildRssFeed(posts: FeedPost[], site: URL): Promise<Response> {
  return rss({
    title: 'HushBox Blog',
    description: BLOG_DESCRIPTION,
    site: site.toString(),
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: `/blog/${post.id}/`,
      categories: post.data.tags,
    })),
    customData: '<language>en-us</language>',
  });
}

export function buildPostIndex(posts: FeedPost[]): Response {
  const index = posts.map((post) => ({
    slug: post.id,
    title: post.data.title,
    description: post.data.description,
    tags: post.data.tags,
  }));

  return Response.json(index, {
    headers: { 'Content-Type': 'application/json' },
  });
}
