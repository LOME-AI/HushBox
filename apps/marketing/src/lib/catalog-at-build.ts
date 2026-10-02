import { modelsListResponseSchema } from '@hushbox/shared';
import type { Model } from '@hushbox/shared';

type CatalogStatus = number | 'network';

export type CatalogAtBuild =
  | { kind: 'ok'; models: Model[] }
  | { kind: 'unavailable'; url: string; status: CatalogStatus };

interface CatalogDeps {
  fetch: typeof fetch;
  isProduction: boolean;
}

interface CatalogFailure {
  kind: 'unavailable';
  url: string;
  status: CatalogStatus;
  reason: string;
  cause?: unknown;
}

/** A production build that cannot read the model catalog, named by where it failed. */
export class CatalogUnavailableError extends Error {
  readonly url: string;
  readonly status: CatalogStatus;

  constructor({ url, status, reason, cause }: CatalogFailure) {
    super(`Catalog unavailable at build: GET ${url} ${reason} (status ${String(status)})`, {
      cause,
    });
    this.name = 'CatalogUnavailableError';
    this.url = url;
    this.status = status;
  }
}

async function readCatalog(
  url: string,
  fetchCatalog: typeof fetch
): Promise<{ kind: 'ok'; models: Model[] } | CatalogFailure> {
  let response: Response;
  try {
    response = await fetchCatalog(url);
  } catch (error) {
    return { kind: 'unavailable', url, status: 'network', reason: 'got no answer', cause: error };
  }
  const { status } = response;
  if (!response.ok) return { kind: 'unavailable', url, status, reason: 'answered an error' };
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return {
      kind: 'unavailable',
      url,
      status,
      reason: 'answered a body that is not JSON',
      cause: error,
    };
  }
  const parsed = modelsListResponseSchema.safeParse(body);
  return parsed.success
    ? { kind: 'ok', models: parsed.data.models }
    : {
        kind: 'unavailable',
        url,
        status,
        reason: 'answered a body that fails the models schema',
        cause: parsed.error,
      };
}

/**
 * Reads the model catalog the welcome page's figures come from. A production build must
 * ship real figures, so any failure throws; any other build (the end-to-end build runs
 * with no API) reports the catalog unavailable so the page can show where it failed.
 */
export async function loadCatalogAtBuild(
  apiUrl: string,
  deps: CatalogDeps
): Promise<CatalogAtBuild> {
  const result = await readCatalog(`${apiUrl}/models`, deps.fetch);
  if (result.kind === 'ok') return result;
  if (deps.isProduction) throw new CatalogUnavailableError(result);
  return { kind: 'unavailable', url: result.url, status: result.status };
}
