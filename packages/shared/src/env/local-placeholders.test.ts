import { describe, expect, it } from 'vitest';
import { BRAVE_SEARCH_API_KEY_PLACEHOLDER } from './local-placeholders.ts';
import * as barrel from '../index.ts';

describe('BRAVE_SEARCH_API_KEY_PLACEHOLDER', () => {
  it('is the local placeholder its runbook names', () => {
    expect(BRAVE_SEARCH_API_KEY_PLACEHOLDER).toBe('mock-brave-search-key');
  });

  it('is published on the package barrel', () => {
    expect(barrel.BRAVE_SEARCH_API_KEY_PLACEHOLDER).toBe(BRAVE_SEARCH_API_KEY_PLACEHOLDER);
  });
});
