import { requireEnv } from '@hushbox/shared/require-env';

/**
 * Resolves the marketing API base URL. Read lazily (not at module load) so
 * islands that only call the API on user action still fail fast with a clear
 * message the moment a request is attempted in a misconfigured build.
 */
export function getApiUrl(): string {
  return requireEnv('VITE_API_URL', import.meta.env.VITE_API_URL);
}
