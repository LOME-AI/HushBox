import { describe, expect, it } from 'vitest';
import {
  WEB_SEARCH_TOOL_NAME,
  WebSearchQuery,
  WebSearchResults,
  isHttpUrl,
} from './web-search-contract.ts';

describe('WEB_SEARCH_TOOL_NAME', () => {
  it('is the registry name a definition selects web search by', () => {
    expect(WEB_SEARCH_TOOL_NAME).toBe('webSearch');
  });
});

describe('isHttpUrl', () => {
  it('accepts an https url', () => {
    expect(isHttpUrl('https://example.com/page')).toBe(true);
  });

  it('accepts an http url', () => {
    expect(isHttpUrl('http://example.com/')).toBe(true);
  });

  it('refuses a javascript url', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('refuses a data url', () => {
    expect(isHttpUrl('data:text/html,hi')).toBe(false);
  });

  it('refuses text that is not a url', () => {
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('WebSearchQuery', () => {
  it('accepts an ordinary query', () => {
    expect(WebSearchQuery.parse({ query: 'weather in lisbon' })).toEqual({
      query: 'weather in lisbon',
    });
  });

  it('rejects an empty query', () => {
    expect(WebSearchQuery.safeParse({ query: '' }).success).toBe(false);
  });

  it('rejects a query of only whitespace', () => {
    expect(WebSearchQuery.safeParse({ query: '   ' }).success).toBe(false);
  });

  it('accepts a query of exactly 600 characters', () => {
    expect(WebSearchQuery.safeParse({ query: 'a'.repeat(600) }).success).toBe(true);
  });

  it('rejects a query over 600 characters', () => {
    expect(WebSearchQuery.safeParse({ query: 'a'.repeat(601) }).success).toBe(false);
  });

  it('accepts a query of exactly 75 words', () => {
    expect(
      WebSearchQuery.safeParse({ query: Array.from({ length: 75 }, () => 'w').join(' ') }).success
    ).toBe(true);
  });

  it('rejects a query over 75 words', () => {
    expect(
      WebSearchQuery.safeParse({ query: Array.from({ length: 76 }, () => 'w').join(' ') }).success
    ).toBe(false);
  });
});

describe('WebSearchResults', () => {
  it('accepts shaped results with and without an age', () => {
    const results = {
      results: [
        { title: 'T', url: 'https://a.example/', snippet: 'S', age: '2 days ago' },
        { title: 'U', url: 'http://b.example/', snippet: '' },
      ],
    };
    expect(WebSearchResults.parse(results)).toEqual(results);
  });

  it('accepts zero results', () => {
    expect(WebSearchResults.parse({ results: [] })).toEqual({ results: [] });
  });

  it('rejects a result whose url is not http(s)', () => {
    const results = { results: [{ title: 'T', url: 'ftp://a.example/', snippet: 'S' }] };
    expect(WebSearchResults.safeParse(results).success).toBe(false);
  });
});
