import { z } from 'zod';

/**
 * The web-search tool's contract: its registry name, what the model is told it
 * does, the input the model sends and the results the search provider returns.
 */

/** The registry name a definition (chat turn, workflow node) selects web search by. */
export const WEB_SEARCH_TOOL_NAME = 'webSearch';

/** What the model is told web search does. */
export const WEB_SEARCH_TOOL_DESCRIPTION =
  'Search the web for current information. Returns the top results, each with a title, URL and snippet, and an age when the page states one.';

/** Brave's documented limits on `q`: 600 characters and 75 words. */
const QUERY_MAX_CHARS = 600;
const QUERY_MAX_WORDS = 75;

function wordCount(value: string): number {
  return value.split(/\s+/).filter((word) => word !== '').length;
}

/**
 * Web search's URL rule, applied to search results and to stored sources: only
 * http(s) pages are kept, stored or linked. Anything else (`javascript:`,
 * `data:`, a relative string) is refused, because a stored URL is later
 * rendered as a link.
 */
export function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:';
}

export const WebSearchQuery = z.object({
  query: z
    .string()
    .max(QUERY_MAX_CHARS)
    .refine((value) => value.trim() !== '', { message: 'query is empty' })
    .refine((value) => wordCount(value) <= QUERY_MAX_WORDS, {
      message: 'query has too many words',
    }),
});

export type WebSearchQuery = z.infer<typeof WebSearchQuery>;

const WebSearchResult = z.object({
  title: z.string(),
  url: z.string().refine(isHttpUrl, { message: 'url is not http(s)' }),
  snippet: z.string(),
  age: z.string().optional(),
});

export const WebSearchResults = z.object({ results: z.array(WebSearchResult) });

export type WebSearchResults = z.infer<typeof WebSearchResults>;
