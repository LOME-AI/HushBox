import path from 'node:path';
import { SyntaxKind } from 'ts-morph';
import { assertNamedPathsExist, isLocalSpecifier, isRepoPath, relativePath } from '../lib/paths.js';
import {
  E2E_SOURCE_TREE,
  REPO_ROOT,
  discoverSourceTrees,
  workspaceSourceTree,
} from '../lib/source-scope.js';
import type {
  ArrayLiteralExpression,
  ImportDeclaration,
  Node,
  Project,
  SourceFile,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The exact-money gate runs for every test, because the fixtures module calls
 * its verdict from a fixture declared `{ auto: true }`.
 *
 * Why a rule rather than a test: the gate is a Playwright teardown hook, so
 * unwiring it — deleting the fixture, dropping its `auto` option, or leaving
 * the verdict uncalled — turns the gate off for the whole suite and reddens
 * NOTHING. No spec asserts that the gate ran; a gate nobody calls simply
 * passes, which is the shape of silence this layer exists to delete. The gate's
 * own decision is unit-tested where it is made, and executing the hook needs a
 * browser no agent can drive, so the wiring is the one link left to pin, and it
 * is pinnable statically.
 *
 * The wiring is identified through the IMPORT GRAPH, never by a variable name:
 * the fixture's own name, the local alias and the tuple's shape may all change,
 * but a call to the gate module's exported verdict cannot be renamed on one
 * side alone — a rename of the export is a liveness failure below, and a rename
 * of the local binding is followed through the import specifier.
 *
 * What it does NOT catch: the rule proves the verdict is CALLED from an auto
 * fixture, never that its answer is acted on — a fixture that computes the
 * verdict and drops the result, or throws it behind a condition that never
 * holds, passes here, as does a gate whose own logic has stopped failing
 * anything. It reads this one fixtures module, so a suite that grew a second
 * `base.extend` root of its own is outside it.
 */

/** The fixtures module the whole suite extends, repo-relative. */
export const FIXTURES_MODULE = `${E2E_SOURCE_TREE}fixtures.ts`;

/** The module the gate's decision lives in, repo-relative. */
export const GATE_MODULE = `${workspaceSourceTree(discoverSourceTrees(REPO_ROOT), 'scripts')}lib/money/money-gate.ts`;

/** The gate's verdict: the export the fixtures module has to call. */
export const VERDICT_EXPORT = 'moneyGateFailure';

/** Playwright's per-test opt-out-free fixture option — the "runs for everything" flag. */
const AUTO_OPTION = 'auto';

const RULE_NAME = 'money-gate-wired-into-auto-fixture';

const MESSAGE =
  `This module no longer calls ${VERDICT_EXPORT} from a fixture declared \`{ ${AUTO_OPTION}: true }\`, ` +
  `so the exact-money gate in ${GATE_MODULE} runs for no test. Unwiring it reddens nothing at ` +
  'runtime — no spec asserts that the gate ran, and a gate nobody calls passes — which is why ' +
  'the wiring is pinned here. Call the verdict from an auto fixture again, importing it from ' +
  'the gate module.';

const MISSING_MODULE_REMEDY =
  'The exact-money gate is wired from the fixtures module to the gate module, and this rule ' +
  'stands over that one edge: with either end gone there is nothing left to check, and the ' +
  'search below would come back empty however thoroughly the gate had been unwired. If a ' +
  'module moved or was renamed, point this rule at its new path in the same change.';

const MISSING_VERDICT_MESSAGE =
  `${RULE_NAME}: ${GATE_MODULE} no longer exports ${VERDICT_EXPORT}. This is a LIVENESS failure ` +
  "of the rule, not a finding about the fixtures module: the name above is this rule's own copy " +
  "of the gate's verdict, and the module that owns it has stopped exporting it, so the search " +
  'for a call to it would come back empty however the fixtures module was wired. The repair is ' +
  "to give this rule the verdict's new name, in the change that renamed it — a module that MOVED " +
  'instead of an export that was renamed fails one line earlier, saying it names no file.';

/** True when `declaration` imports from the repo-relative module named. */
function resolvesTo(declaration: ImportDeclaration, repoPath: string): boolean {
  const specifier = declaration.getModuleSpecifierValue();
  if (!isLocalSpecifier(specifier)) return false;
  const importer = path.posix.dirname(declaration.getSourceFile().getFilePath());
  const resolved = path.posix.resolve(importer, specifier).replace(/\.js$/, '.ts');
  return isRepoPath(resolved, repoPath);
}

/**
 * The name the fixtures module knows the verdict by, or `undefined` when it
 * imports it from nowhere. An alias is followed, so renaming the local binding
 * is not a way past this rule; a same-named function imported from some other
 * module is not the gate's verdict and does not answer here.
 */
function verdictLocalName(fixtures: SourceFile): string | undefined {
  for (const declaration of fixtures.getImportDeclarations()) {
    if (!resolvesTo(declaration, GATE_MODULE)) continue;
    for (const named of declaration.getNamedImports()) {
      if (named.getName() !== VERDICT_EXPORT) continue;
      return named.getAliasNode()?.getText() ?? named.getName();
    }
  }
  return undefined;
}

/** True when a fixture tuple's options object declares `{ auto: true }`. */
function declaresAuto(tuple: ArrayLiteralExpression): boolean {
  return tuple.getElements().some((element) => {
    const auto = element
      .asKind(SyntaxKind.ObjectLiteralExpression)
      ?.getProperty(AUTO_OPTION)
      ?.asKind(SyntaxKind.PropertyAssignment);
    return auto?.getInitializer()?.getKind() === SyntaxKind.TrueKeyword;
  });
}

/** True when `node` calls `localName` anywhere inside itself. */
function calls(node: Node, localName: string): boolean {
  return node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((call) => call.getExpression().getText() === localName);
}

/** True when some auto fixture in `fixtures` calls the verdict. */
function wiresVerdict(fixtures: SourceFile, localName: string): boolean {
  return fixtures
    .getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)
    .some((tuple) => declaresAuto(tuple) && calls(tuple, localName));
}

