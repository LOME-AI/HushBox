import { existsSync } from 'node:fs';
import path from 'node:path';
// Reached by source path rather than as `@hushbox/shared`, the way the other
// build-time readers of this constant reach it (`scripts/generate-headers.ts`,
// `apps/marketing/astro.config.preview.mjs`): the package publishes no subpath
// for this module, so no bare specifier names it.
import { ADMIN_PREVIEW_PREFIX } from '../../../../packages/shared/src/growth/admin-preview.ts';

/** The name the rule's plugin registers under in the admin build config. */
export const MARKETING_PREVIEW_INDEX_PLUGIN_NAME = 'marketing-preview-directory-index';

const PREVIEW_ROOT = `/${ADMIN_PREVIEW_PREFIX}/`;
const INDEX_FILE = 'index.html';

/** All the rule needs of a request: the URL it may replace. */
export interface RewritableRequest {
  url?: string | undefined;
}

/** A Connect handler narrowed to what the rule touches. */
export type PreviewIndexHandler = (
  request: RewritableRequest,
  response: unknown,
  next: () => void
) => void;

/**
 * What the plugin needs of the server it installs on. `ViteDevServer`
 * satisfies it, so the hook takes this instead and a test can drive the real
 * plugin with a plain object rather than a cast-up stand-in for a live server.
 */
export interface ServedPublicDirectory {
  readonly config: { readonly publicDir: string };
  readonly middlewares: { use: (handler: PreviewIndexHandler) => unknown };
}

/**
 * The decoded path segments of the page a directory request names, or `null`
 * where any of them is a segment no file-system lookup should be handed:
 * empty (the bare prefix and a doubled slash both land here), `.`, `..`, or
 * undecodable.
 */
function pageSegments(inner: string): readonly string[] | null {
  const segments: string[] = [];
  for (const raw of inner.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded === '' || decoded === '.' || decoded === '..') return null;
    segments.push(decoded);
  }
  return segments;
}

/**
 * The rewritten request URL for a directory request under the preview prefix —
 * the marketing copy's page is `<page>/index.html`, the only file the copy puts
 * under that prefix — or `null` for a request the rule declines.
 *
 * Declined: anything outside the prefix, the slash-less form (which the
 * preview server also answers with the admin shell, so the two servers agree
 * there), anything {@link pageSegments} refuses, and a page whose index file is
 * absent.
 */
export function rewriteToPreviewIndex(
  fullUrl: string,
  publicDir: string,
  fileExists: (filePath: string) => boolean = existsSync
): string | null {
  const queryAt = fullUrl.indexOf('?');
  const pathname = queryAt === -1 ? fullUrl : fullUrl.slice(0, queryAt);
  if (!pathname.startsWith(PREVIEW_ROOT) || !pathname.endsWith('/')) return null;

  const page = pageSegments(pathname.slice(PREVIEW_ROOT.length, -1));
  if (page === null) return null;
  if (!fileExists(path.resolve(publicDir, ADMIN_PREVIEW_PREFIX, ...page, INDEX_FILE))) return null;

  return `${pathname}${INDEX_FILE}${queryAt === -1 ? '' : fullUrl.slice(queryAt)}`;
}

/**
 * The development server's rule for the copied marketing pages: a directory
 * request under the preview prefix is answered with that directory's index
 * file, which is what makes the development server agree with the preview
 * server and production about the URL the click overlay frames.
 *
 * Without it the development server answers that URL with the admin shell:
 * its static-file middleware matches exact file paths, and its
 * single-page-application fallback searches the application root rather than
 * the public directory the copy lives in.
 *
 * Not the same rule as `apps/web`'s `previewDirectoryIndexFallback`, and not
 * shareable with it: that one runs on a preview server, over the build output
 * directory, and rewrites the **slash-less** form, which Vite's own
 * html-fallback middleware already resolves in preview and which must keep
 * reaching the shell here. The two can drift without either breaking.
 *
 * `configureServer`'s body runs before Vite installs the proxy, the
 * static-file middleware and the single-page-application fallback, so the rule
 * sees a request ahead of all three — which is the ordering it depends on. Its
 * position among the config's other plugins is not load-bearing: the rewrite
 * is invisible to anything that does not read the preview prefix.
 */
export function marketingPreviewIndexPlugin(): {
  name: string;
  apply: 'serve';
  configureServer: (server: ServedPublicDirectory) => void;
} {
  return {
    name: MARKETING_PREVIEW_INDEX_PLUGIN_NAME,
    apply: 'serve',
    configureServer(server) {
      const { publicDir } = server.config;
      server.middlewares.use((request, _response, next) => {
        const { url } = request;
        if (url !== undefined) {
          const rewritten = rewriteToPreviewIndex(url, publicDir);
          if (rewritten !== null) request.url = rewritten;
        }
        next();
      });
    },
  };
}
