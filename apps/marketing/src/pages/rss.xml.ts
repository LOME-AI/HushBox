import { getPublishedPosts } from '../lib/blog';
import { buildRssFeed } from '../lib/blog-feeds';
import { requireSite } from '../lib/site-url';
import type { APIContext } from 'astro';

export async function GET(context: APIContext): Promise<Response> {
  return buildRssFeed(await getPublishedPosts(), requireSite(context.site));
}
