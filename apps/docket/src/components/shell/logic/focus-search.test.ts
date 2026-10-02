import { describe, it, expect, afterEach } from 'vitest';
import { TEST_IDS } from '@/test-ids';
import { focusSearch } from './focus-search';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusSearch', () => {
  it('puts the caret in the console search field', () => {
    const input = document.createElement('input');
    input.dataset['testid'] = TEST_IDS.searchInput;
    document.body.append(input);

    focusSearch();

    expect(document.activeElement).toBe(input);
  });

  it('does nothing when there is no search field on the page', () => {
    expect(() => {
      focusSearch();
    }).not.toThrow();
  });
});
