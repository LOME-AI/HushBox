import { describe, it, expect } from 'vitest';
import { WEB_SEARCH_STORAGE_KEY } from './storage-keys.js';

describe('storage keys', () => {
  it('pins the web-search persistence key (shared by the web store and e2e seed)', () => {
    expect(WEB_SEARCH_STORAGE_KEY).toBe('hushbox-search-storage');
  });
});
