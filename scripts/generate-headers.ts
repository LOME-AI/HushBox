#!/usr/bin/env tsx
/**
 * Generate `apps/web/dist/_headers` for the merged Cloudflare Pages deploy.
 *
 * For each prefix in `MARKETING_ROUTES`, walks `apps/web/dist/<prefix>/` for
 * built `index.html` files, computes the SHA-256 of every inline `<script>`
 * body, and emits a per-path `_headers` block whose `script-src` carries
 * those hashes inline. The SPA `/*` block is appended at the end,
 * byte-equivalent to the policy this repo shipped before this fix.
 *
 * Why hash from HTML directly (not from Astro's meta tag): Astro's
 * `experimental.csp` only hashes scripts Astro itself emits and skips
 * `<script is:inline>` blocks authored in `.astro` files — see the comment
 * in `apps/marketing/astro.config.mjs`. Hashing every inline script in the
 * built HTML catches both classes uniformly.
 *
 * Style hashes are NOT emitted: that would invalidate `'unsafe-inline'`,
 * which is required for Tailwind's runtime style insertion and for inline
 * `style="..."` attributes (e.g. ThemeToggle SVG transitions, see the
 * Shiki TODO in `apps/marketing/astro.config.mjs`).
 *
 * Single source of truth for the marketing route list:
 *   packages/shared/src/routes.ts → MARKETING_ROUTES
 *
 * Called from:
 *   - `.github/workflows/ci.yml`        (after merge-marketing-into-web)
 *   - `.github/workflows/release.yml`   (after merge-marketing-into-web)
 *   - `playwright.config.ts`            (web server command chain)
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETING_ROUTES } from '../packages/shared/src/routes.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export interface GenerateHeadersOptions {
  readonly repoRoot: string;
  /** Override the dist directory (defaults to `apps/web/dist`). For tests. */
  readonly distRelativePath?: string;
  /** Override the output file (defaults to `<dist>/_headers`). For tests. */
  readonly outputRelativePath?: string;
  /**
   * The API origin the marketing app was built against (the value of
   * VITE_API_URL at build time). Defaults to `process.env.VITE_API_URL`.
   * Must match the URL the client bundles will actually fetch from, or the
   * generated CSP will block those fetches.
   */
  readonly apiUrl?: string;
}

export interface GenerateHeadersResult {
  readonly outputPath: string;
  readonly pagesProcessed: number;
  readonly blocksEmitted: number;
}

interface MarketingPage {
  readonly urlPath: string;
  readonly htmlFile: string;
}

interface PageCsp {
  readonly scriptHashes: readonly string[];
}

const DEFAULT_DIST = 'apps/web/dist';
const DEFAULT_OUTPUT = `${DEFAULT_DIST}/_headers`;

/**
 * Header block applied to every SPA route. Mirrors what lived in
 * `apps/web/public/_headers` before this generator replaced it, with the
 * API origin templated so dev/preview builds (localhost) and production
 * builds (api.hushbox.ai) both produce a CSP that matches their built
 * VITE_API_URL. Without this, e2e under vite preview fails on the
 * marketing /roadmap fetch — the page targets localhost:8787 but the
 * hardcoded CSP only allows api.hushbox.ai.
 *
 * Marketing routes get their own per-path block with hashes inlined into
 * `script-src` — see `formatMarketingBlock`.
 */
function buildSpaHeaders(apiOrigin: ApiOrigin): readonly { name: string; value: string }[] {
  return [
    {
      name: 'Content-Security-Policy',
      value:
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        'img-src \'self\' blob: data:; ' +
        'media-src \'self\' blob:; ' +
        `connect-src 'self' ${apiOrigin.http} https://*.r2.cloudflarestorage.com https://*.r2.dev ${apiOrigin.ws}; ` +
        "font-src 'self' data:; " +
        "frame-ancestors 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'",
    },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
    { name: 'X-Frame-Options', value: 'DENY' },
    { name: 'Referrer-Policy', value: 'no-referrer' },
  ];
}

