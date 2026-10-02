/** Served versions that name no deployment, against which no client is ever stale. */
const UNVERSIONED_SERVED_VERSIONS: ReadonlySet<string> = new Set(['dev-local', 'test']);

/**
 * Whether a client running `clientVersion` must update to the deployment serving
 * `servedVersion`: true when that deployment is versioned and the client runs any
 * other version. The one definition of "stale", so every version check agrees.
 */
export function isStaleClientVersion(clientVersion: string, servedVersion: string): boolean {
  if (UNVERSIONED_SERVED_VERSIONS.has(servedVersion)) return false;
  return clientVersion !== servedVersion;
}
