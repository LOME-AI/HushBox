import { getCollection, type CollectionEntry } from 'astro:content';
import { isPostVisible } from './blog-utilities';
import { env } from './env';

export {
  getReadingTime,
  getAllTags,
  getRelatedPosts,
  formatPostDate,
  tagUrl,
  BLOG_DESCRIPTION,
} from './blog-utilities';

export type BlogPost = CollectionEntry<'blog'>;

export async function getPublishedPosts(): Promise<BlogPost[]> {
  const posts = await getCollection('blog', ({ data }) => isPostVisible(data, env));
  return posts.toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime());
}
