import path from 'node:path';
import { REPO_ROOT } from '../lib/source-scope.js';
import { WALLED_PREFIX, walledSpecifiers } from './money-internals-owners-only.rule.js';
import type { Project } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every interim door the affordability module publishes has a consumer behind
 * it, and every consumer's door is published.
 *
 * `packages/shared/src/affordability/index.test.ts` states the promise —
 * "a unit still listed here is a consumer still behind the wall" — and pins its
 * list equal to the exports map. Equality is all it can check from inside the
 * package: both sides can hold the same dead entry and the guard stays green
 * while the promise is false, which is how a door with zero consumers survived
 * two passes over that list. The consumers live in other workspaces, so only a
 * rule with repo-wide scope can ask whether one exists.
 *
 * The subject is the exports map rather than the list because the map is what
 * actually publishes a door, and the two are pinned equal by that test — so an
 * entry removed from one alone already fails there. Both remedies below name
 * both places for the same reason: half an edit trades this rule's failure for
 * that test's.
 *
 * A reach is counted through {@link walledSpecifiers}, the money wall's own
 * collector, so the two rules cannot disagree about what a reach is. That is
 * also what keeps a textual mention from propping a dead door up: a comment or
 * a fixture's quoted source is not an import, a re-export or a module call, and
 * the collector never sees it. `packages/config` — where the wall's own tests
 * embed those specifiers as fixture text — is outside the scanned trees
 * entirely (`lib/source-scope.ts`).
 */

/** The manifest that publishes the doors, repo-relative. */
const MANIFEST_PATH = 'packages/shared/package.json';

/**
 * The declaring package. Its units reach each other by relative path, which is
 * no door at all; a file here naming its own package's subpath is
 * self-reference, and counting it would let the module keep a door open for
 * itself after the last outside consumer left.
 */
const DECLARING_PACKAGE = 'packages/shared/';

/** Exports-map keys under the module. The barrel `./affordability` is a sanctioned door, not an interim one. */
const SUBPATH_PREFIX = './affordability/';

interface Manifest {
  readonly exports: Record<string, string>;
}

interface Reach {
  readonly file: string;
  readonly line: number;
}

/** The exports-map key a walled specifier is published by. */
function subpathOf(specifier: string): string {
  return SUBPATH_PREFIX + specifier.slice(WALLED_PREFIX.length);
}

/** The specifier an exports-map key publishes. */
function specifierOf(subpath: string): string {
  return WALLED_PREFIX + subpath.slice(SUBPATH_PREFIX.length);
}

/** The line an entry sits on, so the report points at the edit rather than the file. */
function lineOf(manifestLines: readonly string[], subpath: string): number {
  return (
    Math.max(
      manifestLines.findIndex((line) => line.includes(`"${subpath}"`)),
      0
    ) + 1
  );
}

/**
 * The first reach of each door, keyed by exports-map key. First rather than
 * every: the repair is one manifest line however many files reach it, and a
 * door with nine consumers would otherwise print nine identical demands.
 */
function reaches(project: Project): Map<string, Reach> {
  const found = new Map<string, Reach>();
  for (const sourceFile of project.getSourceFiles()) {
    const file = path.relative(REPO_ROOT, sourceFile.getFilePath());
    if (file.startsWith(DECLARING_PACKAGE)) continue;
    for (const { specifier, line } of walledSpecifiers(sourceFile)) {
      const subpath = subpathOf(specifier);
      if (found.has(subpath)) continue;
      found.set(subpath, { file, line });
    }
  }
  return found;
}

const BOTH_PLACES =
  `${MANIFEST_PATH} and INTERIM_UNIT_SUBPATHS in ` +
  'packages/shared/src/affordability/index.test.ts (the two are pinned equal, ' +
  'so they move together)';

function deadDoorMessage(subpath: string): string {
  return (
    `'${subpath}' publishes a money-layer internal that nothing imports, ` +
    `re-exports or names in a module call. The list's promise is that a unit ` +
    'listed there is a consumer still behind the wall, and this one has no ' +
    `consumer. Drop the entry from ${BOTH_PLACES} — or restore the consumer ` +
    'that reaches it.'
  );
}

function undeclaredDoorMessage(subpath: string): string {
  return (
    `'${specifierOf(subpath)}' is reached here, but ${MANIFEST_PATH} publishes ` +
    'no such subpath, so this specifier resolves nowhere. Restore the entry in ' +
    `${BOTH_PLACES} — or move this consumer onto an answer published by ` +
    "'@hushbox/shared' or '@hushbox/shared/affordability'."
  );
}

const rule: ArchRule = {
  name: 'interim-subpaths-have-consumers',
  check(project) {
    const manifestText = project.getFileSystem().readFileSync(path.join(REPO_ROOT, MANIFEST_PATH));
    const manifestLines = manifestText.split('\n');
    const declared = Object.keys((JSON.parse(manifestText) as Manifest).exports).filter((subpath) =>
      subpath.startsWith(SUBPATH_PREFIX)
    );
    const reached = reaches(project);

    const violations: ArchViolation[] = [];
    for (const subpath of declared) {
      if (reached.has(subpath)) continue;
      violations.push({
        file: MANIFEST_PATH,
        line: lineOf(manifestLines, subpath),
        message: deadDoorMessage(subpath),
      });
    }
    for (const [subpath, reach] of reached) {
      if (declared.includes(subpath)) continue;
      violations.push({ ...reach, message: undeclaredDoorMessage(subpath) });
    }
    return violations;
  },
};

export default rule;
