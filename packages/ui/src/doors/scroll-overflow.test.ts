import { describe, it, expect } from 'vitest';

describe('@hushbox/ui/scroll-overflow', () => {
  it('publishes the overflow stop a static page calls on a scroll region', async () => {
    const door = await import('@hushbox/ui/scroll-overflow');

    expect(Object.keys(door)).toEqual(['observeOverflowStop']);
  });
});
