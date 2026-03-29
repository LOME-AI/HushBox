import { describe, it, expect } from 'vitest';
import {
  getReadingTime,
  getAllTags,
  getRelatedPosts,
  formatPostDate,
  POSTS_PER_PAGE,
  BLOG_DESCRIPTION,
  type PostLike,
} from './blog-utilities';

function makeFakePost(overrides: { id?: string; tags?: string[]; date?: Date }): PostLike {
  return {
    id: overrides.id ?? 'test-post',
    data: {
      tags: overrides.tags ?? [],
      date: overrides.date ?? new Date('2026-01-15'),
    },
  };
}

describe('getReadingTime', () => {
  it('returns 1 for very short content', () => {
    expect(getReadingTime('hello')).toBe(1);
  });

  it('returns 1 for empty string', () => {
    expect(getReadingTime('')).toBe(1);
  });

  it('calculates based on 200 words per minute', () => {
    const words = Array.from({ length: 400 }, () => 'word').join(' ');
    expect(getReadingTime(words)).toBe(2);
  });

  it('rounds to nearest minute', () => {
    const words = Array.from({ length: 250 }, () => 'word').join(' ');
    expect(getReadingTime(words)).toBe(1);
  });

  it('handles 1000 words as 5 minutes', () => {
    const words = Array.from({ length: 1000 }, () => 'word').join(' ');
    expect(getReadingTime(words)).toBe(5);
  });
});

describe('getAllTags', () => {
  it('returns empty array for no posts', () => {
    expect(getAllTags([])).toEqual([]);
  });

  it('returns sorted unique tags', () => {
    const posts = [
      makeFakePost({ tags: ['privacy', 'encryption'] }),
      makeFakePost({ tags: ['encryption', 'ai'] }),
    ];
    expect(getAllTags(posts)).toEqual(['ai', 'encryption', 'privacy']);
  });

  it('handles posts with no tags', () => {
    const posts = [makeFakePost({ tags: [] })];
    expect(getAllTags(posts)).toEqual([]);
  });

  it('deduplicates identical tags', () => {
    const posts = [makeFakePost({ tags: ['privacy'] }), makeFakePost({ tags: ['privacy'] })];
    expect(getAllTags(posts)).toEqual(['privacy']);
  });
});

describe('getRelatedPosts', () => {
  const postA = makeFakePost({
    id: 'a',
    tags: ['privacy', 'encryption'],
    date: new Date('2026-03-01'),
  });
  const postB = makeFakePost({
    id: 'b',
    tags: ['privacy', 'encryption', 'security'],
    date: new Date('2026-02-15'),
  });
  const postC = makeFakePost({
    id: 'c',
    tags: ['ai', 'product'],
    date: new Date('2026-03-10'),
  });
  const postD = makeFakePost({
    id: 'd',
    tags: ['privacy'],
    date: new Date('2026-01-01'),
  });

  const allPosts = [postA, postB, postC, postD];

  it('returns posts sorted by tag overlap', () => {
    const related = getRelatedPosts(postA, allPosts);
    expect(related[0]?.id).toBe('b');
    expect(related[1]?.id).toBe('d');
  });

  it('excludes the current post', () => {
    const related = getRelatedPosts(postA, allPosts);
    expect(related.every((p) => p.id !== 'a')).toBe(true);
  });

  it('respects the count parameter', () => {
    const related = getRelatedPosts(postA, allPosts, 1);
    expect(related).toHaveLength(1);
  });

  it('returns empty array when only one post exists', () => {
    const related = getRelatedPosts(postA, [postA]);
    expect(related).toHaveLength(0);
  });

  it('falls back to recency when no tag overlap', () => {
    const related = getRelatedPosts(postC, allPosts);
    expect(related[0]?.id).toBe('a');
  });

  it('breaks ties by most recent date', () => {
    const tiePost1 = makeFakePost({
      id: 'tie1',
      tags: ['privacy'],
      date: new Date('2026-03-20'),
    });
    const tiePost2 = makeFakePost({
      id: 'tie2',
      tags: ['privacy'],
      date: new Date('2026-01-01'),
    });
    const related = getRelatedPosts(postD, [postD, tiePost1, tiePost2]);
    expect(related[0]?.id).toBe('tie1');
    expect(related[1]?.id).toBe('tie2');
  });
});

describe('formatPostDate', () => {
  const date = new Date(2026, 2, 15);

  it('formats with long month by default', () => {
    expect(formatPostDate(date)).toBe('March 15, 2026');
  });

  it('formats with short month when requested', () => {
    expect(formatPostDate(date, 'short')).toBe('Mar 15, 2026');
  });
});

describe('POSTS_PER_PAGE', () => {
  it('is 8', () => {
    expect(POSTS_PER_PAGE).toBe(8);
  });
});

describe('BLOG_DESCRIPTION', () => {
  it('is a non-empty string', () => {
    expect(BLOG_DESCRIPTION.length).toBeGreaterThan(0);
  });
});
