import { getCollection, type CollectionEntry } from 'astro:content';

export {
  getReadingTime,
  getAllTags,
  getRelatedPosts,
  formatPostDate,
  POSTS_PER_PAGE,
  BLOG_DESCRIPTION,
} from './blog-utilities';

export type BlogPost = CollectionEntry<'blog'>;

export async function getPublishedPosts(): Promise<BlogPost[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime());
}
