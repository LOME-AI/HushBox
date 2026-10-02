import { describe, it, expect } from 'vitest';
import { rootScripts, tokensOf } from './lib/root-manifest.js';

const TEST_BATCH = 'test-batch.ts';

/**
 * What makes a root script a package gate: it narrows the run to a named
 * subset. The batch wrapper forwards its arguments to turbo verbatim, and the
 * graph turbo runs is still the whole transitive closure of that subset, so
 * without `--continue` an upstream failure ends the run before the named
 * package is ever reached — turbo then reports the upstream packages it did
 * run and omits the requested one from the summary entirely.
 *
 * The unfiltered whole-graph scripts are deliberately outside this set: they
 * name no package to reach, and their truncation behaviour is a standing
 * decision, not a defect this file may quietly reverse.
 */
const FILTER_FLAG = '--filter';

const CONTINUE_FLAG = '--continue';

/**
 * turbo 2.x reads a bare `--continue` as `always` (measured on 2.9.18). The
 * other accepted value, `dependencies-successful`, still skips a task whose
 * dependency failed — which is the exact defect these gates must not have, so
 * flag presence alone is not the property; the effective value is.
 */
const CONTINUE_ALWAYS = 'always';

/**
 * Root scripts known to gate one package today. The derivation finds them on
 * its own; this list is the non-vacuity floor. Without it, a discovery bug (a
 * renamed flag, a reworded invocation) narrows the derived set to nothing and
 * every case below passes over an empty list. A count cannot serve: three gates
 * could be swapped for three others without moving it.
 */
const KNOWN_GATES: readonly string[] = ['test:web', 'test:api', 'test:pkg'];

/** Root script names in the test family: `test` itself and every `test:*`. */
function isTestScriptName(name: string): boolean {
  return /^test(:|$)/.test(name);
}

function isPackageGate(body: string): boolean {
  return body.includes(TEST_BATCH) && body.includes(FILTER_FLAG);
}

/** The effective `--continue` value, `undefined` when the flag is absent. */
function continueValue(body: string): string | undefined {
  for (const token of tokensOf(body)) {
    if (token === CONTINUE_FLAG) return CONTINUE_ALWAYS;

    if (token.startsWith(`${CONTINUE_FLAG}=`)) return token.slice(CONTINUE_FLAG.length + 1);
  }

  return undefined;
}

function packageGates(): [string, string][] {
  return Object.entries(rootScripts()).filter(
    ([name, body]) => isTestScriptName(name) && isPackageGate(body)
  );
}

describe('root package-gate scripts', () => {
  it('still derives every root script known to gate one package', () => {
    const derived = packageGates().map(([name]) => name);
    const missing = KNOWN_GATES.filter((name) => !derived.includes(name));

    expect(
      missing,
      `the derivation (a root "test"/"test:*" script whose body invokes ${TEST_BATCH} with ${FILTER_FLAG}) no longer reaches ${JSON.stringify(missing)}, so the case below asserts over less than it claims. Derived: ${JSON.stringify(derived)}`
    ).toEqual([]);
  });

  it.each(packageGates())('%s reaches the package it names', (name, body) => {
    expect(
      continueValue(body),
      `root package.json script "${name}" must pass ${CONTINUE_FLAG}=${CONTINUE_ALWAYS}. It filters turbo to a named package, but the task graph pulls in that package's upstream test tasks and runs them first; without ${CONTINUE_FLAG}=${CONTINUE_ALWAYS} one upstream failure ends the run before the named package's tests start, and the summary reports the upstream packages as the whole run — the named package appears nowhere. Script found: ${JSON.stringify(body)}`
    ).toBe(CONTINUE_ALWAYS);
  });
});
