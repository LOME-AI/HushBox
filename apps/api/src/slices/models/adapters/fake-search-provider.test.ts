import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSearchResults } from '@hushbox/shared';
import { createFakeSearchProvider } from './fake-search-provider.js';

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('createFakeSearchProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers different queries with the same results', async () => {
    const provider = createFakeSearchProvider();

    const first = await provider.search({ query: 'tide tables' }, { signal: signal() });
    const second = await provider.search({ query: 'moon phases' }, { signal: signal() });

    expect(second).toEqual(first);
  });

  it('answers with at least one result that satisfies the shared results contract', async () => {
    const shaped = await createFakeSearchProvider().search(
      { query: 'tide tables' },
      { signal: signal() }
    );

    expect(WebSearchResults.parse(shaped).results.length).toBeGreaterThan(0);
  });

  it('never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the fake search provider reached the network');
    });

    await createFakeSearchProvider().search({ query: 'tide tables' }, { signal: signal() });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
