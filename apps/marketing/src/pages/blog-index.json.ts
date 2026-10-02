import { getPublishedPosts } from '../lib/blog';
import { buildPostIndex } from '../lib/blog-feeds';

export async function GET(): Promise<Response> {
  return buildPostIndex(await getPublishedPosts());
}