interface ApiOrigin {
  /** HTTP origin (e.g. `https://api.hushbox.ai`, `http://localhost:8787`). */
  readonly http: string;
  /** WebSocket origin (e.g. `wss://api.hushbox.ai`, `ws://localhost:8787`). */
  readonly ws: string;
}

export function deriveApiOrigin(apiUrl: string): ApiOrigin {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(
      `VITE_API_URL is not a valid URL: "${apiUrl}". Set it in the build env or .env.development.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`VITE_API_URL must use http or https, got "${parsed.protocol}"`);
  }
  const wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    http: parsed.origin,
    ws: `${wsScheme}//${parsed.host}`,
  };
}

const FILE_BANNER = `# Auto-generated from scripts/generate-headers.ts — do not edit by hand.
# Source of truth for marketing route list: packages/shared/src/routes.ts → MARKETING_ROUTES
# Source of truth for SPA policy: scripts/generate-headers.ts → SPA_HEADERS
#
# Marketing routes get a per-path block whose script-src lists the SHA-256 of every inline
# <script> body in the built HTML for that path. The SPA /* block at the end stays strict
# without any hashes. Hashing happens at the HTML level (not via Astro's experimental.csp)
# so that <script is:inline> blocks authored in .astro files are covered alongside
# Astro-emitted runtime scripts.
#
# Directive notes
#  - default-src 'self': fall-through deny for anything not enumerated below.
#  - script-src: 'self' plus per-page SHA-256 hashes on marketing routes. SPA route stays
#    'self' alone since the SPA serves no inline scripts.
#  - style-src 'self' 'unsafe-inline': required by Tailwind's runtime style insertion and
#    by inline style="..." attributes (e.g. ThemeToggle SVG transitions). Shiki output —
#    if/when blog posts add code fences — also lands here and is the main reason this
#    can't be tightened today. See apps/marketing/astro.config.mjs TODO.
#  - img-src 'self' blob: data:: 'blob:' is REQUIRED — decrypted media bytes are exposed
#    to <img> tags through URL.createObjectURL(...). 'data:' covers small inline icons.
#  - media-src 'self' blob:: same reason for <video>/<audio> elements with Object URLs.
#  - connect-src 'self' + api.hushbox.ai + R2 hosts + wss: front-end fetches encrypted
#    blobs directly from R2 via presigned URLs and opens a WebSocket to the API.
#  - frame-ancestors 'none': belt-and-suspenders with X-Frame-Options: DENY.
#  - base-uri 'self', form-action 'self': close the usual base-tag and form-hijack avenues.
#  - font-src 'self' data:: locally hosted fonts plus inline data: glyphs.
`;

export async function generateHeaders(
  options: GenerateHeadersOptions
): Promise<GenerateHeadersResult> {
  const distDir = path.resolve(options.repoRoot, options.distRelativePath ?? DEFAULT_DIST);
  const outputPath = path.resolve(options.repoRoot, options.outputRelativePath ?? DEFAULT_OUTPUT);
  const apiUrl = options.apiUrl ?? process.env['VITE_API_URL'];
  if (!apiUrl) {
    throw new Error(
      `VITE_API_URL must be set (got undefined). The generated CSP's connect-src ` +
        `must match the API origin the marketing app was built against.`
    );
  }
  const apiOrigin = deriveApiOrigin(apiUrl);
  const spaHeaders = buildSpaHeaders(apiOrigin);

  await assertDirectory(distDir);
  const pages = await findMarketingPages(distDir);
  if (pages.length === 0) {
    throw new Error(
      `No marketing pages found under ${distDir} for routes ${MARKETING_ROUTES.join(', ')}. ` +
        `Did the marketing build run before this script?`
    );
  }

  const blocks: string[] = [];
  for (const page of pages) {
    const html = await fs.readFile(page.htmlFile, 'utf8');
    const csp = computePageCsp(html);
    blocks.push(formatMarketingBlock(page.urlPath, csp, spaHeaders));
  }

  blocks.push(formatSpaBlock(spaHeaders));

  const fileContent = `${FILE_BANNER}\n${blocks.join('\n')}`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, fileContent, 'utf8');

  return { outputPath, pagesProcessed: pages.length, blocksEmitted: blocks.length };
}

