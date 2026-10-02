import { WEB_SEARCH_TOOL_DESCRIPTION, WEB_SEARCH_TOOL_NAME, WebSearchQuery } from '@hushbox/shared';
import { isToolName } from '@hushbox/shared/affordability';
import type {
  SearchProvider,
  ToolDefinition,
  ToolRegistry,
  ToolSelection,
} from '../ports/index.js';

/**
 * The closed, server-side tool registry. Its keys are the tool names the tool
 * loop declares, so a tool is registered exactly when its facts are declared.
 * The adapter builds the concrete SDK tool from each definition; a new tool is a
 * new registered entry, never open client input.
 */
export function createToolRegistry(deps: { readonly search: SearchProvider }): ToolRegistry {
  return {
    [WEB_SEARCH_TOOL_NAME]: {
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      inputSchema: WebSearchQuery,
      execute: async (input, { signal }) =>
        deps.search.search(WebSearchQuery.parse(input), { signal }),
    },
  };
}

/**
 * Resolve a definition's declared tool names against the registry. An empty
 * selection yields no tools (a plain, no-tool call); any name outside the
 * declared set yields `undefined`. A clean compile guarantees the names exist,
 * so a miss is a wiring defect the caller surfaces, never a silent drop.
 */
export function resolveToolRegistry(
  registry: ToolRegistry,
  names: readonly string[]
): ToolSelection | undefined {
  const resolved: Record<string, ToolDefinition> = {};
  for (const name of names) {
    if (!isToolName(name)) return undefined;
    resolved[name] = registry[name];
  }
  return resolved;
}
