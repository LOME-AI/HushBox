import { Node, SyntaxKind } from 'ts-morph';
import {
  assertNamedPathsExist,
  failWith,
  isRepoPath,
  isTestFile,
  relativePath,
  sourceFileAt,
} from '../lib/paths.js';
import type {
  CallExpression,
  ImportDeclaration,
  NewExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  SourceFile,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every mid-flow value the workflow interpreter puts on a channel crosses the
 * ValueStore: `store()` admits and byte-meters it on the way in, `resolve()`
 * fetches it on the way out. `docs/ARCHITECTURE.md` §"The workflow engine"
 * makes that seam load-bearing twice over — it is where a run's byte budget is
 * charged, and it is the plug point a durable runner would enter through if the
 * fast-fail decision is ever reversed. A raw map access leaves the seam partial
 * in a way nothing observes today, because the in-memory `resolve()` is the
 * identity function: the gap stays invisible until someone tries to swap the
 * implementation and finds the interpreter, not merely an adapter, in the diff.
 *
 * ITS SCOPE IS WHERE A RUN SCOPE CAN BE NAMED, which is not a directory: the
 * module declaring the scope type, plus every module importing that type from
 * it. A directory test held only while the type could not leave the engine, and
 * carving the run steps out of the interpreter exported it — a node execution
 * beside the engine can take a whole scope in, and a raw write from there leaves
 * the seam exactly as partial as one written inside.
 *
 * The rule reads the access site itself rather than which function it sits in,
 * so there is no exemption list and nothing to launder past:
 *
 *   - a `.set(…)` on a scope map, and every entry a scope literal seeds into a
 *     fresh `Map`, must carry the `.value` of a `store()` Result bound in the
 *     same function;
 *   - a `.get(…)` on a scope map must be the argument of a `resolve(…)` call;
 *   - `.has(…)` is free — it answers a boolean, and no durable store needs to
 *     fetch anything to say whether a key is present;
 *   - every other way of naming a scope map is refused, because a map that
 *     escapes the seam can be written and read anywhere.
 *
 * **What it does not prove.** It reads a binding's initializer for a `store(`
 * call by name, never by symbol, so a same-named local method called `store`
 * would satisfy it. Nor can it say the value admitted is the value written
 * where one function admits two: `const a = this.store.store(x)` beside a write
 * of `b.value` passes if some `b` in that function is store-bound. Both are
 * deliberate acts, not the accidental raw access this rule exists to catch.
 *
 * Nor does selection follow a scope that arrives some way other than a direct
 * import of its type: through a re-export chain, through a structurally typed
 * parameter, or through a specifier this layer's project cannot resolve — it
 * loads no tsconfig, so a relative specifier resolves and an `@/` alias does
 * not.
 */

const RULE = 'channel-values-cross-the-value-store';

/** The module declaring the run scope type, and the type — together the rule's scope. */
const SCOPE_MODULE = 'apps/api/src/slices/workflows/domain/engine/run-steps.ts';
const SCOPE_TYPE = 'Scope';

/** The scope maps a run's values live in — the seam's subject. */
const CHANNEL_MAPS = new Set(['channels', 'virtual', 'inputChannels']);

const REMEDY =
  'every mid-flow value crosses the ValueStore — `store()` admits and meters it, `resolve()` fetches it. A raw map access leaves the seam partial, so a durable store would land in the interpreter rather than behind the seam.';

const SUBJECT_MOVED =
  'The rule watches the module declaring the run scope type and every module importing it; if that declaration moved or was renamed, point this rule at its new home rather than leaving it standing over nothing.';

/** An import that takes the scope type off the module declaring it. */
function importsScopeType(declaration: ImportDeclaration): boolean {
  const target = declaration.getModuleSpecifierSourceFile();
  if (target === undefined || !isRepoPath(relativePath(target), SCOPE_MODULE)) return false;
  return (
    declaration.getNamespaceImport() !== undefined ||
    declaration.getNamedImports().some((named) => named.getName() === SCOPE_TYPE)
  );
}

/**
 * The scope type declared AS A TYPE in the module this rule names. Identity,
 * not spelling: a re-export carries the name while the declaration lives
 * elsewhere, and a same-named value carries it while no type does — either one
 * leaves importers of the real declaration unselected, which is the move the
 * decay guard exists to refuse.
 */
function declaresScopeType(scopeModule: SourceFile | undefined): boolean {
  const declared = scopeModule?.getExportedDeclarations().get(SCOPE_TYPE);
  return (
    declared?.some(
      (declaration) =>
        (Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration)) &&
        isRepoPath(relativePath(declaration.getSourceFile()), SCOPE_MODULE)
    ) === true
  );
}

