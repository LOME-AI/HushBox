import { computeWideLayout, computeNarrowLayout } from './layout.js';
import { LAYOUT_CONFIG } from './layout-config.js';

/**
 * Runtime cache-key hash for the public roadmap response. The hash is a
 * SHA-256 prefix of the layout module's contents (function sources +
 * tunable constants). Computed once per worker isolate on first request,
 * cached in module scope. A new deploy creates new isolates, which
 * compute a new hash and start writing to a new Redis key.
 *
 * Why this exists: we want layout changes to invalidate cached data
 * automatically, without a manual version bump and without a build-time
 * codegen step. Function.prototype.toString returns each function's
 * source as it appears in the bundle (minified in production), which
 * gives us a deterministic-per-build identifier.
 *
 * Add any new layout function or tunable object to HASH_INPUTS below.
 * Otherwise its changes will silently not invalidate cached data.
 */
const HASH_INPUTS: readonly string[] = [
  computeWideLayout.toString(),
  computeNarrowLayout.toString(),
  JSON.stringify(LAYOUT_CONFIG),
];

let cached: string | null = null;

export async function getLayoutVersion(): Promise<string> {
  if (cached !== null) return cached;
  const inputString = HASH_INPUTS.join('\x00');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inputString));
  cached = [...new Uint8Array(buf).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return cached;
}

/**
 * Reset the module-scope cache. Test-only helper — production worker
 * isolates run for minutes to hours and benefit from caching the hash.
 */
export function _resetLayoutVersionCache(): void {
  cached = null;
}
