#!/usr/bin/env tsx
// eslint-disable-next-line comments/resolvable-cross-reference -- the cited file is build output this script writes and git ignores, so the citation is correct and resolves only after a build
/** Generate `apps/web/dist/_headers` for the merged Cloudflare Pages deploy.
 *
 * For each prefix in `MARKETING_ROUTES`, walks `apps/web/dist/<prefix>/` for
 * built `index.html` files, computes the SHA-256 of every inline `<script>`
 * body, and emits a per-path `_headers` block whose `script-src` carries
 * those hashes inline. The SPA `/*` block is emitted FIRST; each per-path
 * block then unsets and re-sets every header so Cloudflare serves exactly one
 * (hashed) CSP per marketing path instead of appending a second policy.
 *
 * Why hash from HTML directly (not from Astro's meta tag): Astro's
 * `experimental.csp` only hashes scripts Astro itself emits and skips
 * `<script is:inline>` blocks authored in `.astro` files — see the comment
 * in `apps/marketing/astro.config.mjs`. Hashing every inline script in the
 * built HTML catches both classes uniformly.
 *
 * Style hashes are NOT emitted: that would invalidate `'unsafe-inline'`,
 * which is required for Tailwind's runtime style insertion and for inline
 * `style="..."` attributes (e.g. ThemeToggle SVG transitions, plus the
 * Shiki incompatibility documented in `apps/marketing/astro.config.mjs`).
 *
 * Single source of truth for the marketing route list:
 *   packages/shared/src/platform/routes.ts → MARKETING_ROUTES
 *
 * Called from:
 *   - `.github/workflows/ci.yml`   (after merge-marketing-into-web)
 *   - `playwright.config.ts`      (web server command chain)
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSandboxOrigin } from '@hushbox/shared/sandbox-origin';
import { ADMIN_PREVIEW_PREFIX } from '../packages/shared/src/growth/admin-preview.ts';
import { MARKETING_ROUTES, ROUTES } from '../packages/shared/src/platform/routes.ts';
import { isMainModule } from './lib/cli/is-main.ts';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.ts';
import { runMain } from './lib/cli/run-main.ts';
import type { Dirent } from 'node:fs';

interface GenerateHeadersOptions {
  readonly repoRoot: string;
  /** Override the dist directory (defaults to {@link DEFAULT_DIST}). For tests. */
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
  /**
   * Local MinIO/R2 emulator port for dev + E2E builds. Defaults to
   * `process.env.HB_MINIO_API_PORT` (written to the scripts env file by
   * `scripts/generate-env.ts`, allocated per slot by
   * `scripts/lib/stack/port-plan.ts`). When omitted *and* the
   * env var is unset, no MinIO origin is added — that's the production
   * path, where R2 reads go through the `https://*.r2.cloudflarestorage.com`
   * wildcard already baked into connect-src.
   */
  readonly minioApiPort?: string;
  /**
   * The document sandbox origin the app-origin CSP `frame-src` must allow, so
   * the app can embed the cross-origin renderer iframe. Defaults to
   * `process.env.SANDBOX_ORIGIN_URL` (a build-time value written to the scripts
   * env file by `scripts/generate-env.ts`, per-mode: the local dev server in
   * dev/E2E, `https://sandbox.hushbox.ai` in production). Absence fail-fasts
   * — every mode must name the sandbox origin, there is no fallback.
   */
  readonly sandboxOrigin?: string;
}

