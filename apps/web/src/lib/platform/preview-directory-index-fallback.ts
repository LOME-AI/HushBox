import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Compute the rewritten request URL for a directory-style path that maps to
 * a nested `index.html` in the dist tree. Returns the new URL (preserving
 * any query string) or `null` if the original URL should pass through to the
 * next middleware.
 *
 * Skipped:
 *   - root (`/`), trailing-slash paths (vite's existing htmlFallbackMiddleware
 *     handles these), explicit `.html` paths.
 *   - URLs with invalid percent encoding.
 *   - Paths that resolve outside `distDir` (traversal guard).
 *   - Paths whose `index.html` does not exist (let vite's SPA fallback take it).
 *
 * Pure; `fileExists` is injectable for testing.
 */
export function rewriteForDirectoryIndex(
  fullUrl: string,
  distributionDir: string,
  fileExists: (path: string) => boolean = existsSync
): string | null {
  /* v8 ignore next -- String.split always returns at least one element, so [0] is defined; the `?? ''` fallback is unreachable. */
  const url = fullUrl.split('?')[0] ?? '';
  if (url.length <= 1 || url.endsWith('/') || url.endsWith('.html')) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url);
  } catch {
    return null;
  }
  const filePath = path.resolve(distributionDir, '.' + pathname, 'index.html');
  if (!filePath.startsWith(distributionDir) || !fileExists(filePath)) return null;
  return `${url}/index.html${fullUrl.slice(url.length)}`;
}

/**
 * Vite preview plugin that serves `<outDir>/foo/index.html` when the client
 * requests `/foo` (no trailing slash). Vite 7's `htmlFallbackMiddleware`
 * only handles trailing-slash directory paths and `.html` extensions; in
 * SPA mode it falls back to the root `index.html` for everything else,
 * which makes Astro-generated marketing pages (`dist/welcome/index.html`)
 * unreachable at `/welcome` unless the client appends a slash. This plugin
 * bridges the gap so preview matches Cloudflare Pages' directory-index
 * behavior in production.
 */
export function previewDirectoryIndexFallback(): Plugin {
  return {
    name: 'preview-directory-index-fallback',
    configurePreviewServer(server) {
      // The served directory comes from the resolved config, which is the same
      // value the preview server itself serves from — so a run pointed at
      // another output directory (`vite preview --outDir`) matches against what
      // is actually on disk there rather than against a second, fixed path.
      const distributionDir = path.resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, _res, next) => {
        const fullUrl = req.url ?? '';
        const rewritten = rewriteForDirectoryIndex(fullUrl, distributionDir);
        if (rewritten !== null) req.url = rewritten;
        next();
      });
    },
  };
}
