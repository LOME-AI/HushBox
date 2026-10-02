import type { WebSearchResults } from '@hushbox/shared';
import type { SearchProvider } from '../ports/search-provider.js';

/** The fixed answer, on reserved example domains so no link leads anywhere real. */
function fixedResults(): WebSearchResults {
  return {
    results: [
      {
        title: 'Example Domain',
        url: 'https://example.com/',
        snippet: 'This domain is for use in documentation examples without needing permission.',
        age: '2 days ago',
      },
      {
        title: 'Example Organization',
        url: 'https://example.org/',
        snippet: 'A second example result, so a list of sources renders with more than one row.',
      },
      {
        title: 'Example Network',
        url: 'https://example.net/',
        snippet: 'A third example result, with no age, as Brave returns for some pages.',
      },
    ],
  };
}

/**
 * The search backend of every stack that runs the mock model provider: the
 * same results for any query, and no network, key or cost.
 */
export function createFakeSearchProvider(): SearchProvider {
  return {
    search(): Promise<WebSearchResults> {
      return Promise.resolve(fixedResults());
    },
  };
}
