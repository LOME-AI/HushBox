import path from 'node:path';
import { ts } from 'ts-morph';
import { assertNamedPathsExist, failWith, sourceFileAt } from '../lib/paths.js';
import { REPO_ROOT } from '../lib/source-scope.js';
import type { Project, Type } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The lint gate that refuses a bare `.set` of a request-scoped variable watches
 * exactly the variables the ambient request scope declares.
 *
 * WHY THE TWO LISTS EXIST AT ALL. `ScopedVariable` is the type the scope is
 * built from; the vendored `no-bare-scoped-set` rule carries the same names as
 * string literals because an ESLint rule is a `.mjs` module and cannot import a
 * TypeScript type — there is no spelling that would let the gate read the type
 * directly. So the second list is forced, and what is not forced is leaving it
 * unattached: a curated list whose source of truth is a type sits at no rung of
 * the maintenance ladder, and this rule is what puts it on "refused at the
 * gate".
 *
 * THE DIRECTION THAT FAILS SILENTLY is a variable added to the type alone. The
 * scope starts carrying it, `c.set` starts being able to diverge `c.var` from
 * it, and every gate in the repository stays green — the lint rule is still
 * enforcing, just not over the new variable. The opposite direction, a key in
 * the gate the type no longer declares, fails nothing either: the rule goes on
 * refusing writes to a name the ambient scope has stopped holding, which reads
 * as protection and is noise. Both are reported, because a set equality that
 * held in one direction would let the pair drift on the other.
 *
 * WHAT IT READS, AND WHY EACH SIDE IS READ THE WAY IT IS. The type side is read
 * through the checker rather than off the union's syntax, so the derivation
 * survives the alias being written as something other than a literal union. The
 * gate side is a `.mjs` file, which the layer's globs do not select and the
 * project therefore has not parsed, so it is read off the project's file system
 * and parsed with the script kind its extension implies — the same reading
 * `dev-servers-read-passed-through-env` performs on the config files it chases.
 *
 * WHAT IT DOES NOT PROVE. It reads the list the gate declares, never that the
 * gate's matcher consults that list — a rule rewritten to test its keys some
 * other way would leave `SCOPED_KEYS` standing and pass here. The lint rule's
 * own colocated suite is what holds the matcher to its keys, one case per key,
 * and the two together are what close the pair.
 *
 * Every shape it cannot read ABORTS the run rather than passing over: both
 * lists are this rule's own subject, and a subject that has moved leaves no
 * violation to report, only a check that has quietly stopped checking.
 */

const RULE_NAME = 'scoped-set-gate-matches-the-scoped-type';

const fail: (message: string) => never = failWith(RULE_NAME);

/** The module declaring what the ambient request scope carries. */
const SCOPE_MODULE = 'apps/api/src/lib/context/request-scope.ts';

/** The alias in it whose members ARE the scoped variables. */
const SCOPE_TYPE = 'ScopedVariable';

/** The vendored lint rule standing over bare writes to those variables. */
const GATE_MODULE = 'packages/config/eslint-extensions/rules/no-bare-scoped-set.mjs';

/** The list in it the gate matches a `.set` key against. */
const GATE_LIST = 'SCOPED_KEYS';

/** The string literal members of a type, or undefined when any member is not one. */
function stringMembers(type: Type): string[] | undefined {
  const members = type.isUnion() ? type.getUnionTypes() : [type];
  const values = members.map((member) => member.getLiteralValue());
  const strings = values.filter((value) => typeof value === 'string');
  return strings.length === values.length ? strings : undefined;
}

/** The variables the ambient scope declares, read off the type the scope is built from. */
function scopedVariables(project: Project): string[] {
  assertNamedPathsExist(
    RULE_NAME,
    project,
    [SCOPE_MODULE],
    `It is where \`${SCOPE_TYPE}\` is declared, and the lint gate's key list is derived from it.`
  );
  const sourceFile = sourceFileAt(project, SCOPE_MODULE);
  const alias = sourceFile?.getTypeAlias(SCOPE_TYPE);
  if (alias === undefined) {
    fail(
      `'${SCOPE_MODULE}' declares no \`${SCOPE_TYPE}\`, so nothing here states which variables ` +
        `the ambient request scope carries and the lint gate's list has no source to be held to.`
    );
  }
  const members = stringMembers(alias.getType());
  if (members === undefined) {
    fail(
      `\`${SCOPE_TYPE}\` is not a union of string literals, so its members cannot be compared ` +
        `with the literal keys the lint gate carries.`
    );
  }
  return members;
}

