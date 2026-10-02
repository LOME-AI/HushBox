/**
 * Runtime configuration handed to the renderer pages served by this origin.
 *
 * The document renderer must know the module-CDN base URL to resolve a
 * document's bare imports, and that base is environment-driven (never
 * hard-coded): production
 * and dev-default point at esm.sh, while test modes point at a local static stub
 * on this same origin (env registry `ESM_CDN_URL`). Both the local
 * dev server and the production build emit the identical `/config.js` from this
 * single function, so the pages read one shape everywhere. The renderer pages
 * (owned downstream) consume `globalThis[SANDBOX_CONFIG_GLOBAL]`.
 *
 * Being environment-driven, the base can be pointed somewhere the sandbox CSP's
 * `script-src` does not permit; {@link assertCdnPermittedByCsp} is what makes
 * that a refusal here rather than every document import failing later.
 */

// Import the escape from the narrow `@hushbox/shared/script-safe-json` subpath,
// never the top-level barrel: this origin is credential-free, and a barrel
// import inlines the backend env registry into its public bundle.
import { scriptSafeJson } from '@hushbox/shared/script-safe-json';
import { SANDBOX_SCRIPT_SOURCES } from './csp.js';

/** The global the emitted script assigns; the seam the renderer pages read. */
export const SANDBOX_CONFIG_GLOBAL = '__SANDBOX_CONFIG__';

/** The subset of the process environment this module reads. */
interface SandboxConfigEnv {
  readonly ESM_CDN_URL?: string | undefined;
  /**
   * The origin these pages are served from. Present, it is what lets a CDN base
   * on this same origin be recognised as one the policy already names; absent,
   * only a `script-src` source can vouch for the base.
   */
  readonly SANDBOX_ORIGIN_URL?: string | undefined;
}

/** The resolved config shape assigned to the page global. */
interface SandboxConfig {
  readonly esmCdnUrl: string;
}

/** The origin of `url`, or `null` when it is not an absolute URL. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Refuse a module-CDN base the sandbox CSP would not let a document import from.
 *
 * The renderer rewrites every bare import onto this base, and `script-src`
 * decides which origins the frame may load a module from — two settings with no
 * link between them. Repointed without the policy following, every document
 * fails at run time with `import_failed`, an error that names the import and
 * never the configuration. Both inputs are known here, so the mismatch is a
 * startup refusal instead.
 */
function assertCdnPermittedByCsp(esmCdnUrl: string, sandboxOriginUrl: string | undefined): void {
  const cdnOrigin = originOf(esmCdnUrl);
  if (cdnOrigin === null) {
    throw new Error(
      `ESM_CDN_URL must be an absolute URL (got ${JSON.stringify(esmCdnUrl)}) — the renderer resolves bare imports against its origin.`
    );
  }
  // The policy names the origin these pages are served from, so only that exact
  // origin qualifies — a different port on the same host does not.
  const servedOrigin = sandboxOriginUrl === undefined ? null : originOf(sandboxOriginUrl);
  if (cdnOrigin === servedOrigin) return;
  if (SANDBOX_SCRIPT_SOURCES.includes(cdnOrigin)) return;
  throw new Error(
    `ESM_CDN_URL origin ${cdnOrigin} is not reachable under the sandbox CSP: script-src permits ${SANDBOX_SCRIPT_SOURCES.join(' ')}, and the served origin is ${servedOrigin ?? '(SANDBOX_ORIGIN_URL not set)'}. Widen the sandbox CSP's script-src or point ESM_CDN_URL back at a permitted origin.`
  );
}

/**
 * Build the `/config.js` source that publishes the resolved config to the page
 * global. Fails fast when `ESM_CDN_URL` is absent or empty — a missing base URL
 * is a deploy misconfiguration, never a silently-defaulted value — and when its
 * origin is one the sandbox CSP would refuse to load a module from.
 */
export function buildSandboxConfigScript(env: SandboxConfigEnv): string {
  const esmCdnUrl = env.ESM_CDN_URL;
  if (esmCdnUrl === undefined || esmCdnUrl === '') {
    throw new Error(
      'ESM_CDN_URL is not set — run `pnpm generate:env` (production/dev-default = esm.sh, test modes = local stub).'
    );
  }
  assertCdnPermittedByCsp(esmCdnUrl, env.SANDBOX_ORIGIN_URL);
  const config: SandboxConfig = { esmCdnUrl };
  return `globalThis[${scriptSafeJson(SANDBOX_CONFIG_GLOBAL)}] = ${scriptSafeJson(config)};`;
}
