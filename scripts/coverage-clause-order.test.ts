import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getWorkspacePaths } from './lib/cli/workspaces.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * What makes a clause coverage-bearing: this runner is the only thing in these
 * chains that hands vitest `--coverage`. The first test below grounds that
 * rather than trusting the name.
 */
const COVERAGE_RUNNER = 'run-package-tests.ts';
const COVERAGE_FLAG = "'--coverage'";

const CHAIN_OPERATOR = '&&';

/**
 * Packages known to carry a workers-pool suite today. The sweep finds them on
 * its own; this list is the non-vacuity floor. Without it, a discovery bug (a
 * workspace pattern that does not expand, a renamed manifest key) narrows the
 * swept set and every case below passes over less than it claims. A count
 * cannot serve here: three packages could be swapped for three others without
 * moving it.
 */
const KNOWN_WORKERS_SUITE: readonly string[] = ['apps/api', 'packages/db', 'packages/realtime'];

const ManifestShape = z.object({
  scripts: z
    .object({ test: z.string().optional(), 'test:workers': z.string().optional() })
    .optional(),
});

/**
 * Tolerates an absent manifest because the containment failure below reports on
 * directories that may no longer exist — that read must render a message, not crash.
 * Every swept directory has a manifest by construction.
 */
function manifestScripts(
  directory: string
): { test?: string | undefined; 'test:workers'?: string | undefined } | undefined {
  const manifest = path.join(REPO_ROOT, directory, 'package.json');

  if (!existsSync(manifest)) return undefined;

  const raw: unknown = JSON.parse(readFileSync(manifest, 'utf8'));

  return ManifestShape.parse(raw).scripts;
}

function testScript(directory: string): string | undefined {
  return manifestScripts(directory)?.test;
}

function testClauses(directory: string): string[] {
  const script = testScript(directory);

  if (script === undefined) {
    throw new Error(`${directory}/package.json declares no "test" script`);
  }

  return script.split(CHAIN_OPERATOR).map((clause) => clause.trim());
}

function carriesCoverage(clause: string): boolean {
  return clause.includes(COVERAGE_RUNNER);
}

/**
 * Workspace discovery belongs to `workspaces.ts`, the package's single reader of
 * `pnpm-workspace.yaml`; nothing here may parse that file again.
 *
 * How far that leaves this file guarded, as two separate facts. Narrowing that DROPS one of
 * the named chained packages is loud: the containment test below reddens, down to a
 * discovery that returns nothing at all. Narrowing by DEPTH is not covered by anything here:
 * a `**` pattern expands to direct children only, so a chained package nested deeper is
 * swept by pnpm, never reached by this file, and every case below passes. Latent only
 * because no `**` pattern is declared today; closing it means teaching the expander, and
 * this file cannot compensate for it.
 */
const SWEPT_DIRECTORIES = getWorkspacePaths(REPO_ROOT);

/**
 * pnpm appends passthrough arguments to the END of a script string, so only the final
 * clause of a chain can ever receive them. With the coverage clause anywhere but last,
 * `--coverage.reportsDirectory=<path>` lands on a clause that declares no coverage: the
 * override directory is never created, the default path is still written, and the chain
 * exits 0 — a gate reporting success while measuring nothing.
 */
const CHAINED_DIRECTORIES = SWEPT_DIRECTORIES.filter((directory) =>
  (testScript(directory) ?? '').includes(CHAIN_OPERATOR)
);

const WORKERS_SUITE_DIRECTORIES = SWEPT_DIRECTORIES.filter(
  (directory) => typeof manifestScripts(directory)?.['test:workers'] === 'string'
);

describe('chained test scripts', () => {
  it('grounds the coverage marker on the runner that turns coverage on', () => {
    const runner = readFileSync(path.join(REPO_ROOT, 'scripts', COVERAGE_RUNNER), 'utf8');

    expect(
      runner,
      `scripts/${COVERAGE_RUNNER} no longer passes ${COVERAGE_FLAG} to vitest, so invoking it is no longer what makes a clause coverage-bearing and the clause-order assertion below is measuring the wrong marker`
    ).toContain(COVERAGE_FLAG);
  });

  it('grounds the workers-suite marker on the runner that spawns it', () => {
    const runner = readFileSync(path.join(REPO_ROOT, 'scripts', COVERAGE_RUNNER), 'utf8');

    expect(
      runner,
      `scripts/${COVERAGE_RUNNER} no longer spawns "test:workers" itself, so an unchained "test" script would silently drop the workers-pool suite and the unchained-script cases below assert the wrong property`
    ).toContain("'test:workers'");
  });

  it('sweeps the workspace and still reaches every package known to carry a workers suite', () => {
    const missing = KNOWN_WORKERS_SUITE.filter(
      (directory) => !WORKERS_SUITE_DIRECTORIES.includes(directory)
    );

    expect(
      missing,
      `VACUOUS SWEEP — the workspace sweep no longer reaches ${JSON.stringify(missing)} as packages with a "test:workers" script, so the unchained-script cases below no longer cover them. Either discovery broke or the package genuinely dropped its workers suite (in which case drop it from this list deliberately). Swept ${String(SWEPT_DIRECTORIES.length)} directories. Workers-suite packages found: ${JSON.stringify(WORKERS_SUITE_DIRECTORIES)}`
    ).toEqual([]);
  });

  it.each(KNOWN_WORKERS_SUITE)(
    '%s leaves its workers suite to the runner, unchained',
    (directory) => {
      const script = testScript(directory) ?? '';

      expect(
        script.includes(CHAIN_OPERATOR),
        `${directory}/package.json: "test" chains with ${CHAIN_OPERATOR} — the runner spawns "test:workers" concurrently with the node-suite verdict itself, so a chained pre-step would run the workers suite twice and serialize it ahead of the batch. Script found: ${JSON.stringify(script)}`
      ).toBe(false);
      expect(
        script,
        `${directory}/package.json: "test" no longer invokes ${COVERAGE_RUNNER}, which is what spawns the workers suite`
      ).toContain(COVERAGE_RUNNER);
    }
  );

  it.each(CHAINED_DIRECTORIES)('%s keeps the coverage clause last', (directory) => {
    const clauses = testClauses(directory);
    const coverageClauseCount = clauses.filter((clause) => carriesCoverage(clause)).length;
    const coverageClauseIndex = clauses.findIndex((clause) => carriesCoverage(clause));

    expect(
      coverageClauseCount,
      `${directory}/package.json: exactly one ${CHAIN_OPERATOR} clause of "test" must invoke ${COVERAGE_RUNNER}, so that "the coverage clause" is unambiguous. Clauses found: ${JSON.stringify(clauses)}`
    ).toBe(1);
    expect(
      coverageClauseIndex,
      `${directory}/package.json: WRONG CLAUSE ORDER — the coverage-bearing clause (the one invoking ${COVERAGE_RUNNER}) sits at index ${String(coverageClauseIndex)} but must be LAST of the ${String(clauses.length)} ${CHAIN_OPERATOR} clauses of "test". pnpm appends passthrough arguments to the end of the script string, so with coverage not last an appended --coverage.reportsDirectory lands on a clause that declares no coverage: it is silently ignored, the run exits 0, and the gate measures nothing. Clause order found: ${JSON.stringify(clauses)}`
    ).toBe(clauses.length - 1);
  });
});
