const WORDS_PER_MINUTE = 200;

export const POSTS_PER_PAGE = 8;

export const BLOG_DESCRIPTION =
  'Insights on privacy, encryption, and the future of AI conversations.';

export function formatPostDate(date: Date, style: 'short' | 'long' = 'long'): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: style,
    day: 'numeric',
  });
}

export interface PostLike {
  id: string;
  data: {
    tags: string[];
    date: Date;
  };
}

export function getReadingTime(content: string): number {
  const wordCount = content.split(/\s+/).length;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

export function getAllTags(posts: PostLike[]): string[] {
  const tagSet = new Set<string>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      tagSet.add(tag);
    }
  }
  return [...tagSet].toSorted((a, b) => a.localeCompare(b));
}

export function getRelatedPosts<T extends PostLike>(current: T, allPosts: T[], count = 3): T[] {
  const currentTags = new Set(current.data.tags);

  const scored = allPosts
    .filter((post) => post.id !== current.id)
    .map((post) => {
      const overlap = post.data.tags.filter((tag) => currentTags.has(tag)).length;
      return { post, overlap };
    })
    .toSorted((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return b.post.data.date.getTime() - a.post.data.date.getTime();
    });

  return scored.slice(0, count).map((s) => s.post);
}
