import * as React from 'react';
import { getApiUrl } from './api-url';
import type { ZodType } from 'zod';

export interface PublicQueryState<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
}

type SharedResponse = { ok: true; body: unknown } | { ok: false; status: number };

// Keyed by the fetch in use, then by path: islands hydrated separately on one page share one
// request per path, and a page whose fetch is replaced starts from nothing. A settled request
// stays settled for the page's life, so a failure is never retried.
const sharedRequests = new WeakMap<typeof fetch, Map<string, Promise<SharedResponse>>>();

function requestOnce(path: string): Promise<SharedResponse> {
  const fetchImpl = globalThis.fetch;
  let byPath = sharedRequests.get(fetchImpl);
  if (byPath === undefined) {
    byPath = new Map();
    sharedRequests.set(fetchImpl, byPath);
  }
  const existing = byPath.get(path);
  if (existing !== undefined) return existing;
  const request = (async (): Promise<SharedResponse> => {
    // `omit` keeps a signed-in visitor's API session cookie off a public read and stops the
    // browser storing any cookie the response sets.
    const response = await fetchImpl(`${getApiUrl()}${path}`, { credentials: 'omit' });
    if (!response.ok) return { ok: false, status: response.status };
    const body: unknown = await response.json();
    return { ok: true, body };
  })();
  byPath.set(path, request);
  return request;
}

/**
 * Minimal data-fetching hook for the public marketing API endpoints. We
 * deliberately don't pull in TanStack Query for the marketing site — one
 * fetch per path per page, no refetch, no cache invalidation, no mutations.
 *
 * The response is Zod-validated client-side too as a sanity guard: if the
 * API shape drifts, the island fails closed to an error state instead of
 * rendering garbage. Each instance validates the shared body against its
 * own schema and labels its own errors.
 *
 * Every instance renders the loading state first and takes data only in its
 * effect, even when the shared request has already settled: an island that
 * hydrates after another must match its server-rendered loading markup.
 *
 * `errorLabel` names the island in error messages ("roadmap request
 * failed: 503"). Callers pass module-level constants for all three
 * arguments, so the effect runs once on mount.
 */
export function usePublicQuery<T>(
  path: string,
  schema: ZodType<T>,
  errorLabel: string
): PublicQueryState<T> {
  const [state, setState] = React.useState<PublicQueryState<T>>({
    data: null,
    error: null,
    isLoading: true,
  });

  const cancelledRef = React.useRef(false);

  React.useEffect(() => {
    cancelledRef.current = false;
    void (async () => {
      try {
        const response = await requestOnce(path);
        if (!response.ok) {
          throw new Error(`${errorLabel} request failed: ${String(response.status)}`);
        }
        const parsed = schema.parse(response.body);
        if (cancelledRef.current) return;
        setState({ data: parsed, error: null, isLoading: false });
      } catch (error) {
        if (cancelledRef.current) return;
        setState({
          data: null,
          error: error instanceof Error ? error : new Error(`unknown ${errorLabel} error`),
          isLoading: false,
        });
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [path, schema, errorLabel]);

  return state;
}
