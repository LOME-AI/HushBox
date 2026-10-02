/**
 * Colour-token conformance over the frontend trees: a utility the design system
 * retired, the brand hex written inline, and a raw Tailwind palette class where
 * a semantic token belongs.
 *
 * It is a repository gate rather than a package's unit test because it walks
 * every source tree. A scan a package's suite runs is a repository-wide check
 * hidden inside one library's coverage figures, and it reports against files
 * that package neither owns nor builds.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import type { GateOutcome } from './privacy-gate.js';

/** The trees the two banned-string guards read, as the repository root holds them. */
const SOURCE_ROOTS = ['apps', 'packages'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.css']);

// Derived-output directory names, mirroring the root .gitignore's build-output
// entries. The guard polices authored source only; generated bundles are
// derived from source the scan already covers.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-ota',
  'build',
  'out',
  '.next',
  '.vercel',
  '.wrangler',
  '.astro',
  '.turbo',
  '.tanstack',
  '.gradle',
  'coverage',
]);

// Capacitor syncs the built web dist into the native projects (gitignored as
// "Copied web assets"). Those trees are derived output, but their leaf dir is
// named "public" — which elsewhere (apps/web/public, apps/marketing/public)
// holds authored static assets — so they are skipped by path suffix, not name.
const SKIP_PATH_SUFFIXES = ['android/app/src/main/assets/public', 'ios/App/App/public'];

function isDerivedOutputDir(fullPath: string, name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  const normalized = fullPath.split(path.sep).join('/');
  return SKIP_PATH_SUFFIXES.some((suffix) => normalized.endsWith(`/${suffix}`));
}

const TAILWIND_CONFIG = 'packages/config/tailwind/index.css';

// Every tree that ships a themed product surface. The remaining frontends are the
// sandbox origin, which renders untrusted document code under its own stylesheet,
// and the local-dev consoles, which ship in no production build.
const GUARDED_SOURCE_ROOTS = [
  'apps/web/src',
  'apps/admin/src',
  'packages/ui/src',
  'apps/marketing/src',
];

// A Tailwind palette class names a colour and carries no meaning, so it resolves
// to the same value in both themes while --success, --warning, --error and --info
// resolve per theme. A success, warning or error surface written as a palette
// class is therefore theme-blind and drifts from the value the design system
// darkened for contrast.
//
// A palette class is <utility>[-<side>]-<colour>-<shade>. The pattern matches
// that shape and each part is checked against a set; spelling every colour and
// shade into one alternation says the same thing as a regex no one can read.
const PALETTE_CLASS_SHAPE = /\b[a-z]+(?:-[a-z])?-[a-z]+-\d{2,3}\b/g;
const PALETTE_UTILITIES = new Set([
  'text',
  'bg',
  'border',
  'border-x',
  'border-y',
  'border-s',
  'border-e',
  'border-t',
  'border-r',
  'border-b',
  'border-l',
  'ring',
  'fill',
  'stroke',
  'outline',
  'divide',
  'divide-x',
  'divide-y',
  'shadow',
  'accent',
  'caret',
  'decoration',
  'placeholder',
  'from',
  'via',
  'to',
]);
const PALETTE_COLOURS = new Set([
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
]);
const PALETTE_SHADES = new Set([
  '50',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '950',
]);

// Development-only surfaces, exempt by exact path rather than by directory: their
// colour marks scaffolding rather than a product state, and neither ships in a
// production build.
const RAW_PALETTE_EXEMPT = new Set([
  'apps/web/src/components/shared/dev-only.tsx',
  'apps/web/src/routes/dev.personas.tsx',
]);

/** The three parts of a class the shape matched, read off its two last dashes. */
function isPaletteClass(token: string): boolean {
  const shadeDash = token.lastIndexOf('-');
  const head = token.slice(0, shadeDash);
  const colourDash = head.lastIndexOf('-');
  return (
    PALETTE_UTILITIES.has(head.slice(0, colourDash)) &&
    PALETTE_COLOURS.has(head.slice(colourDash + 1)) &&
    PALETTE_SHADES.has(token.slice(shadeDash + 1))
  );
}

