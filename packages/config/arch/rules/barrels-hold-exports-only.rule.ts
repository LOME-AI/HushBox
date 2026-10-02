import { Node } from 'ts-morph';
import { relativePath } from '../lib/paths.js';
import type { SourceFile, Statement } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * `docs/CODE-RULES.md` §Structure holds an `index.ts` to exports alone, and
 * takes `**\/index.ts` out of coverage for the same reason — so anything a
 * barrel does beyond exporting runs unmeasured as well as out of place.
 *
 * The coverage exclusion (`**\/index.ts!(x*)` in the shared vitest config) is
 * what gives this rule its line. That exclusion is safe only while the file
 * emits nothing, so the boundary drawn here is the EMIT boundary, not a
 * judgement about how trivial a declaration looks: a compiler-erased
 * declaration (interface, type alias, `declare`) can never become logic without
 * changing its syntactic kind, which this rule sees, whereas `export const A =
 * 1` becomes `export const A = compute()` in an edit no gate can observe — and
 * the file is unmeasured on both sides of it. So a barrel may hold imports,
 * re-exports, and type-erased declarations; everything else moves to a module
 * beside the barrel, which the barrel then re-exports.
 *
 * The rule governs `index.ts` files that EXPORT something. A
 * barrel's job is re-export, so a file publishing no name is not one — a
 * framework entry point whose body is its registration call is the shape meant,
 * and it is admitted by the property the rule checks rather than by naming its
 * path, so a future entry point of the same shape is admitted too and a future
 * barrel is not. `index.tsx` is out for the matching reason: coverage measures
 * it, so it carries no unmeasured-logic hazard and the premise above never
 * applies.
 *
 * Barrels written to be linted BY a test are out of the LAYER's view, not this
 * rule's: they sit in fixture trees that `lib/source-scope.ts` does not glob, so
 * no rule-local exemption belongs here — a path-shaped hole added here would
 * outlive the reason for it and swallow real barrels that happened to match.
 */

const BARREL_FILENAME = 'index.ts';

const REMEDY =
  'a barrel holds imports, re-exports, and type-erased declarations only — move it to a module beside the barrel and re-export it from here. Coverage excludes index.ts on the premise that barrels hold no logic, so runtime code written here is unenforced AND unmeasured.';

/** True when the compiler erases the statement, leaving no runtime code behind. */
function isTypeErased(statement: Statement): boolean {
  if (Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement)) return true;
  return Node.isAmbientable(statement) && statement.hasDeclareKeyword();
}

/** True when the statement only moves names between modules. */
function isModuleWiring(statement: Statement): boolean {
  return Node.isImportDeclaration(statement) || Node.isExportDeclaration(statement);
}

/** The declared name a violation message quotes, or the statement's kind. */
function subjectOf(statement: Statement): string {
  if (Node.isVariableStatement(statement)) {
    return statement
      .getDeclarations()
      .map((declaration) => declaration.getName())
      .join(', ');
  }
  if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)) {
    return statement.getName() ?? statement.getKindName();
  }
  if (Node.isEnumDeclaration(statement)) return statement.getName();
  return statement.getKindName();
}

/**
 * True when the file publishes a name. Read syntactically — the rule's scope
 * must not depend on module resolution, which a half-landed move breaks.
 */
function publishesAName(sourceFile: SourceFile): boolean {
  return sourceFile
    .getStatements()
    .some(
      (statement) =>
        Node.isExportDeclaration(statement) ||
        Node.isExportAssignment(statement) ||
        (Node.isModifierable(statement) && statement.hasModifier('export'))
    );
}

function violationsFor(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  if (!publishesAName(sourceFile)) return [];
  return sourceFile
    .getStatements()
    .filter((statement) => !isModuleWiring(statement) && !isTypeErased(statement))
    .map((statement) => ({
      file: filePath,
      line: statement.getStartLineNumber(),
      message: `Barrel emits runtime code for "${subjectOf(statement)}" — ${REMEDY}`,
    }));
}

const rule: ArchRule = {
  name: 'barrels-hold-exports-only',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!filePath.endsWith(`/${BARREL_FILENAME}`)) continue;
      violations.push(...violationsFor(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
