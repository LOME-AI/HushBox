/**
 * Normalize the first argument of a captured `fetch` call to its URL string.
 *
 * `fetch` accepts `string | URL | Request`; the typed Hono client
 * (`hc(baseUrl).…$post(...)`) may emit either form across versions, so tests
 * that assert which endpoint was hit should match through this helper rather
 * than against a hardcoded string equality.
 */
export function urlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
