import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { discoverWorkspaces } from './lib/cli/workspaces.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The package script names a caller appends arguments to, which is what makes
 * each answerable for the separator pnpm keeps in front of them.
 *
 * The root manifest's own entries are deliberately outside this derivation:
 * they name their own runners, and each of those runners is pinned by its own
 * colocated test. What has no owner without this file is the WORKSPACE set,
 * held by nothing but the manifests themselves — which is how one of them came
 * to be missed when the rest were closed.
 */
const ARGUMENT_TAKING_SCRIPTS: readonly string[] = ['test:watch', 'test:workers'];

/**
 * The two exports that answer for a pnpm-kept separator: one removes it, the
 * other names the slots it would have hidden so the wrapper can refuse them.
 * A runner reaching neither hands the separator to the wrapped tool, which
 * reads what follows as file filters, never reads them, widens the run to
 * everything the config collects, and still exits 0.
 */
const SEPARATOR_ANSWERS: readonly string[] = ['stripFirstSeparator', 'slotsHiddenBySeparator'];

/**
 * Where those two are defined, as repo-root-relative path segments.
 *
 * It is the one module in the graph that names both and imports neither, and
 * it also exports the separator literal itself — so a module importing it for
 * that constant alone reaches the names without answering for anything.
 */
const SEPARATOR_ANSWER_MODULE: readonly string[] = [
  'scripts',
  'lib',
  'cli',
  'argument-separator.ts',
];

/**
 * Package scripts known to take a caller's arguments today. The derivation
 * finds them on its own; this list is the non-vacuity floor. Without it, a
 * discovery bug — a renamed script family, a manifest shape the reader stops
 * parsing — narrows the derived set to nothing and the case below passes over
 * an empty list. A count cannot serve: one package could be swapped for
 * another without moving it. Both families are represented, because they are
 * discovered by the same reader but reach different runners.
 */
const KNOWN_ARGUMENT_TAKERS: readonly string[] = [
  '@hushbox/crypto test:watch',
  '@hushbox/api test:workers',
  '@hushbox/db test:workers',
];

const ManifestShape = z.object({
  name: z.string(),
  scripts: z.record(z.string(), z.string()).optional(),
});

interface PackageScript {
  /** `<package name> <script name>`, the spelling a developer types. */
  readonly label: string;
  /** Repo-root-relative package directory. */
  readonly dir: string;
  readonly body: string;
}

function packageScripts(): PackageScript[] {
  const found: PackageScript[] = [];
  for (const workspace of discoverWorkspaces(REPO_ROOT)) {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, workspace.path, 'package.json'), 'utf8')
    );
    const manifest = ManifestShape.parse(raw);
    for (const name of ARGUMENT_TAKING_SCRIPTS) {
      const body = manifest.scripts?.[name];
      if (body !== undefined) {
        found.push({ label: `${manifest.name} ${name}`, dir: workspace.path, body });
      }
    }
  }
  return found;
}

/**
 * The module a caller's appended arguments reach.
 *
 * pnpm appends them to the END of the script's command string, so the last
 * module the body names is the one handed them — which is why a body naming
 * only the env wrapper hands them to whatever that wrapper spawns instead.
 */