/** A file that can name a run scope: the module declaring the type, or one importing it. */
function namesScopeType(sourceFile: SourceFile, filePath: string): boolean {
  if (isRepoPath(filePath, SCOPE_MODULE)) return true;
  return sourceFile.getImportDeclarations().some((declaration) => importsScopeType(declaration));
}

function enclosingBody(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (ancestor) =>
      Node.isMethodDeclaration(ancestor) ||
      Node.isFunctionDeclaration(ancestor) ||
      Node.isFunctionExpression(ancestor) ||
      Node.isArrowFunction(ancestor) ||
      Node.isConstructorDeclaration(ancestor)
  );
}

/** A binding whose initializer names a `store(…)` call, read by name. */
function bindsStoreCall(body: Node, name: string): boolean {
  return body
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((declaration) => declaration.getName() === name)
    .some((declaration) =>
      declaration.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
        const callee = call.getExpression();
        return Node.isPropertyAccessExpression(callee) && callee.getName() === 'store';
      })
    );
}

/** The value a write may carry: the `.value` of a `store()` Result bound alongside it. */
function isStoreAdmitted(expression: Node | undefined): boolean {
  if (expression === undefined || !Node.isPropertyAccessExpression(expression)) return false;
  if (expression.getName() !== 'value') return false;
  const bound = expression.getExpression();
  if (!Node.isIdentifier(bound)) return false;
  const body = enclosingBody(expression);
  return body !== undefined && bindsStoreCall(body, bound.getText());
}

/**
 * A read is admitted only as the argument of a `resolve(…)` call. A read in the
 * CALLEE position needs no separate refusal: the enclosing call's expression is
 * then the read itself rather than a `.resolve` member, so the name test below
 * already answers it.
 */
function isResolveWrapped(call: CallExpression): boolean {
  const parent = call.getParent();
  if (parent === undefined || !Node.isCallExpression(parent)) return false;
  const callee = parent.getExpression();
  return Node.isPropertyAccessExpression(callee) && callee.getName() === 'resolve';
}

function violation(file: string, line: number, message: string): ArchViolation {
  return { file, line, message: `${message} — ${REMEDY}` };
}

/** Where a violation is reported: the scope map's own name and position. */
interface Site {
  readonly map: string;
  readonly file: string;
  readonly line: number;
}

/** The verdict on one `<map>.<member>(…)` call. */
function calledViolation(
  site: Site,
  member: string,
  call: CallExpression
): ArchViolation | undefined {
  const { map, file, line } = site;
  if (member === 'has') return undefined;
  if (member === 'set') {
    if (isStoreAdmitted(call.getArguments()[1])) return undefined;
    return violation(
      file,
      line,
      `Channel write into "${map}" carries a value store() never admitted`
    );
  }
  if (member === 'get') {
    if (isResolveWrapped(call)) return undefined;
    return violation(file, line, `Channel read of "${map}" skips resolve()`);
  }
  return violation(
    file,
    line,
    `Scope map "${map}" escapes the ValueStore seam through ".${member}()"`
  );
}