async function assertDirectory(directory: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Web dist directory does not exist at ${directory}. ` +
          `Build apps before generating headers (pnpm build && tsx scripts/merge-marketing-into-web.ts).`
      );
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Expected ${directory} to be a directory`);
  }
}

async function findMarketingPages(distDir: string): Promise<MarketingPage[]> {
  const pages: MarketingPage[] = [];
  for (const route of MARKETING_ROUTES) {
    const prefix = route.replace(/^\//, '');
    const routeDir = path.join(distDir, prefix);
    let entries;
    try {
      entries = await fs.readdir(routeDir, { withFileTypes: true, recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Marketing route ${route} has no built directory at ${routeDir}.\n` +
            `Run the build + merge chain first:\n` +
            `  pnpm --filter @hushbox/marketing build\n` +
            `  pnpm --filter @hushbox/web build\n` +
            `  pnpm tsx scripts/merge-marketing-into-web.ts\n` +
            `  pnpm generate:headers\n` +
            `(If you only changed marketing content, the marketing build + merge is enough.)`
        );
      }
      throw error;
    }
    let foundForRoute = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== 'index.html') continue;
      const directoryOfIndex = entry.parentPath;
      const relPath = path.relative(distDir, directoryOfIndex).split(path.sep).join('/');
      const urlPath = `/${relPath}`;
      pages.push({ urlPath, htmlFile: path.join(directoryOfIndex, entry.name) });
      foundForRoute++;
    }
    if (foundForRoute === 0) {
      throw new Error(
        `Marketing route ${route} produced no index.html under ${routeDir}. ` +
          `Did the Astro build complete?`
      );
    }
  }
  return pages;
}

// Match each `<script>` element that does NOT have a `src=` attribute on the
// opening tag. The content is the (possibly empty) body up to `</script>`.
// `[\s\S]` lets `.` match newlines without the `s` flag.
const INLINE_SCRIPT_REGEX = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function computePageCsp(html: string): PageCsp {
  const scriptHashes: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT_REGEX)) {
    const body = match[1] ?? '';
    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    const token = `'sha256-${digest}'`;
    if (!seen.has(token)) {
      seen.add(token);
      scriptHashes.push(token);
    }
  }
  return { scriptHashes };
}

function formatMarketingBlock(
  urlPath: string,
  csp: PageCsp,
  spaHeaders: readonly { name: string; value: string }[]
): string {
  const lines: string[] = [urlPath];
  for (const header of spaHeaders) {
    const value =
      header.name === 'Content-Security-Policy'
        ? inlineHashesIntoSpaCsp(header.value, csp)
        : header.value;
    lines.push(`  ${header.name}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatSpaBlock(spaHeaders: readonly { name: string; value: string }[]): string {
  const lines: string[] = ['/*'];
  for (const header of spaHeaders) {
    lines.push(`  ${header.name}: ${header.value}`);
  }
  return `${lines.join('\n')}\n`;
}

function inlineHashesIntoSpaCsp(baseCsp: string, csp: PageCsp): string {
  const directives = baseCsp.split(';').map((d) => d.trim()).filter(Boolean);
  return directives
    .map((directive) => {
      if (directive.toLowerCase().startsWith('script-src')) {
        return appendHashes(directive, csp.scriptHashes);
      }
      return directive;
    })
    .join('; ');
}

function appendHashes(directive: string, hashes: readonly string[]): string {
  if (hashes.length === 0) return directive;
  return `${directive} ${hashes.join(' ')}`;
}

/* v8 ignore start -- CLI entry point exercised via shell */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const result = await generateHeaders({ repoRoot });
    console.log(
      `Wrote ${result.outputPath} (${String(result.pagesProcessed)} marketing pages, ${String(
        result.blocksEmitted
      )} blocks)`
    );
  });
}
/* v8 ignore stop */
