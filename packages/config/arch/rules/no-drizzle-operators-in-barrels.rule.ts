import { relativePath } from '../lib/paths.js';
import type { ExportDeclaration, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Closes the operator-laundering hole the ESLint `boundaries/dependencies`
 * boundary cannot see. That boundary forbids slice `domain/` code from importing
 * `drizzle-orm`, but it matches by module *specifier*, not by capability: a
 * package barrel that re-exports Drizzle query operators lets domain code import
 * them from `@hushbox/db` instead, passing the boundary in letter while
 * defeating its intent. ESLint has no view of a barrel's resolved surface; this
 * structural rule does.
 *
 * A barrel (`packages/<pkg>/src/index.ts`) violates the rule when it either:
 *   - re-exports anything from `'drizzle-orm'` (`export * from 'drizzle-orm'` or
 *     `export { … } from 'drizzle-orm'`), or
 *   - surfaces a Drizzle query-operator name anywhere on its resolved export
 *     surface — whether written on the barrel (`export { eq } from './x'`,
 *     `export const eq = drizzleEq`) or reached through a star re-export of a
 *     first-party module that launders one.
 *
 * The second check reads the resolved surface rather than the barrel's own
 * export declarations, because a first-party module is free to define or
 * re-export an operator: defining an operator and re-exporting one are different
 * acts, and a module whose whole job is to launder `eq` out of `drizzle-orm` is
 * invisible to a scan that stops at the barrel's own syntax. Resolution is the
 * deliberate exception to the layer's syntactic default — the hole this rule
 * exists to close cannot be seen without it.
 *
 * The match is on the exported *name*, not on where the symbol resolves: a
 * barrel may not publish a symbol called `eq` or `sql` even if it is first-party,
 * because the caller cannot tell the difference and the ban is on the capability
 * reaching domain code. A domain function that merely *uses* an operator
 * internally is untouched — only its own name is read. The remedy this rule
 * reports is stated once, in {@link REMEDY}.
 */

/** Drizzle query operators that must never reach domain code via a barrel. */
const OPERATORS = new Set<string>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'and',
  'or',
  'not',
  'inArray',
  'notInArray',
  'isNull',
  'isNotNull',
  'like',
  'ilike',
  'between',
  'sql',
  'asc',
  'desc',
]);

const BARREL_PATH = /\/packages\/[^/]+\/src\/index\.ts$/;

const REMEDY =
  're-exporting Drizzle operators from a package barrel launders them into domain/ past the boundaries/dependencies boundary (which matches specifiers, not capabilities) — keep operators off published barrels, and let each consumer import from drizzle-orm directly wherever the boundary permits one, which packages/config/eslint-extensions/boundaries.config.mjs states.';

/** A violation plus every name it already accounts for, so the two scans do not double-report. */
interface NamedViolation {
  names: string[];
  violation: ArchViolation;
}

function violationsFor(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  const reported = new Set<string>();
  for (const declaration of sourceFile.getExportDeclarations()) {
    for (const { names, violation } of declarationViolations(declaration, filePath)) {
      for (const name of names) reported.add(name);
      violations.push(violation);
    }
  }
  violations.push(...surfaceViolations(sourceFile, filePath, reported));
  return violations;
}

function declarationViolations(declaration: ExportDeclaration, filePath: string): NamedViolation[] {
  const line = declaration.getStartLineNumber();
  if (declaration.getModuleSpecifierValue() === 'drizzle-orm') {
    const named = declaration.getNamedExports();
    if (named.length === 0) {
      return [{ names: [], violation: { file: filePath, line, message: reexportMessage('*') } }];
    }
    return named.map((specifier) => {
      const sourceName = specifier.getName();
      return {
        names: [sourceName, specifier.getAliasNode()?.getText() ?? sourceName],
        violation: {
          file: filePath,
          line: specifier.getStartLineNumber(),
          message: reexportMessage(sourceName),
        },
      };
    });
  }

  const violations: NamedViolation[] = [];
  for (const specifier of declaration.getNamedExports()) {
    const sourceName = specifier.getName();
    const outwardName = specifier.getAliasNode()?.getText() ?? sourceName;
    if (OPERATORS.has(sourceName) || OPERATORS.has(outwardName)) {
      violations.push({
        names: [sourceName, outwardName],
        violation: {
          file: filePath,
          line: specifier.getStartLineNumber(),
          message: `Barrel surfaces Drizzle query operator "${sourceName}" — ${REMEDY}`,
        },
      });
    }
  }
  return violations;
}

/**
 * The laundering half: every name the barrel actually publishes, star re-exports
 * and local bindings included. A laundered operator's declaration usually sits
 * outside the barrel (or outside the scanned scope entirely, when the launderer
 * pulls it from `drizzle-orm`), so the violation is attributed to the barrel
 * itself unless the binding is written there.
 */
function surfaceViolations(
  sourceFile: SourceFile,
  filePath: string,
  reported: ReadonlySet<string>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    if (!OPERATORS.has(name) || reported.has(name)) continue;
    const own = declarations.find((declaration) => declaration.getSourceFile() === sourceFile);
    violations.push({
      file: filePath,
      line: own?.getStartLineNumber() ?? 1,
      message: `Barrel's export surface includes Drizzle query operator "${name}" — ${REMEDY}`,
    });
  }
  return violations;
}

function reexportMessage(symbol: string): string {
  return `Barrel re-exports "${symbol}" from 'drizzle-orm' — ${REMEDY}`;
}

const rule: ArchRule = {
  name: 'no-drizzle-operators-in-barrels',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!BARREL_PATH.test('/' + filePath)) continue;
      violations.push(...violationsFor(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