/** The verdict on one property access naming a scope map. */
function accessViolation(
  access: PropertyAccessExpression,
  file: string
): ArchViolation | undefined {
  const site: Site = { map: access.getName(), file, line: access.getStartLineNumber() };
  const escaped = violation(file, site.line, `Scope map "${site.map}" escapes the ValueStore seam`);
  const member = access.getParent();
  if (!Node.isPropertyAccessExpression(member)) return escaped;
  const call = member.getParent();
  if (!Node.isCallExpression(call)) return escaped;
  return calledViolation(site, member.getName(), call);
}

/** The value half of each `[key, value]` pair a `new Map([…])` seeds. */
function seededValues(created: NewExpression): Node[] {
  const [first] = created.getArguments();
  if (first === undefined) return [];
  if (!Node.isArrayLiteralExpression(first)) return [first];
  return first
    .getElements()
    .map((entry) =>
      Node.isArrayLiteralExpression(entry) ? (entry.getElements()[1] ?? entry) : entry
    );
}

/** A scope map handed in whole, rather than built fresh where the scope is. */
function boundElsewhere(name: string, file: string, line: number): ArchViolation {
  return violation(file, line, `Scope literal binds "${name}" to a map built elsewhere`);
}

/** The verdict on one scope-literal property that names a map. */
function assignmentViolations(assignment: PropertyAssignment, file: string): ArchViolation[] {
  const map = assignment.getName();
  const initializer = assignment.getInitializer();
  if (initializer === undefined || !isFreshMap(initializer)) {
    return [boundElsewhere(map, file, assignment.getStartLineNumber())];
  }
  return seededValues(initializer)
    .filter((seeded) => !isStoreAdmitted(seeded))
    .map((seeded) =>
      violation(
        file,
        seeded.getStartLineNumber(),
        `Scope literal seeds "${map}" with a value store() never admitted`
      )
    );
}

/** A scope literal builds its maps fresh, and seeds them only with admitted values. */
function literalViolations(sourceFile: SourceFile, file: string): ArchViolation[] {
  const shorthand = sourceFile
    .getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)
    .filter((property) => CHANNEL_MAPS.has(property.getName()))
    .map((property) => boundElsewhere(property.getName(), file, property.getStartLineNumber()));
  const assigned = sourceFile
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .filter((property) => CHANNEL_MAPS.has(property.getName()))
    .flatMap((property) => assignmentViolations(property, file));
  return [...shorthand, ...assigned];
}

function isFreshMap(initializer: Node): initializer is NewExpression {
  return Node.isNewExpression(initializer) && initializer.getExpression().getText() === 'Map';
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const fail = failWith(RULE);
    assertNamedPathsExist(RULE, project, [SCOPE_MODULE], SUBJECT_MOVED);
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const file = relativePath(sourceFile);
      if (isTestFile(file) || !namesScopeType(sourceFile, file)) continue;
      const accessed = sourceFile
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .filter((access) => CHANNEL_MAPS.has(access.getName()));
      violations.push(
        ...accessed
          .map((access) => accessViolation(access, file))
          .filter((found): found is ArchViolation => found !== undefined),
        ...literalViolations(sourceFile, file)
      );
    }
    // The scope type and the map names ARE the rule's subject, and each decays
    // the way a path does: move or rename either and every check goes on
    // passing over nothing — a type that is no longer declared here selects no
    // file, renamed maps match no access. So both throw rather than pass.
    const scopeModule = sourceFileAt(project, SCOPE_MODULE);
    if (!declaresScopeType(scopeModule)) {
      fail(
        `'${SCOPE_MODULE}' declares no '${SCOPE_TYPE}' type of its own, so no file is selected by importing it and this rule watches nothing. ${SUBJECT_MOVED}`
      );
    }
    const namesAMap = scopeModule
      ?.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .some((access) => CHANNEL_MAPS.has(access.getName()));
    if (namesAMap !== true) {
      fail(
        `'${SCOPE_MODULE}' names no scope map (${[...CHANNEL_MAPS].join(', ')}), so the seam this rule watches was renamed or moved. ${SUBJECT_MOVED}`
      );
    }
    return violations;
  },
};

export default rule;
