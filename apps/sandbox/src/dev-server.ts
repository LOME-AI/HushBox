import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { contentTypeFor } from './mime.js';
import { sandboxSecurityHeaders } from './csp.js';
import { ESM_STUB_PREFIX, resolveEsmStub } from './esm-stub.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Local dev server for the sandbox origin. Production serves the same `./dist`
 * as a Cloudflare assets Worker (wrangler.toml); this Node server is the
 * local-parity equivalent, mounted into `pnpm dev` on the per-worktree
 * `HB_SANDBOX_PORT`. It serves static files with the correct Content-Type, the
 * Content-Security-Policy derivation the production `_headers` is pinned to (so
 * E2E and dev exercise the real containment policy, not a permissive one), and a
 * permissive CORS header so the opaque `allow-scripts` iframe can fetch the
 * Pyodide wasm/wheels cross-origin. It also publishes the synthetic `/config.js`
 * (env-derived renderer config) and, under `/esm-stub/`, the local module
 * fixtures test mode resolves imports against in place of esm.sh.
 */

/** Read the per-worktree dev port; fail fast rather than default a port. */
export function resolveDevPort(env: { HB_SANDBOX_PORT?: string | undefined }): number {
  const raw = env.HB_SANDBOX_PORT;
  const port = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `HB_SANDBOX_PORT is not a valid port (got ${JSON.stringify(raw)}) — run \`pnpm generate:env\` first.`
    );
  }
  return port;
}

interface RequestListenerOptions {
  /** Absolute directory whose files are served. */
  readonly publicDir: string;
  /** The `/config.js` body (from buildSandboxConfigScript). */
  readonly configScript: string;
  /** The origin browsers reach this server at, which its CSP names. */
  readonly servedOrigin: string;
  /** Whether the CSP admits the production embedders or the local stack's. */
  readonly isProduction: boolean;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/**
 * Every response carries the permissive CORS baseline plus the production
 * security headers (the sandbox CSP + DNS-prefetch lock), so a page loaded from
 * this dev server runs under the containment policy production serves — the same
 * derivation, differing in the origin it names, which is this server's rather
 * than the deployed one, and in the embedders the caller's mode admits. The policy is chosen per path, because the
 * shipped `_headers` gives the Python runtime its own block: served blind, dev
 * and E2E would run every page under a policy production grants only one of them.
 */
function baseHeaders(
  pathname: string,
  options: RequestListenerOptions
): Readonly<Record<string, string>> {
  return {
    ...CORS_HEADERS,
    ...sandboxSecurityHeaders(pathname, options.servedOrigin, options.isProduction),
  };
}

/** The synthetic path that serves the env-derived renderer config. */
const CONFIG_PATH = '/config.js';

/**
 * Resolve a request pathname to an absolute path guaranteed to be the served
 * directory itself or strictly beneath it, or `null` when it would escape.
 * This is the traversal guard: even though the URL parser normalizes literal and
 * percent-encoded `..` segments before this runs, the check is the defensive
 * wall that does not trust that normalization.
 */
export function resolveWithinDir(publicDir: string, pathname: string): string | null {
  const resolved = path.resolve(publicDir, `.${pathname}`);
  if (resolved === publicDir || resolved.startsWith(publicDir + path.sep)) {
    return resolved;
  }
  return null;
}

/** Send a header-only response (CORS + security headers + status, no body). */
function respondEmpty(
  res: ServerResponse,
  status: number,
  pathname: string,
  options: RequestListenerOptions
): void {
  res.writeHead(status, baseHeaders(pathname, options));
  res.end();
}

/** Serve a file from the served directory, or a 403/404 header-only response. */
function serveStaticAsset(
  res: ServerResponse,
  options: RequestListenerOptions,
  pathname: string,
  isHead: boolean
): void {
  const resolved = resolveWithinDir(options.publicDir, pathname);
  /* v8 ignore start -- defense in depth: the URL parser normalizes both literal
     and percent-encoded `..` before this runs, so a real HTTP request can never
     reach here; the containment contract is unit-tested on resolveWithinDir. */
  if (resolved === null) {
    respondEmpty(res, 403, pathname, options);
    return;
  }
  /* v8 ignore stop */

  let body: Buffer;
  try {
    if (statSync(resolved).isDirectory()) {
      respondEmpty(res, 404, pathname, options);
      return;
    }
    body = readFileSync(resolved);
  } catch {
    respondEmpty(res, 404, pathname, options);
    return;
  }

  res.writeHead(200, {
    ...baseHeaders(pathname, options),
    'Content-Type': contentTypeFor(pathname),
  });
  res.end(isHead ? undefined : body);
}

/** What one esm-stub request names: the fixture, its build query, and the verb. */
interface EsmStubRequest {
  readonly pathname: string;
  readonly search: string;
  readonly isHead: boolean;
}

/** Serve a JS module body, or a 404 when the esm-stub names no fixture. */
function serveEsmStub(
  res: ServerResponse,
  options: RequestListenerOptions,
  request: EsmStubRequest
): void {
  const body = resolveEsmStub(request.pathname, request.search);
  if (body === null) {
    respondEmpty(res, 404, request.pathname, options);
    return;
  }
  res.writeHead(200, {
    ...baseHeaders(request.pathname, options),
    'Content-Type': 'text/javascript; charset=utf-8',
  });
  res.end(request.isHead ? undefined : body);
}

/** Build the Node request handler that serves the sandbox origin's assets. */
export function createRequestListener(
  options: RequestListenerOptions
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (method === 'OPTIONS') {
      respondEmpty(res, 204, url.pathname, options);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      respondEmpty(res, 405, url.pathname, options);
      return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const isHead = method === 'HEAD';

    if (pathname === CONFIG_PATH) {
      res.writeHead(200, {
        ...baseHeaders(pathname, options),
        'Content-Type': 'text/javascript; charset=utf-8',
      });
      res.end(isHead ? undefined : options.configScript);
      return;
    }

    if (pathname.startsWith(`${ESM_STUB_PREFIX}/`)) {
      serveEsmStub(res, options, { pathname, search: url.search, isHead });
      return;
    }

    serveStaticAsset(res, options, pathname, isHead);
  };
}
