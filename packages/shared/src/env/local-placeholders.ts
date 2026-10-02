/**
 * Values local stacks hold in place of a vendor key, readable by runtime code
 * that must recognise them. It imports nothing, and the backend env registry
 * never enters its graph: the Worker bundle reads these through the package
 * barrel, and the registry would carry every backend variable in with it.
 */

/**
 * `BRAVE_SEARCH_API_KEY` on every local stack. The search resolver refuses to
 * record CI cassettes against it.
 */
export const BRAVE_SEARCH_API_KEY_PLACEHOLDER = 'mock-brave-search-key';
