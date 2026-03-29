import { getPublishedPosts } from '../lib/blog';

export async function GET(): Promise<Response> {
  const posts = await getPublishedPosts();

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
