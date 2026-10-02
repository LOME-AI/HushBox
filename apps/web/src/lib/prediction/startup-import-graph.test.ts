import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * Proves the app's startup module graph pulls in neither the inference library
 * nor the worker that hosts it.
 *
 * Read from the source tree rather than from a rendered app because that is
 * where the regression would be written: one `import` added to a module the
 * composer surfaces already reach puts the ~135 MB model's runtime on the
 * critical path of every page load, and nothing at runtime would say so — the
 * feature is silent by design and the download starts long before anyone looks.
 *
 * The graph is walked from the app entry over static and dynamic import
 * specifiers alike. A worker reached through `new URL(…, import.meta.url)` is
 * deliberately not an edge: the bundler emits it as its own chunk, which is
 * exactly the property being asserted.
 */

const SRC = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(SRC, 'main.tsx');

/** Specifiers no module the app loads at startup may name, directly or through another. */
const FORBIDDEN = ['@huggingface/transformers', 'onnxruntime-web', 'prediction.worker'];

/** Modules whose presence proves the walk reached the feature rather than stopping short. */
const EXPECTED_REACHED = [
  'routes/_app/chat.index.tsx',
  'components/chat/layout/chat-layout.tsx',
  'lib/prediction/prompt-predictor.ts',
  'lib/prediction/prediction-session.ts',
];

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** The path an in-app specifier points at, before extensions, or `null` for a package. */
function inAppBase(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) return path.resolve(SRC, specifier.slice('@/'.length));
  if (specifier.startsWith('.')) return path.resolve(path.dirname(fromFile), specifier);
  return null;
}

/** Resolves an in-app specifier to a file, or `null` for a package or a miss. */
function resolveInApp(specifier: string, fromFile: string): string | null {
  const base = inAppBase(specifier, fromFile);
  if (base === null) return null;
  const stem = base.endsWith('.js') ? base.slice(0, -'.js'.length) : base;
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${stem}${suffix}`;
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) return candidate;
  }
  return null;
}

interface Graph {
  /** Every app source file the entry reaches, repo-relative to the source root. */
  readonly reached: readonly string[];
  /** Every package specifier those files name. */
  readonly packages: readonly string[];
}

function walkFromEntry(): Graph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop() ?? ENTRY;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = resolveInApp(specifier.fileName, file);
      if (resolved === null) packages.add(specifier.fileName);
      else if (!files.has(resolved)) queue.push(resolved);
    }
  }
  return {
    reached: [...files].map((file) => path.relative(SRC, file).split(path.sep).join('/')),
    packages: [...packages],
  };
}

describe('the app startup module graph', () => {
  const graph = walkFromEntry();

  it('reaches both composer surfaces and the predictor behind them', () => {
    expect(graph.reached).toEqual(expect.arrayContaining(EXPECTED_REACHED));
  });

  it('names no module of the inference runtime, so no page load carries it', () => {
    const named = [...graph.packages, ...graph.reached].filter((specifier) =>
      FORBIDDEN.some((forbidden) => specifier.includes(forbidden))
    );
    expect(named).toEqual([]);
  });
});
