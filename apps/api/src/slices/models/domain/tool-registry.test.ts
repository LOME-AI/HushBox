import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { WEB_SEARCH_TOOL_DESCRIPTION, WEB_SEARCH_TOOL_NAME, WebSearchQuery } from '@hushbox/shared';
import { createToolRegistry, resolveToolRegistry } from './tool-registry.js';
import type { WebSearchResults } from '@hushbox/shared';
import type { ToolName } from '@hushbox/shared/affordability';
import type { SearchProvider, ToolRegistry } from '../ports/index.js';

const RESULTS: WebSearchResults = {
  results: [{ title: 'Example Domain', url: 'https://example.com/', snippet: 'An example.' }],
};

function recordingSearch(): { readonly search: SearchProvider; readonly calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    search: {
      search: (query, options): Promise<WebSearchResults> => {
        calls.push([query, options]);
        return Promise.resolve(RESULTS);
      },
    },
  };
}

describe('createToolRegistry', () => {
  it('registers exactly the declared tool names', () => {
    expect(Object.keys(createToolRegistry(recordingSearch()))).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it('is keyed by the tool names the tool loop declares', () => {
    expectTypeOf<keyof ToolRegistry>().toEqualTypeOf<ToolName>();
  });

  it('advertises the shared web-search query as the tool input schema', () => {
    expect(createToolRegistry(recordingSearch())[WEB_SEARCH_TOOL_NAME].inputSchema).toBe(
      WebSearchQuery
    );
  });

  it('advertises the shared web-search description', () => {
    expect(createToolRegistry(recordingSearch())[WEB_SEARCH_TOOL_NAME].description).toBe(
      WEB_SEARCH_TOOL_DESCRIPTION
    );
  });

  it('searches through the search provider with the signal the call carries', async () => {
    const provider = recordingSearch();
    const signal = new AbortController().signal;

    const result = await createToolRegistry(provider)[WEB_SEARCH_TOOL_NAME].execute(
      { query: 'hushbox' },
      { signal }
    );

    expect(result).toEqual(RESULTS);
    expect(provider.calls).toEqual([[{ query: 'hushbox' }, { signal }]]);
  });

  it('refuses input outside the query contract without searching', async () => {
    const provider = recordingSearch();
    const search = vi.spyOn(provider.search, 'search');

    await expect(
      createToolRegistry(provider)[WEB_SEARCH_TOOL_NAME].execute(
        { query: '' },
        { signal: new AbortController().signal }
      )
    ).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
});

describe('resolveToolRegistry', () => {
  const registry = createToolRegistry(recordingSearch());

  it('resolves the selected names to their definitions', () => {
    expect(resolveToolRegistry(registry, [WEB_SEARCH_TOOL_NAME])).toEqual({
      [WEB_SEARCH_TOOL_NAME]: registry[WEB_SEARCH_TOOL_NAME],
    });
  });

  it('resolves an empty selection to no tools', () => {
    expect(resolveToolRegistry(registry, [])).toEqual({});
  });

  it('resolves nothing when any selected name is not a declared tool', () => {
    expect(resolveToolRegistry(registry, [WEB_SEARCH_TOOL_NAME, 'unknownTool'])).toBeUndefined();
  });
});