function runnerModule(script: PackageScript): string | undefined {
  const scriptsDir = path.join(REPO_ROOT, 'scripts');
  const named = script.body
    .split(/\s+/)
    .filter((token) => token.endsWith('.ts'))
    .map((token) => path.resolve(REPO_ROOT, script.dir, token.replaceAll(/^['"]|['"]$/g, '')))
    .filter((resolved) => resolved.startsWith(`${scriptsDir}${path.sep}`));
  return named.at(-1);
}

/** Relative import specifiers in a module's source, resolved to `.ts` paths. */
function localImports(file: string, source: string): string[] {
  const directory = path.dirname(file);
  return [...source.matchAll(/from\s+'(\.[^']*)'/g)].map(([, specifier = '']) =>
    path.resolve(directory, specifier.replace(/\.js$/, '.ts'))
  );
}

/**
 * The named bindings a module imports, from its own static import clauses.
 *
 * What makes a module an answerer is importing an answer, not naming one: the
 * module at {@link SEPARATOR_ANSWER_MODULE} names both — it defines them — and
 * exports the separator literal besides, so testing a source for the bare name
 * would count every module that imports that file for the constant alone.
 *
 * A namespace import (`import * as`) is not seen. No module in the scripts tree
 * takes an answer that way, and one that did would fail this gate loudly rather
 * than pass it silently.
 */
function importedBindings(source: string): Set<string> {
  const bindings = new Set<string>();
  for (const [, clause = ''] of source.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*'/g)) {
    for (const binding of clause.split(',')) {
      const imported = binding.trim().split(/\s+as\s+/)[0];
      if (imported !== undefined && imported !== '') bindings.add(imported);
    }
  }
  return bindings;
}

/**
 * Whether the module, or anything it imports, answers for the separator.
 *
 * The walk follows relative imports only, which is the whole of the scripts
 * tree's own graph. It establishes that the answer is REACHABLE from the
 * runner, not that the runner calls it on every path — a structural floor, in
 * the same spirit as the flag check in `scripts/root-test-scripts.test.ts`.
 */
function reachesSeparatorAnswer(entry: string): boolean {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    /* v8 ignore next -- queue.length > 0, so the shifted element is always present */
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const imported = importedBindings(source);
    if (SEPARATOR_ANSWERS.some((name) => imported.has(name))) {
      return true;
    }
    queue.push(...localImports(file, source));
  }
  return false;
}

describe('package test scripts that take a caller’s arguments', () => {
  it('does not count the module that defines the answers as one that reaches them', () => {
    const definer = path.join(REPO_ROOT, ...SEPARATOR_ANSWER_MODULE);
    const source = readFileSync(definer, 'utf8');

    expect(
      SEPARATOR_ANSWERS.filter((name) => !source.includes(`export function ${name}`)),
      `${SEPARATOR_ANSWER_MODULE.join('/')} no longer defines every name in ${JSON.stringify(SEPARATOR_ANSWERS)}, so the case below asserts nothing about the module the walk has to discount`
    ).toEqual([]);

    expect(
      reachesSeparatorAnswer(definer),
      'the module defining the answers also defines ARGUMENT_SEPARATOR, and importing it for that constant alone answers nothing. Counting its source as a reachable answer makes every constant-only importer qualify.'
    ).toBe(false);
  });

  it('still derives every package script known to take them', () => {
    const derived = packageScripts().map((script) => script.label);
    const missing = KNOWN_ARGUMENT_TAKERS.filter((label) => !derived.includes(label));

    expect(
      missing,
      `the derivation (a workspace manifest script named ${JSON.stringify(ARGUMENT_TAKING_SCRIPTS)}) no longer reaches ${JSON.stringify(missing)}, so the case below asserts over less than it claims. Derived: ${JSON.stringify(derived)}`
    ).toEqual([]);
  });

  it.each(packageScripts().map((script) => [script.label, script] as const))(
    '%s reaches a runner that answers for the separator pnpm keeps',
    (label, script) => {
      const runner = runnerModule(script);
      const reached =
        runner === undefined
          ? 'it names no module under scripts/, so a caller’s arguments reach the wrapped tool directly'
          : `its last named module, ${path.relative(REPO_ROOT, runner)}, imports none of ${JSON.stringify(SEPARATOR_ANSWERS)} anywhere on its import graph`;

      expect(
        runner === undefined ? false : reachesSeparatorAnswer(runner),
        `"${label}" is spelled ${JSON.stringify(script.body)} and ${reached}. pnpm appends a caller's arguments to the end of that command string with the \`--\` separator left in place, so the separator goes on to vitest, which reads it as the end of its own options and collects the arguments behind it into a bucket it never reads: the run widens to every file the config collects and still exits 0. Route the script through a runner that strips the separator or refuses what it hides.`
      ).toBe(true);
    }
  );
});