/**
 * The rule's subject, alive: the gate module still exports the verdict.
 *
 * {@link VERDICT_EXPORT} is this rule's own copy of a name the gate module also
 * holds, and a rename updates one of them. When it updates the module's, no
 * import matches, no call matches, and the rule would report the fixtures
 * module for a wiring it never lost — or, once the fixtures module followed the
 * rename, report success over an invariant it had stopped reading. Both are
 * repaired by giving this rule the new name, and neither is what a wiring
 * finding asks for, so it is raised as its own failure.
 */
function assertGateExportsVerdict(project: Project): void {
  const exported = project
    .getSourceFiles()
    .filter((sourceFile) => isRepoPath(relativePath(sourceFile), GATE_MODULE))
    .flatMap((sourceFile) => [
      ...sourceFile.getFunctions(),
      ...sourceFile.getVariableDeclarations(),
    ])
    .some((declaration) => declaration.getName() === VERDICT_EXPORT && declaration.isExported());
  if (exported) return;
  throw new Error(MISSING_VERDICT_MESSAGE);
}

/**
 * The finding is an ABSENCE — there is no offending site to point at — so it is
 * reported against the fixtures module's first line, which is where a reader
 * opens the file the wiring belongs in.
 */
function wiringViolations(fixtures: SourceFile): ArchViolation[] {
  const localName = verdictLocalName(fixtures);
  if (localName !== undefined && wiresVerdict(fixtures, localName)) return [];
  return [{ file: fixtures.getFilePath(), line: 1, message: MESSAGE }];
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    assertNamedPathsExist(
      RULE_NAME,
      project,
      [FIXTURES_MODULE, GATE_MODULE],
      MISSING_MODULE_REMEDY
    );
    assertGateExportsVerdict(project);
    return project
      .getSourceFiles()
      .filter((sourceFile) => isRepoPath(relativePath(sourceFile), FIXTURES_MODULE))
      .flatMap((fixtures) => wiringViolations(fixtures));
  },
};

export default rule;
