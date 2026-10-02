import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Directories never descended into. The rule is "no human wrote this": dependency
 * installs, build output, tool caches, VCS internals, generated test reports and
 * harness state, and the tool-generated Drizzle migration directory. Hand-written
 * dev tooling (e.g. `.claude`) and CI config are deliberately NOT here.
 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.wrangler',
  '.astro',
  '.vite',
  'out',
  // Generated test reports/artifacts and harness state: Playwright/Maestro
  // reports, jscpd output, per-run results, saved auth — output, not source.
  'report',
  'reports',
  'playwright-report',
  'test-results',
  'maestro-results',
  '.auth',
  // drizzle-kit migration output (SQL + snapshot JSON) is generated from the
  // hand-written schema, which is counted; the generated migrations are not.
  'drizzle',
]);

/**
 * Repo-relative directory prefixes whose markdown is process record rather than
 * codebase: audit findings sets, plan and run records, decision records, and
 * superseded docs. Only markdown is dropped — spec fixtures and scripts living
 * under them are still hand-written source.
 */
const RECORD_DOC_PREFIXES = [
  'docs/audits',
  'docs/decisions',
  'docs/history',
  'docs/plans',
  'docs/runs',
];

/** Lockfiles are generated resolver output, never hand-edited. */
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

/** Tool-generated files (e.g. TanStack Router's `routeTree.gen.ts`) overwritten
 * on build; counting them measures the generator, not the codebase. */
const GENERATED_FILE = /\.gen\.(?:ts|tsx|js|jsx)$/;

/**
 * Extensions counted toward the repo's "lines written" stat: anything a human
 * authors here — code, styles, markup, config, CI workflows, scripts, diagrams,
 * and documentation. Binary assets (images, fonts, wasm) are excluded by omission.
 */
const COUNTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.astro',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.mermaid',
  '.md',
  '.mdx',
]);

/** Physical line count of a file's text: the empty file is zero, a trailing
 * newline does not add a phantom final line. */
function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  const body = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  return body.split('\n').length;
}

/** A file counts when a human authored it: a counted extension that is neither a
 * lockfile nor a generated file. */
function isCountedSource(name: string): boolean {
  if (LOCKFILES.has(name) || GENERATED_FILE.test(name)) return false;
  return COUNTED_EXTENSIONS.has(path.extname(name));
}

// eslint-disable-next-line comments/resolvable-cross-reference -- the example names a path that deliberately does not exist; its absence is the point the sentence makes, so no resolving form of it exists
/** Markdown under a record-doc prefix, anchored at the repo root so nested `apps/web/docs/history`
 * is unaffected. */
function isRecordDocument(relativePath: string, name: string): boolean {
  const extension = path.extname(name);
  if (extension !== '.md' && extension !== '.mdx') return false;
  return RECORD_DOC_PREFIXES.some((prefix) => relativePath.startsWith(`${prefix}/`));
}

/**
 * The single rule for whether a file counts, applied to a slash-separated
 * repo-relative path.
 */
export function isCountedPath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const name = segments.at(-1);
  if (name === undefined || name === '') return false;
  if (segments.slice(0, -1).some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
  if (isRecordDocument(relativePath, name)) return false;
  return isCountedSource(name);
}

/** Recurses with the path relative to the walk's root, because the record-doc
 * prefixes are meaningful only from there. */
function walk(absoluteDir: string, relativeDir: string): number {
  let total = 0;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) total += walk(absolute, relative);
    } else if (entry.isFile() && isCountedPath(relative)) {
      total += countLines(readFileSync(absolute, 'utf8'));
    }
  }
  return total;
}

/**
 * Total physical lines across every source file under `dir`, which must be the
 * repo root: exclusions are resolved against paths relative to it. Walks the
 * tree with `node:fs` only — no shell-out — so it runs identically on every OS
 * and inside unit tests.
 */
export function countLinesOfCode(dir: string): number {
  return walk(dir, '');
}
