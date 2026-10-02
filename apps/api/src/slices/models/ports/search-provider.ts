import type { WebSearchQuery, WebSearchResults } from '@hushbox/shared';

/**
 * Web search behind the model's search tool. A resolved value is one completed
 * search, which is billable; a throw is a failed search, which bills nothing.
 * The signal is the caller's cancellation and reaches the outbound request.
 */
export interface SearchProvider {
  search(
    query: WebSearchQuery,
    options: { readonly signal: AbortSignal }
  ): Promise<WebSearchResults>;
}
