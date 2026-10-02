import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const ManifestShape = z.object({ scripts: z.record(z.string(), z.string()) });

/** A script a body runs through the package manager, and the body it stands for. */
interface ReferencedScript {
  readonly name: string;
  readonly body: string;
}

/** The scripts a package manifest declares, named by its repo-relative path. */
export function manifestScripts(file: string): Record<string, string> {
  const raw: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8'));

  return ManifestShape.parse(raw).scripts;
}

/** The scripts the repository's own manifest declares. */
export function rootScripts(): Record<string, string> {
  return manifestScripts('package.json');
}

/**
 * How a script body reaches the task runner. Two spellings run it: the runner
 * named directly, and the wrapper that elects the build-cache writer before
 * naming it. Written once because two guards read it — one asking which
 * repo-wide gates have a wrapper, one asking whether the root test script still
 * runs the skill tree's tests — and a reader that knew only the direct spelling
 * would go quietly blind to every task the wrapper carries.
 */
const RUNNER_INVOCATION = /(?<=(?:turbo|turbo-run\.ts) run )\S+/g;

/** Every task a script body runs through the task runner, in the order it names them. */
export function turboRunTargets(body: string): string[] {
  // The runner is matched behind rather than captured, so the whole match is
  // the task: a capture would be one a reader has to prove present, and there
  // is no body shape that would make it absent.
  return [...body.matchAll(RUNNER_INVOCATION)].map((match) => match[0]);
}

/**
 * The words of a script body. Whitespace at either end yields no word, so a
 * word's position in the result is its position in the command.
 */
export function tokensOf(fragment: string): string[] {
  return fragment.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * The script the word at `index` runs through the package manager, or
 * `undefined` where it runs none. A body is the manifest's, so a name the
 * manifest does not declare resolves to nothing rather than to an empty body.
 */
export function referencedScriptAt(
  tokens: readonly string[],
  index: number,
  scripts: Readonly<Record<string, string>>
): ReferencedScript | undefined {
  const name = tokens[index + 1];
  if (tokens[index] !== 'pnpm' || name === undefined) return undefined;
  const body = scripts[name];
  return body === undefined ? undefined : { name, body };
}

/** The scripts a body runs through the package manager, with their bodies. */
function referencesIn(body: string, scripts: Readonly<Record<string, string>>): ReferencedScript[] {
  const tokens = tokensOf(body);
  return [...tokens.keys()].flatMap((index) => {
    const referenced = referencedScriptAt(tokens, index, scripts);
    return referenced === undefined ? [] : [referenced];
  });
}

/** The scripts a body runs through the package manager, in the order it names them. */
export function referencedScripts(
  body: string,
  scripts: Readonly<Record<string, string>>
): string[] {
  return referencesIn(body, scripts).map(({ name }) => name);
}

/**
 * Every body running `body` reaches, its own included. What is followed once is
 * the script, not the body, so two scripts declared with the same body yield
 * that body twice. `followed` is the scripts already being followed, which is
 * what makes scripts that run each other terminate rather than recur.
 */
function bodiesFrom(
  body: string,
  scripts: Readonly<Record<string, string>>,
  followed: Set<string>
): string[] {
  return [
    body,
    ...referencesIn(body, scripts).flatMap((referenced) => {
      if (followed.has(referenced.name)) return [];
      followed.add(referenced.name);
      return bodiesFrom(referenced.body, scripts, followed);
    }),
  ];
}

/**
 * Every body running the named script reaches, its own included. Bodies rather
 * than names because what a stage does is written in its body; a name the
 * manifest does not declare runs nothing and so reaches nothing.
 */
export function bodiesReachedBy(name: string, scripts: Readonly<Record<string, string>>): string[] {
  const body = scripts[name];
  return body === undefined ? [] : bodiesFrom(body, scripts, new Set([name]));
}

/**
 * Whether running `body` reaches a body `matches` accepts, however many scripts
 * it delegates through.
 */
export function reachesThroughReferences(
  body: string,
  scripts: Readonly<Record<string, string>>,
  matches: (body: string) => boolean
): boolean {
  return bodiesFrom(body, scripts, new Set()).some((reached) => matches(reached));
}