interface GenerateHeadersResult {
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
 * HSTS for both static origins, the apex and `admin.hushbox.ai`. Two years,
 * `includeSubDomains`: every web-serving `*.hushbox.ai` host is HTTPS-only, so a
 * protocol downgrade must never reach a page where a password or recovery phrase
 * is typed. No `preload`: the preload list is a semi-irreversible commitment left
 * to a separate founder decision, the same deferral the API's security-headers
 * middleware records.
 */
const HSTS = 'max-age=63072000; includeSubDomains';

// eslint-disable-next-line comments/resolvable-cross-reference -- the path names the file this generator replaced, so its absence is the fact the sentence records and no resolving reference to it exists
/** Header block applied to every SPA route. Mirrors what lived in `apps/web/public/_headers`
 * before this generator replaced it, with the API origin templated so
 * dev/preview builds (localhost) and production builds (api.hushbox.ai) both
 * produce a CSP that matches their built VITE_API_URL. Without this, e2e under
 * vite preview fails on the marketing /roadmap fetch — the page targets
 * localhost:8788 but the hardcoded CSP only allows api.hushbox.ai.
 *
 * Marketing routes get their own per-path block with hashes inlined into
 * `script-src` — see {@link formatOverrideBlock}.
 */
function buildSpaHeaders(
  apiOrigin: ApiOrigin,
  localR2Origin: string | null,
  sandboxOrigin: string
): readonly { name: string; value: string }[] {
  // Local MinIO emulator (dev/E2E only — see deriveLocalR2Origin). Prod R2
  // reads are covered by the `*.r2.cloudflarestorage.com` wildcard below;
  // localR2Origin is null on prod builds and contributes nothing.
  //
  // `https://secure.myhelcim.com` is the host for Helcim.js v2 — the
  // billing modal loads `version2.js` from it and the script POSTs the
  // card-tokenization request back to the same origin. Both directives
  // need the host or the payment form fails at mount (script-src) or at
  // submit (connect-src). See apps/web/src/lib/billing/helcim-loader.ts.
  //
  // The on-device model downloads (Kokoro TTS for the accessibility reader and
  // the blog "Listen" control) need no host of their own: every weight,
  // tokenizer, config and voice object is served by the API's own
  // model-weights route, and the onnxruntime WASM runtime is self-hosted
  // same-origin. `apiOrigin.http` below is the whole allowance they get, so a
  // model CDN appearing in this list means a loader stopped being pointed at
  // our origin.
  const connectSource = [
    "'self'",
    apiOrigin.http,
    'https://*.r2.cloudflarestorage.com',
    'https://*.r2.dev',
    'https://secure.myhelcim.com',
    apiOrigin.ws,
    ...(localR2Origin === null ? [] : [localR2Origin]),
  ].join(' ');
  return [
    {
      name: 'Content-Security-Policy',
      value:
        "default-src 'self'; " +
        // 'wasm-unsafe-eval' is REQUIRED — onnxruntime-web (pulled in by
        // kokoro-js) instantiates the WASM inference backend for on-device
        // TTS, in every mode. hash-wasm's argon2id also instantiates WASM,
        // but it is not what holds this token: it sits on three infrequent
        // non-login paths, so dropping it would leave the token required.
        //
        // 'unsafe-eval' is REQUIRED — transitive deps of the app's diagram,
        // graph and chart libraries, and of the marketing site, evaluate
        // `Function("return this")` at module init (the legacy global-this
        // polyfill from lodash/d3-era libs). Without this token, every page
        // that loads them throws CSP violations and the marketing site's
        // astro-island hydration fails outright.
        //
        // `https://secure.myhelcim.com` is the only third-party script host
        // we allow. It serves Helcim.js v2 (loaded lazily by the billing
        // modal). No wildcard — the host is named explicitly so the policy
        // can't drift into accepting arbitrary external scripts.
        "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://secure.myhelcim.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' blob: data:; " +
        "media-src 'self' blob:; " +
        `connect-src ${connectSource}; ` +
        "font-src 'self' data:; " +
        // The document renderer embeds a cross-origin sandboxed iframe served
        // from the dedicated, credential-free document sandbox origin, so that
        // origin must be an allowed frame-src. 'self' is kept because same-origin
        // framing (the /welcome page embedding the /demo SPA) previously relied
        // on the default-src 'self' fallback that this explicit directive
        // overrides — dropping it would re-block the demo iframe.
        `frame-src 'self' ${sandboxOrigin}; ` +
        "frame-ancestors 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'",
    },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
    { name: 'X-Frame-Options', value: 'DENY' },
    { name: 'Referrer-Policy', value: 'no-referrer' },
    { name: 'Strict-Transport-Security', value: HSTS },
  ];
}

/**
 * The same header stack with framing relaxed to same-origin, and nothing else
 * touched. A strict policy (`frame-ancestors 'none'` + `X-Frame-Options:
 * DENY`) blocks ALL framing, same-origin included, so a route whose whole
 * purpose is to be embedded by a page on its own origin relaxes exactly those
 * two controls; cross-origin framing stays denied, and every other directive
 * is inherited unchanged.
 *
 * It is taken, for the same reason and on different origins, by the app
 * origin's `/demo`, embedded by the marketing `/welcome` page, and by the
 * admin origin's framed marketing copy, embedded by the click overlay.
 */
function relaxFramingToSameOrigin(
  spaHeaders: readonly { name: string; value: string }[]
): readonly { name: string; value: string }[] {
  return spaHeaders.map((header) => {
    if (header.name === 'Content-Security-Policy') {
      return {
        name: header.name,
        value: header.value.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
      };
    }
    if (header.name === 'X-Frame-Options') {
      return { name: header.name, value: 'SAMEORIGIN' };
    }
    return header;
  });
}

interface ApiOrigin {
  /** HTTP origin (e.g. `https://api.hushbox.ai`, `http://localhost:8788`). */
  readonly http: string;
  /** WebSocket origin (e.g. `wss://api.hushbox.ai`, `ws://localhost:8788`). */
  readonly ws: string;
}

export function deriveApiOrigin(apiUrl: string): ApiOrigin {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(
      `VITE_API_URL is not a valid URL: "${apiUrl}". Set it in the build env or via pnpm generate:env.`
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

/**
 * Resolve the local MinIO/R2 emulator origin for dev + E2E CSP, or null
 * when no local origin should be allowlisted (production path).
 *
 * Two gates, both must pass:
 *   1. `apiOrigin.http` is a localhost URL — prod sets VITE_API_URL to
 *      `https://api.hushbox.ai`, so this trips on every prod build and
 *      prevents a stray HB_MINIO_API_PORT from leaking localhost into a
 *      production CSP.
 *   2. `minioApiPort` is a numeric string — present in dev/E2E via
 *      the scripts env file (worktree-offset; see `scripts/lib/cli/worktree.ts`),
 *      absent in prod CI/CD which injects only the GitHub Secrets it needs.
 *
 * Throws on malformed port values rather than silently producing a broken
 * URL — the build chain should fail loud, not ship a CSP that allows
 * `http://localhost:NaN`.
 */
export function deriveLocalR2Origin(apiOrigin: ApiOrigin, minioApiPort?: string): string | null {
  if (!apiOrigin.http.startsWith('http://localhost:')) return null;
  if (minioApiPort === undefined || minioApiPort === '') return null;
  if (!/^\d+$/.test(minioApiPort)) {
    throw new Error(
      `HB_MINIO_API_PORT must be a numeric port string, got "${minioApiPort}". ` +
        `It is written to the scripts env file by scripts/generate-env.ts and loaded by ` +
        `scripts/ensure-stack-cli.ts before invoking the headers generator.`
    );
  }
  return `http://localhost:${minioApiPort}`;
}

const FILE_BANNER = `# Auto-generated from scripts/generate-headers.ts — do not edit by hand.
# Source of truth for marketing route list: packages/shared/src/platform/routes.ts → MARKETING_ROUTES
# Source of truth for SPA policy: scripts/generate-headers.ts → SPA_HEADERS
#
# Marketing routes get a per-path block whose script-src lists the SHA-256 of every inline
# <script> body in the built HTML for that path. Cloudflare applies rules top-to-bottom and
# appends repeated headers, so the strict (hashless) /* block comes FIRST and each marketing
# block unsets every header before re-setting it — its hashed CSP replaces /*, not stacks on
# it. Hashing happens at the HTML level (not
# via Astro's experimental.csp) so that <script is:inline> blocks authored in .astro files
# are covered alongside Astro-emitted runtime scripts.
#
# Directive notes
#  - default-src 'self': fall-through deny for anything not enumerated below.
#  - script-src: 'self' + 'wasm-unsafe-eval' + 'unsafe-eval' + secure.myhelcim.com plus
#    per-page SHA-256 hashes on marketing routes, plus the SPA shell's own inline-script
#    hashes on the /* block (inherited by the /demo blocks). 'wasm-unsafe-eval' is required by
#    onnxruntime-web (pulled in by kokoro-js), which instantiates the WASM inference backend
#    for on-device TTS. It is NOT removable by dropping hash-wasm: argon2id instantiates WASM
#    too, but only on three infrequent non-login paths, and TTS requires the token either way.
#    Removing it leaves read-aloud failing at model load. secure.myhelcim.com
#    is the only third-party script host — the billing modal lazy-loads Helcim.js v2
#    from it for client-side card tokenization.
#  - style-src 'self' 'unsafe-inline': required by Tailwind's runtime style insertion and
#    by inline style="..." attributes (e.g. ThemeToggle SVG transitions). Shiki output —
#    if/when blog posts add code fences — also lands here and is the main reason this
#    can't be tightened today.
#  - img-src 'self' blob: data:: 'blob:' is REQUIRED — decrypted media bytes are exposed
#    to <img> tags through URL.createObjectURL(...). 'data:' covers small inline icons.
#  - media-src 'self' blob:: same reason for <video>/<audio> elements with Object URLs.
#  - connect-src 'self' + api origin + R2 hosts + secure.myhelcim.com + wss: front-end
#    fetches encrypted blobs directly from R2 via presigned URLs, posts card tokenization
#    requests to Helcim from version2.js, and opens a WebSocket to the API. The local
#    MinIO emulator at http://localhost:<HB_MINIO_API_PORT> is appended for dev/E2E
#    builds (the port is slot-offset for worktrees; see scripts/lib/cli/worktree.ts); prod builds
#    skip it since the *.r2.cloudflarestorage.com wildcard already covers prod reads.
#  - frame-src 'self' + sandbox origin: the document renderer embeds a
#    cross-origin sandboxed iframe served from the dedicated, credential-free
#    document sandbox origin (SANDBOX_ORIGIN_URL, per-mode). 'self' is retained
#    so the same-origin /demo embed keeps working — before this directive
#    existed, frames fell through to default-src 'self'.
#  - frame-ancestors 'none': belt-and-suspenders with X-Frame-Options: DENY.
#    Exception: /demo and /demo/* relax to frame-ancestors 'self' + X-Frame-Options
#    SAMEORIGIN so the marketing /welcome page can embed the demo SPA in a
#    same-origin iframe. Cross-origin framing stays denied. See
#    {@link relaxFramingToSameOrigin}.
#  - base-uri 'self', form-action 'self': close the usual base-tag and form-hijack avenues.
#  - font-src 'self' data:: locally hosted fonts plus inline data: glyphs.
`;

export async function generateHeaders(
  options: GenerateHeadersOptions
): Promise<GenerateHeadersResult> {
  const distributionDir = path.resolve(options.repoRoot, options.distRelativePath ?? DEFAULT_DIST);
  const outputPath = path.resolve(options.repoRoot, options.outputRelativePath ?? DEFAULT_OUTPUT);
  // Option-over-env layering, not a fallback default: an explicit option wins,
  // the env var is the normal source, and absence fail-fasts (apiUrl) or is a
  // designed legal state (minioApiPort — prod builds omit the MinIO origin).
  const envApiUrl = process.env['VITE_API_URL'];
  const apiUrl = options.apiUrl ?? envApiUrl;
  if (!apiUrl) {
    throw new Error(
      `VITE_API_URL must be set (got undefined). The generated CSP's connect-src ` +
        `must match the API origin the marketing app was built against.`
    );
  }
  const apiOrigin = deriveApiOrigin(apiUrl);
  const envMinioApiPort = process.env['HB_MINIO_API_PORT'];
  const minioApiPort = options.minioApiPort ?? envMinioApiPort;
  const localR2Origin = deriveLocalR2Origin(apiOrigin, minioApiPort);
  // The app-origin `frame-src` must allow the document sandbox origin, so an
  // absent or unusable value fails the build rather than emitting a policy that
  // silently refuses to frame the renderer.
  const sandboxOrigin = resolveSandboxOrigin(
    options.sandboxOrigin ?? process.env['SANDBOX_ORIGIN_URL']
  );

  await assertDirectory(distributionDir);
  const pages = await findMarketingPages(distributionDir);
  /* v8 ignore next 6 -- defensive: MARKETING_ROUTES is non-empty, so findMarketingPages either throws or returns ≥1 page */
  if (pages.length === 0) {
    throw new Error(
      `No marketing pages found under ${distributionDir} for routes ${MARKETING_ROUTES.join(', ')}. ` +
        `Did the marketing build run before this script?`
    );
  }

  // The SPA shell (dist/index.html) ships its own pre-paint inline scripts
  // (theme-flash + a11y-init); the /* block — and the /demo blocks derived from
  // it — must carry their SHA-256 hashes or the strict hashless script-src
  // blocks them on every SPA route. Folded in after the marketing-page
  // validation above so a missing/broken build fails on the clearer
  // dist/marketing errors first.
  const spaHeaders = await inlineSpaShellHashes(
    distributionDir,
    buildSpaHeaders(apiOrigin, localR2Origin, sandboxOrigin)
  );

  // `/*` first: Cloudflare applies rules top-to-bottom, and a per-path
  // `! Content-Security-Policy` only deletes a CSP an earlier rule set. With
  // `/*` last, its hashless CSP would append after the per-path block and the
  // browser's intersection of the two policies blocks every inline script.
  const blocks: string[] = [formatSpaBlock(spaHeaders), formatServiceWorkerBlock()];
  // The interactive product demo runs the SPA in an <iframe> on the
  // same-origin marketing /welcome page; /demo + /demo/* relax the strict
  // frame headers to same-origin only. Emitted right after `/*` so their
  // unsets strip the strict values before re-setting the relaxed ones.
  const demoHeaders = relaxFramingToSameOrigin(spaHeaders);
  blocks.push(
    formatOverrideBlock(ROUTES.DEMO, spaHeaders, demoHeaders),
    formatOverrideBlock(`${ROUTES.DEMO}/*`, spaHeaders, demoHeaders)
  );
  for (const page of pages) {
    const html = await fs.readFile(page.htmlFile, 'utf8');
    const csp = computePageCsp(html);
    // Cloudflare Pages serves Astro's `<route>/index.html` at `/route/`
    // (trailing slash, after a 308 from `/route`); its `_headers` matcher
    // is exact-match per path. Emit blocks at BOTH forms — otherwise the
    // hashed CSP attaches only to the 308 redirect and the HTML response
    // falls through to the SPA `/*` block with no script-src hashes,
    // blocking every inline Astro hydration script.
    const hashed = foldPageHashes(spaHeaders, csp);
    blocks.push(
      formatOverrideBlock(page.urlPath, spaHeaders, hashed),
      formatOverrideBlock(`${page.urlPath}/`, spaHeaders, hashed)
    );
  }

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

async function readRouteEntries(routeDir: string, route: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(routeDir, { withFileTypes: true, recursive: true });
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
}

function entryToPage(entry: Dirent, distributionDir: string): MarketingPage {
  const directoryOfIndex = entry.parentPath;
  const relativePath = path.relative(distributionDir, directoryOfIndex).split(path.sep).join('/');
  return {
    urlPath: `/${relativePath}`,
    htmlFile: path.join(directoryOfIndex, entry.name),
  };
}

async function findMarketingPages(distributionDir: string): Promise<MarketingPage[]> {
  const pages: MarketingPage[] = [];
  for (const route of MARKETING_ROUTES) {
    const prefix = route.replace(/^\//, '');
    const routeDir = path.join(distributionDir, prefix);
    const entries = await readRouteEntries(routeDir, route);
    const indexEntries = entries.filter((e) => e.isFile() && e.name === 'index.html');
    if (indexEntries.length === 0) {
      throw new Error(
        `Marketing route ${route} produced no index.html under ${routeDir}. ` +
          `Did the Astro build complete?`
      );
    }
    for (const entry of indexEntries) {
      pages.push(entryToPage(entry, distributionDir));
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
    /* v8 ignore next -- the regex's capture group always matches (possibly empty) script body text */
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

/**
 * Fold the SPA shell's inline-script SHA-256 hashes into the `/*` CSP. The shell
 * (dist/index.html) serves theme-flash + a11y-init inline scripts that must run
 * before first paint; without their hashes the strict script-src blocks them on
 * every SPA route. Returns headers unchanged when the shell has no inline
 * scripts. The /demo blocks derive from the returned headers and inherit them.
 */
async function readShellHtml(distributionDir: string, appLabel: string): Promise<string> {
  const shellPath = path.join(distributionDir, 'index.html');
  try {
    return await fs.readFile(shellPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `SPA shell not found at ${shellPath}. The ${appLabel} build must emit index.html before headers are generated.`
      );
    }
    throw error;
  }
}

async function inlineSpaShellHashes(
  distributionDir: string,
  headers: readonly { name: string; value: string }[]
): Promise<readonly { name: string; value: string }[]> {
  const shellHtml = await readShellHtml(distributionDir, 'web');
  return foldPageHashes(headers, computePageCsp(shellHtml));
}

/**
 * A per-path block that replaces what the site-wide `/*` block set.
 *
 * `/*` is emitted first and Cloudflare appends a repeated header rather than
 * replacing it, so every header the block re-sets must be unset first. Without
 * the unset the response carries two values — for a CSP, two policies the
 * browser intersects, which is how a relaxed frame policy gets silently
 * intersected back to `frame-ancestors 'none'` and how a hashed `script-src`
 * gets intersected back to a hashless one.
 *
 * @param replaced every header the site-wide block set, unset by name.
 * @param applied what this path serves instead.
 */
function formatOverrideBlock(
  urlPath: string,
  replaced: readonly { name: string; value: string }[],
  applied: readonly { name: string; value: string }[]
): string {
  const lines: string[] = [urlPath];
  for (const header of replaced) {
    lines.push(`  ! ${header.name}`);
  }
  for (const header of applied) {
    lines.push(`  ${header.name}: ${header.value}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The same headers with one page's inline-script hashes folded into `script-src`. */
function foldPageHashes(
  headers: readonly { name: string; value: string }[],
  csp: PageCsp
): readonly { name: string; value: string }[] {
  return headers.map((header) =>
    header.name === 'Content-Security-Policy'
      ? { name: header.name, value: inlineHashesIntoSpaCsp(header.value, csp) }
      : header
  );
}

/**
 * No-cache block for the push-only service worker. It ships at a stable,
 * unhashed `/sw.js` (the URL is the SW's identity), so the browser must
 * revalidate it on every load — without this, a deployed SW change could never
 * reach an installed client holding a cached copy. The `/*` block sets no
 * `Cache-Control`, so appending this one adds the directive without a conflict.
 */
function formatServiceWorkerBlock(): string {
  return '/sw.js\n  Cache-Control: no-cache\n';
}

function formatSpaBlock(spaHeaders: readonly { name: string; value: string }[]): string {
  const lines: string[] = ['/*'];
  for (const header of spaHeaders) {
    lines.push(`  ${header.name}: ${header.value}`);
  }
  return `${lines.join('\n')}\n`;
}

function inlineHashesIntoSpaCsp(baseCsp: string, csp: PageCsp): string {
  const directives = baseCsp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
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

/**
 * Security headers for the admin SPA (`admin.hushbox.ai`). The admin app is
 * fully same-origin: it fetches only relative `/api/*` (routed to the product
 * Worker), loads no third-party scripts, no R2/blob media, and needs no WASM or
 * eval. So every fetch/asset directive collapses to `'self'` — the tightest CSP
 * that still runs the SPA, the SQL panel, and the Customer-360 fetches, which
 * are all same-origin XHR. Inline-script hashes are folded into `script-src` by
 * `generateAdminHeaders`.
 */
function buildAdminSpaHeaders(): readonly { name: string; value: string }[] {
  const csp =
    "default-src 'self'; " +
    // No 'unsafe-eval'/'wasm-unsafe-eval' (unlike the web SPA): admin bundles no
    // crypto/WASM and no eval-using deps. Only 'self' plus the pre-paint
    // inline-script hashes appended by generateAdminHeaders.
    "script-src 'self'; " +
    // 'unsafe-inline' for STYLES only — Tailwind's runtime style insertion and
    // inline style="" attributes; hashing styles would break Tailwind.
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self' data:; " +
    // Same-origin API only. The Vite dev/preview proxy also serves /api from the
    // page origin, so 'self' holds in dev, preview, and production alike.
    "connect-src 'self'; " +
    // Admin must never be framed — belt to X-Frame-Options: DENY's suspenders.
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'";
  return [
    { name: 'Content-Security-Policy', value: csp },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
    { name: 'X-Frame-Options', value: 'DENY' },
    { name: 'Referrer-Policy', value: 'no-referrer' },
    { name: 'Strict-Transport-Security', value: HSTS },
  ];
}

const ADMIN_FILE_BANNER = `# Auto-generated by scripts/generate-headers.ts — do not edit by hand.
# Admin SPA (admin.hushbox.ai) security headers. The /* block carries the whole
# policy; the admin app is a standalone same-origin SPA, so it is the only block
# unless the framed marketing copy is present, which adds a per-page block under
# its own prefix and changes nothing outside it.
# Directive rationale lives in buildAdminSpaHeaders (scripts/generate-headers.ts).`;

interface GenerateAdminHeadersOptions {
  /** Absolute path to the built admin dist directory (contains index.html). */
  readonly distDir: string;
  /** Override the output file (defaults to `<distDir>/_headers`). */
  readonly outputPath?: string;
}

interface GenerateAdminHeadersResult {
  readonly outputPath: string;
}

/**
 * Emit `<distDir>/_headers` for the admin assets Worker. Reads the built admin
 * shell, folds its pre-paint inline-script SHA-256 hashes into `script-src`, and
 * writes a single `/*` block. Cloudflare Workers static assets honor `_headers`
 * the same way Pages does, so the assets-only admin Worker serves these headers
 * on every response. Wired into `apps/admin/vite.config.ts` as a build-time
 * plugin so a plain `vite build` produces the file alongside the bundle.
 */
/**
 * The pages of the framed marketing copy, if the admin build carries one.
 *
 * Absence is a legal state rather than an error: the copy arrives through a
 * build task, and a bundler run on its own emits an admin origin with no
 * preview in it. What that costs is a preview nobody can frame, which the
 * admin end-to-end suite is what notices — not a header file that is wrong
 * about the origin it describes.
 */
async function findAdminPreviewPages(distributionDir: string): Promise<MarketingPage[]> {
  const previewDir = path.join(distributionDir, ADMIN_PREVIEW_PREFIX);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(previewDir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name === 'index.html')
    .map((entry) => entryToPage(entry, distributionDir))
    .toSorted((left, right) => left.urlPath.localeCompare(right.urlPath));
}

/** The same headers with a CSP `sandbox` that withholds script but keeps the origin. */
function sandboxKeepingOrigin(
  headers: readonly { name: string; value: string }[]
): readonly { name: string; value: string }[] {
  return headers.map((header) =>
    header.name === 'Content-Security-Policy'
      ? { name: header.name, value: `${header.value}; sandbox allow-same-origin` }
      : header
  );
}

export async function generateAdminHeaders(
  options: GenerateAdminHeadersOptions
): Promise<GenerateAdminHeadersResult> {
  const outputPath = options.outputPath ?? path.join(options.distDir, '_headers');
  const shellHtml = await readShellHtml(options.distDir, 'admin');
  const adminHeaders = buildAdminSpaHeaders();
  const headers = foldPageHashes(adminHeaders, computePageCsp(shellHtml));

  // The copy of the marketing site the click overlay frames. It is served by
  // this origin, so it takes this origin's policy — relaxed in exactly two
  // controls, and only under its own prefix, so every other admin route keeps
  // the framing denial the `/*` block above states.
  //
  // No page's inline-script hashes are folded in: the overlay frames the copy
  // sandboxed with no permission to run script, because a script on it would
  // act with the operator's authority on this origin. The overlay reads the
  // page's built markup, which is the same set of links and buttons the
  // click-name index is extracted from, so what it can badge needs no script.
  // Derived from the unhashed admin policy, not from the `/*` block above,
  // which carries the admin shell's hashes for scripts a copied page does not
  // contain.
  //
  // The frame's own sandbox attribute does not reach a copy loaded top-level —
  // through the overlay's new-tab link or a typed URL — so the policy sandboxes
  // the copy too. `allow-same-origin` stays because the overlay reads the framed
  // document; a frame sandboxed the same way gets the same set either way.
  const framed = sandboxKeepingOrigin(relaxFramingToSameOrigin(adminHeaders));
  const blocks: string[] = [formatSpaBlock(headers)];
  for (const page of await findAdminPreviewPages(options.distDir)) {
    // Keyed at the trailing-slash form only, unlike the marketing loop above:
    // this origin serves an SPA, so the slash-less form falls through to the
    // shell rather than redirecting to the copy. A block there would relax
    // framing on an admin document, which is what the `/*` denial exists to
    // prevent.
    blocks.push(formatOverrideBlock(`${page.urlPath}/`, headers, framed));
  }

  const content = `${ADMIN_FILE_BANNER}\n${blocks.join('\n')}`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, 'utf8');
  return { outputPath };
}

export const COMMAND_LINE = {
  command: 'tsx scripts/generate-headers.ts',
  summary: 'Writes the CSP `_headers` file for the merged Pages deploy.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via shell */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
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
