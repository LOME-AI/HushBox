import fs from 'node:fs';
import path from 'node:path';

import { generatedFilesAmong } from '../../lib/is-generated.mjs';

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output',
  '.svelte-kit', '__pycache__', '.turbo', '.vercel',
]);

const SCANNABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.jsx', '.tsx', '.js', '.ts',
  '.vue', '.svelte', '.astro',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function collectScannableFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectScannableFiles(full));
    else if (SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

/**
 * Every source file under `dir` a reader could act on, and every one the walk
 * left out.
 *
 * A generated file is left out. It is a copy of something else — a bundled
 * stylesheet lands in every artifact directory a build writes — so reporting on
 * it says the same thing about the same source once per copy, and an edit to
 * the file it names is erased by the next build. Which files those are is
 * {@link generatedFilesAmong}'s question, asked once for the whole walk rather
 * than once per file.
 *
 * Both halves are returned because the caller cannot re-derive the second: by
 * the time it holds the files it may scan, the ones it may not are gone, and a
 * walk that skipped everything is spelled exactly like a directory with nothing
 * in it. A caller reporting the one as the other is why this is the walk's
 * answer rather than its private business.
 *
 * Only the walk is scoped. A path named on the command line is scanned whatever
 * this would say about it: asking about one file is a statement that the file
 * is the subject, and no directory listing decided it.
 *
 * @param {string} dir
 * @returns {{ files: string[], generated: string[] }}
 */
function walkScope(dir) {
  const walked = collectScannableFiles(dir);
  const generated = generatedFilesAmong(walked);
  return {
    files: walked.filter((file) => !generated.has(file)),
    generated: walked.filter((file) => generated.has(file)),
  };
}

/**
 * The files {@link walkScope} hands on, for a caller with nothing to say about
 * the ones it left out.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walkDir(dir) {
  return walkScope(dir).files;
}


// ---------------------------------------------------------------------------
// Import graph (multi-file awareness)
// ---------------------------------------------------------------------------

/**
 * @param {string} specifier
 * @param {string} fromDir
 * @param {ReadonlySet<string>} fileSet
 * @returns {string | null}
 */
function resolveImport(specifier, fromDir, fileSet) {
  if (!/^[./]/.test(specifier)) return null; // skip bare specifiers
  const base = path.resolve(fromDir, specifier);
  if (fileSet.has(base)) return base;
  for (const ext of SCANNABLE_EXTENSIONS) {
    const withExt = base + ext;
    if (fileSet.has(withExt)) return withExt;
  }
  // index file convention
  for (const ext of SCANNABLE_EXTENSIONS) {
    const indexFile = path.join(base, 'index' + ext);
    if (fileSet.has(indexFile)) return indexFile;
  }
  return null;
}

/**
 * @param {readonly string[]} files
 * @returns {Map<string, Set<string>>}
 */
function buildImportGraph(files) {
  const fileSet = new Set(files);
  /** @type {Map<string, Set<string>>} */
  const graph = new Map();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const dir = path.dirname(file);
    /** @type {Set<string>} */
    const imports = new Set();

    // ES imports: import ... from '...' and import '...'
    const esRe = /import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
    /** @type {RegExpExecArray | null} */
    let m;
    while ((m = esRe.exec(content)) !== null) {
      const resolved = resolveImport(/** @type {string} */ (m[1]), dir, fileSet);
      if (resolved) imports.add(resolved);
    }

    // CSS @import
    const cssRe = /@import\s+(?:url\(\s*)?['"]?([^'");\s]+)['"]?\s*\)?/g;
    while ((m = cssRe.exec(content)) !== null) {
      const resolved = resolveImport(/** @type {string} */ (m[1]), dir, fileSet);
      if (resolved) imports.add(resolved);
    }

    // SCSS @use / @forward
    const scssRe = /@(?:use|forward)\s+['"]([^'"]+)['"]/g;
    while ((m = scssRe.exec(content)) !== null) {
      const resolved = resolveImport(/** @type {string} */ (m[1]), dir, fileSet);
      if (resolved) imports.add(resolved);
    }

    graph.set(file, imports);
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Framework dev server detection
// ---------------------------------------------------------------------------

/**
 * How a running dev server is recognised: a response header, a body pattern,
 * or nothing when the port alone is the evidence.
 * @typedef {{ header?: string, value?: RegExp | null, body?: RegExp }} FrameworkFingerprint
 */

/** @type {readonly { name: string, files: readonly string[], defaultPort: number, portRe: RegExp, fingerprint: FrameworkFingerprint }[]} */
const FRAMEWORK_CONFIGS = [
  { name: 'Next.js', files: ['next.config.js', 'next.config.mjs', 'next.config.ts'], defaultPort: 3000,
    portRe: /port\s*[:=]\s*(\d+)/,
    fingerprint: { header: 'x-powered-by', value: /next/i } },
  { name: 'SvelteKit', files: ['svelte.config.js', 'svelte.config.ts'], defaultPort: 5173,
    portRe: /port\s*[:=]\s*(\d+)/,
    fingerprint: { header: 'x-sveltekit-page', value: null } },
  { name: 'Nuxt', files: ['nuxt.config.js', 'nuxt.config.ts'], defaultPort: 3000,
    portRe: /port\s*[:=]\s*(\d+)/,
    fingerprint: { header: 'x-powered-by', value: /nuxt/i } },
  { name: 'Vite', files: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'], defaultPort: 5173,
    portRe: /port\s*[:=]\s*(\d+)/,
    fingerprint: { body: /@vite\/client/ } },
  { name: 'Astro', files: ['astro.config.js', 'astro.config.ts', 'astro.config.mjs'], defaultPort: 4321,
    portRe: /port\s*[:=]\s*(\d+)/,
    fingerprint: { body: /astro/i } },
  { name: 'Angular', files: ['angular.json'], defaultPort: 4200,
    portRe: /"port"\s*:\s*(\d+)/,
    fingerprint: { body: /ng-version/i } },
  { name: 'Remix', files: ['remix.config.js', 'remix.config.ts'], defaultPort: 3000,
    portRe: /port\s*[:=]\s*(\d+)/,
    fingerprint: { header: 'x-powered-by', value: /remix/i } },
];

/**
 * @param {string} dir
 * @returns {{ name: string, port: number, configPath: string, fingerprint: FrameworkFingerprint } | null}
 */
function detectFrameworkConfig(dir) {
  /** @type {string[]} */
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const entrySet = new Set(entries);

  for (const cfg of FRAMEWORK_CONFIGS) {
    const match = cfg.files.find(f => entrySet.has(f));
    if (!match) continue;

    const configPath = path.join(dir, match);
    let port = cfg.defaultPort;
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const portMatch = content.match(cfg.portRe);
      if (portMatch) port = parseInt(/** @type {string} */ (portMatch[1]), 10);
    } catch { /* use default */ }

    return { name: cfg.name, port, configPath, fingerprint: cfg.fingerprint };
  }
  return null;
}

/**
 * Check if a port is listening and optionally verify it matches the expected framework.
 * Returns { listening: true, matched: true/false } or { listening: false }.
 */
/**
 * @param {number} port
 * @param {FrameworkFingerprint | null} [fingerprint]
 * @returns {Promise<{ listening: boolean, matched?: boolean }>}
 */
async function isPortListening(port, fingerprint = null) {
  if (!fingerprint) {
    // Simple TCP probe fallback
    const net = await import('node:net');
    return new Promise((resolve) => {
      const sock = net.default.createConnection({ port, host: '127.0.0.1' });
      sock.setTimeout(500);
      sock.on('connect', () => { sock.destroy(); resolve({ listening: true, matched: true }); });
      sock.on('error', () => resolve({ listening: false }));
      sock.on('timeout', () => { sock.destroy(); resolve({ listening: false }); });
    });
  }

  // HTTP probe with fingerprint matching
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/`, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);

    // Check header fingerprint
    if (fingerprint.header) {
      const val = res.headers.get(fingerprint.header);
      if (val && (!fingerprint.value || fingerprint.value.test(val))) {
        return { listening: true, matched: true };
      }
    }

    // Check body fingerprint
    if (fingerprint.body) {
      const body = await res.text();
      if (fingerprint.body.test(body)) {
        return { listening: true, matched: true };
      }
    }

    // Port is listening but doesn't match the expected framework
    return { listening: true, matched: false };
  } catch {
    return { listening: false };
  }
}

export {
  SKIP_DIRS,
  SCANNABLE_EXTENSIONS,
  HTML_EXTENSIONS,
  walkDir,
  walkScope,
  resolveImport,
  buildImportGraph,
  FRAMEWORK_CONFIGS,
  detectFrameworkConfig,
  isPortListening,
};