function hasRawPaletteClass(line: string): boolean {
  for (const match of line.matchAll(PALETTE_CLASS_SHAPE)) {
    if (isPaletteClass(match[0])) return true;
  }
  return false;
}

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file);
}

/** Every authored source file below one directory, build output excluded. */
export function collectSourceFiles(dir: string, accumulator: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isDerivedOutputDir(full, entry.name)) collectSourceFiles(full, accumulator);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      accumulator.push(full);
    }
  }
}

function collectRootFiles(repoRoot: string, root: string): string[] {
  const files: string[] = [];
  collectSourceFiles(path.join(repoRoot, root), files);
  // A zero-file collection means the walker broke; without this the guards
  // below would pass vacuously against an empty scan.
  if (files.length === 0) {
    throw new Error(`token guard scan collected no source files under ${root}`);
  }
  return files;
}

function repoRelative(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function findOffendingLines(
  repoRoot: string,
  root: string,
  offends: (line: string) => boolean,
  allow: (file: string) => boolean
): string[] {
  const offenders: string[] = [];
  for (const file of collectRootFiles(repoRoot, root)) {
    if (allow(file)) continue;
    const relative = repoRelative(repoRoot, file);
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (offends(line)) offenders.push(`${relative}:${String(index + 1)}`);
    }
  }
  return offenders;
}

function findMatches(repoRoot: string, needle: string, allow: (file: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of collectRootFiles(repoRoot, root)) {
      if (allow(file)) continue;
      if (readFileSync(file, 'utf8').includes(needle)) offenders.push(repoRelative(repoRoot, file));
    }
  }
  return offenders;
}

/** One line per offence, in the order a reader fixes them. */
function findings(repoRoot: string): string[] {
  // The alias definition (--color-foreground-muted) in the tailwind config is
  // intentionally retained; only the utility class usage is banned. Test files
  // name the banned string to assert on it and are excluded.
  const nonCanonical = findMatches(
    repoRoot,
    'text-foreground-muted',
    (file) => repoRelative(repoRoot, file) === TAILWIND_CONFIG || isTestFile(file)
  );
  const brandHex = findMatches(repoRoot, 'text-[#ec4755]', isTestFile);
  const palette = GUARDED_SOURCE_ROOTS.flatMap((root) =>
    findOffendingLines(repoRoot, root, hasRawPaletteClass, (file) =>
      RAW_PALETTE_EXEMPT.has(repoRelative(repoRoot, file))
    )
  );
  return [
    ...nonCanonical.map((file) => `  ${file}  writes the non-canonical text-foreground-muted`),
    ...brandHex.map((file) => `  ${file}  hardcodes the brand hex rather than its token`),
    ...palette.map((line) => `  ${line}  writes a raw Tailwind palette class`),
  ];
}

export function runDesignTokenScan(repoRoot: string): GateOutcome {
  const offences = findings(repoRoot);
  const scanned = SOURCE_ROOTS.reduce(
    (total, root) => total + collectRootFiles(repoRoot, root).length,
    0
  );
  const report = [
    `Design tokens: ${String(scanned)} file(s) scanned under ${SOURCE_ROOTS.join(', ')}.`,
    ...(offences.length === 0 ? ['  no findings'] : offences),
  ].join('\n');
  return { report, code: offences.length === 0 ? 0 : 1 };
}

export const COMMAND_LINE = {
  command: 'pnpm design-tokens:scan',
  summary: 'Checks that every frontend surface writes its colours as semantic tokens.',
  flags: [],
  positionals: { kind: 'none' },
  effect: 'reports',
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through the gate */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = runDesignTokenScan(path.resolve(import.meta.dirname, '..'));
    console.log(outcome.report);
    return outcome.code;
  });
}
/* v8 ignore stop */
