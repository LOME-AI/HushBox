import { describe, it, expect } from 'vitest';
import { blobCacheKeys } from './blob-cache-keys';

describe('blobCacheKeys', () => {
  it('exposes the blob namespace as the all key', () => {
    expect(blobCacheKeys.all).toEqual(['media', 'blob']);
  });

  it('builds a per-contentItem blob key', () => {
    expect(blobCacheKeys.blob('item-1')).toEqual(['media', 'blob', 'item-1']);
  });

  it('builds a fetch key from contentItemId and downloadUrl', () => {
    expect(blobCacheKeys.fetch('item-1', 'https://signed.example/x')).toEqual([
      'media',
      'fetch',
      'item-1',
      'https://signed.example/x',
    ]);
  });
});
