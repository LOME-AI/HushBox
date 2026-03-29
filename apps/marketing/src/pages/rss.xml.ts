import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getPublishedPosts, BLOG_DESCRIPTION } from '../lib/blog';

export async function GET(context: APIContext): Promise<Response> {
  const posts = await getPublishedPosts();

  return rss({
    title: 'HushBox Blog',
    description: BLOG_DESCRIPTION,
    site: context.site?.toString() ?? 'https://hushbox.ai',
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
