import { describe, it, expect } from 'vitest';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { BLOG_DESCRIPTION } from './blog-utilities';
import { buildPostIndex, buildRssFeed, type FeedPost } from './blog-feeds';

const SITE = new URL('https://example.test');

const POSTS: FeedPost[] = [
  {
    id: 'a-quieter-release',
    data: {
      title: 'A quieter release',
      description: 'What changed this cycle.',
      date: new Date(TEST_DAY_START),
      tags: ['privacy', 'release'],
    },
  },
  {
    id: 'keys-that-never-leave',
    data: {
      title: 'Keys that never leave',
      description: 'Where the encryption happens.',
      date: new Date(TEST_DAY_START - DAY_MS),
      tags: ['encryption'],
    },
  },
];

async function feedBody(posts: FeedPost[]): Promise<string> {
  const feed = await buildRssFeed(posts, SITE);
  return feed.text();
}

describe('buildRssFeed', () => {
  it('lists every published post as a feed item', async () => {
    const body = await feedBody(POSTS);
    expect(body).toContain('<title>A quieter release</title>');
    expect(body).toContain('<title>Keys that never leave</title>');
  });

  it('links each item at its post path on the configured site', async () => {
    expect(await feedBody(POSTS)).toContain(
      '<link>https://example.test/blog/a-quieter-release/</link>'
    );
  });

  it('dates each item by the post date', async () => {
    expect(await feedBody(POSTS)).toContain(
      `<pubDate>${new Date(TEST_DAY_START).toUTCString()}</pubDate>`
    );
  });

  it('carries the post tags as feed categories', async () => {
    expect(await feedBody(POSTS)).toContain('<category>encryption</category>');
  });

  it('describes the channel with the shared blog description', async () => {
    expect(await feedBody(POSTS)).toContain(BLOG_DESCRIPTION);
  });

  it('titles the channel for the blog', async () => {
    expect(await feedBody(POSTS)).toContain('<title>HushBox Blog</title>');
  });

  it('declares the feed language', async () => {
    expect(await feedBody(POSTS)).toContain('<language>en-us</language>');
  });

  it('describes each item with the post description', async () => {
    expect(await feedBody(POSTS)).toContain('<description>What changed this cycle.</description>');
  });

  it('emits a feed with no items when nothing is published', async () => {
    expect(await feedBody([])).not.toContain('<item>');
  });

  it('serves the feed as XML', async () => {
    const response = await buildRssFeed(POSTS, SITE);
    expect(response.headers.get('Content-Type')).toContain('xml');
  });
});

describe('buildPostIndex', () => {
  it('maps each post to its index entry', async () => {
    expect(await buildPostIndex(POSTS).json()).toEqual([
      {
        slug: 'a-quieter-release',
        title: 'A quieter release',
        description: 'What changed this cycle.',
        tags: ['privacy', 'release'],
      },
      {
        slug: 'keys-that-never-leave',
        title: 'Keys that never leave',
        description: 'Where the encryption happens.',
        tags: ['encryption'],
      },
    ]);
  });

  it('returns an empty index when nothing is published', async () => {
    expect(await buildPostIndex([]).json()).toEqual([]);
  });

  it('serves the index as JSON', () => {
    expect(buildPostIndex(POSTS).headers.get('Content-Type')).toBe('application/json');
  });
});
