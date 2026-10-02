import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether a module can reach a test runner, read off the source text of the
 * files it names.
 *
 * The pin it serves is that a module meant to be importable from production
 * code carries no test-runner dependency, and the walk answers that from source
 * rather than from a runtime load, so it can stand as an ordinary colocated
 * test with no loader hook behind it.
 *
 * The limitation that buys: it follows RELATIVE edges only. A runner sitting
 * behind a package specifier is recorded as that specifier and never matched,
 * so a module reaching `vitest` through `@hushbox/shared/test-time` reads as
 * clean here. Direct package specifiers — which is how a module names a runner
 * when it depends on one — are exactly what it does see.
 */

/** Both specifier-bearing forms: an `import`/`export … from`, and an `import()` call. */
const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g;

/** The package specifiers that make a module a test module. */
const TEST_RUNNER = /^(?:vitest(?:\/|$)|@vitest\/|node:test$)/;

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(SPECIFIER)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier): specifier is string => specifier !== undefined);
}

/**
 * Maps a relative specifier onto the file it names, so `./x.ts` and `./x.js`
 * both resolve to `x.ts` and either spelling keeps the walk moving. A specifier
 * that maps onto no file throws in {@link specifiersOf} rather than quietly
 * dropping the edge, which is what keeps a caller's "reaches no test runner"
 * from holding because the walk stopped early.
 */
function resolveRelative(from: string, specifier: string): string {
  return path.resolve(path.dirname(from), specifier.replace(/\.js$/, '.ts'));
}

/**
 * Every package specifier reachable from `entry`, following relative edges
 * into the files they name.
 */
function reachableSpecifiers(entry: string): string[] {
  const visited = new Set<string>([entry]);
  const pending: string[] = [entry];
  const external: string[] = [];
  let pop = pending.pop();
  while (pop !== undefined) {
    const file = pop;
    const found = specifiersOf(file);
    external.push(...found.filter((specifier) => !specifier.startsWith('.')));
    const next = found
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => resolveRelative(file, specifier))
      .filter((candidate) => !visited.has(candidate));
    for (const candidate of next) {
      visited.add(candidate);
      pending.push(candidate);
    }
    pop = pending.pop();
  }
  return external;
}

/** The test runners the source graph rooted at `entry` names. */
export function testRunnersReachableFrom(entry: string): string[] {
  return reachableSpecifiers(entry).filter((specifier) => TEST_RUNNER.test(specifier));
}