/** The declaration of a name among a module's own top-level statements. */
function declarationOf(source: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declared = statement.declarationList.declarations.find(
      (declaration) => declaration.name.getText(source) === name
    );
    if (declared !== undefined) return declared;
  }
  return undefined;
}

/**
 * The array literal a declaration's list is built from. The container is read
 * loosely — a `Set` built from a literal, or the literal itself — because which
 * collection the gate holds its keys in is its own business; the literal is read
 * strictly, because it is the thing being compared.
 */
function keyList(declaration: ts.VariableDeclaration): ts.ArrayLiteralExpression | undefined {
  const { initializer } = declaration;
  const candidate =
    initializer !== undefined && ts.isNewExpression(initializer)
      ? initializer.arguments?.[0]
      : initializer;
  return candidate !== undefined && ts.isArrayLiteralExpression(candidate) ? candidate : undefined;
}

/** The string keys an array literal holds, or undefined when any element is not one. */
function literalKeys(list: ts.ArrayLiteralExpression | undefined): string[] | undefined {
  if (list === undefined) return undefined;
  const values = list.elements.map((element) =>
    ts.isStringLiteral(element) ? element.text : undefined
  );
  const keys = values.filter((value) => value !== undefined);
  return keys.length === values.length ? keys : undefined;
}

/** The gate's key list and the line it is declared on. */
interface GateKeys {
  readonly keys: string[];
  readonly line: number;
}

/** The keys the lint gate carries, read off the rule module's own source. */
function gateKeys(project: Project): GateKeys {
  const gatePath = path.join(REPO_ROOT, GATE_MODULE);
  const fileSystem = project.getFileSystem();
  if (!fileSystem.fileExistsSync(gatePath)) {
    fail(
      `'${GATE_MODULE}' is not there, so the rule that refuses a bare write to a request-scoped ` +
        `variable either moved or is gone, and nothing states what the gate stands over.`
    );
  }
  const source = ts.createSourceFile(
    gatePath,
    fileSystem.readFileSync(gatePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const declaration = declarationOf(source, GATE_LIST);
  if (declaration === undefined) {
    fail(
      `'${GATE_MODULE}' declares no \`${GATE_LIST}\`, so nothing there states which variables ` +
        `the gate stands over.`
    );
  }
  const keys = literalKeys(keyList(declaration));
  if (keys === undefined) {
    fail(
      `\`${GATE_LIST}\` in '${GATE_MODULE}' is not a list of string literals, so the keys the ` +
        `gate stands over cannot be read off it.`
    );
  }
  return {
    keys,
    line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
  };
}

/** The violation a variable the gate does not watch produces. */
function ungated(key: string, line: number): ArchViolation {
  return {
    file: GATE_MODULE,
    line,
    message:
      `\`${SCOPE_TYPE}\` (${SCOPE_MODULE}) declares '${key}' and \`${GATE_LIST}\` does not ` +
      `carry it, so a bare \`.set('${key}', …)\` writes \`c.var\` alone and no gate refuses it.`,
  };
}

/** The violation a key naming no scoped variable produces. */
function unscoped(key: string, line: number): ArchViolation {
  return {
    file: GATE_MODULE,
    line,
    message:
      `\`${GATE_LIST}\` carries '${key}' and \`${SCOPE_TYPE}\` (${SCOPE_MODULE}) does not ` +
      `declare it, so the gate stands over a variable the ambient request scope no longer holds.`,
  };
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project: Project): ArchViolation[] {
    const declared = scopedVariables(project);
    const { keys, line } = gateKeys(project);
    const carried = new Set(keys);
    const scoped = new Set(declared);
    return [
      ...declared.filter((key) => !carried.has(key)).map((key) => ungated(key, line)),
      ...keys.filter((key) => !scoped.has(key)).map((key) => unscoped(key, line)),
    ];
  },
};

export default rule;
