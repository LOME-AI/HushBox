import path from 'node:path';
import { ts } from 'ts-morph';
import { REPO_ROOT } from '../lib/source-scope.js';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The Playwright `projects` array is composed only of spreads over the project
 * registry (`scripts/lib/playwright/projects.ts`) — never of a project written into
 * the config by hand.
 *
 * Why: the registry is the single statement of which projects exist, and the CI
 * e2e matrix, the seeded persona cross-product and the run-set input are all
 * generated from it. A project appended to the config array instead would run
 * locally, read as an ordinary config edit, and appear in no CI job at all —
 * the defect the registry exists to make unrepresentable, reproduced one file
 * over. Nothing else catches it: the config's settings `Record` makes a
 * REGISTRY entry without settings a compile error, which is the opposite
 * direction, and no compiler check can object to an extra array element.
 *
 * The rule reads the config off the project's file system rather than its
 * parsed source files, because the layer's shared scope
 * (`lib/source-scope.ts`) globs workspace trees and selects no repository-root
 * file. Widening that scope would hand every other rule the root files at once;
 * a rule whose subject is one known file owns its own scope instead — the same
 * split `imports-declared-in-manifest` makes.
 *
 * What it does NOT prove, in three verified escapes — read the guard as partial:
 *
 *   - Nothing about the bodies of the mappers. A callback that returns a
 *     hand-written project object per registry entry still produces one project
 *     per registry entry, which is the invariant; a callback that consults
 *     something else to decide what a project IS passes.
 *   - It reads only this one config path — a second Playwright config elsewhere
 *     in the repository is invisible to it.
 *   - The element-access spelling passes:
 *     `cfg['projects'].push({ name: 'experiment' })` is accepted where
 *     `cfg.projects.push(…)` is refused, because the member check reads only the
 *     property-access form. Both halves verified by plant. It is a one-token
 *     mutation of the shape the rule does catch, and it is named rather than
 *     closed on purpose: catching it means enumerating member-access spellings,
 *     and an enumerating clause rots the day a new one appears.
 */

const CONFIG_PATH = 'playwright.config.ts';
const REGISTRY_PATH = 'scripts/lib/playwright/projects.ts';

/** The registry module, however the config spells the specifier. */
const REGISTRY_SPECIFIER = /(^|\/)scripts\/lib\/playwright\/projects(\.[cm]?[jt]s)?$/;

const HAND_WRITTEN_MESSAGE =
  `${CONFIG_PATH} writes a Playwright project into its projects array by hand. ` +
  `Which projects exist is stated once, in ${REGISTRY_PATH}, and the CI matrix is generated ` +
  'from it — so a project written here runs locally and in no CI job. Add it to E2E_PROJECTS ' +
  'there, give it a PROJECT_SETTINGS entry, and let the existing spreads carry it.';

const NOT_AN_ARRAY_MESSAGE =
  `${CONFIG_PATH}'s projects must be an array literal of spreads over ${REGISTRY_PATH} ` +
  'exports. A computed value hides which projects exist from this rule and from anyone ' +
  'reading the config; compose the array inline.';

const NO_PROJECTS_MESSAGE =
  `${CONFIG_PATH} declares no projects array. The Playwright projects are the run's units of ` +
  `work and the generated CI matrix derives from them; compose them in a projects array of ` +
  `spreads over ${REGISTRY_PATH} exports.`;

const MEMBER_ACCESS_MESSAGE =
  `${CONFIG_PATH} reaches a .projects member. The project list is composed exactly once, in ` +
  `the config literal, from spreads over ${REGISTRY_PATH}, and nothing in this file may reach ` +
  'it again — writing to it (push, reassign) adds projects the generated CI matrix never sees, ' +
  `and reading it back (mapping it for names or counts) asks the config a question ` +
  `${REGISTRY_PATH} already answers. Derive from a registry export instead.`;

const MISSING_CONFIG_MESSAGE =
  `${CONFIG_PATH} is missing from the repository root, where this rule reads it. It is the ` +
  `only gate keeping the Playwright project list derived from ${REGISTRY_PATH}; if the config ` +
  'moved, point this rule at its new path in the same change.';

function foreignSpreadMessage(label: string): string {
  return (
    `${CONFIG_PATH} spreads "${label}" into its projects array, which is not a value imported ` +
    `from ${REGISTRY_PATH}. A list built anywhere else can carry a project the generated CI ` +
    'matrix never sees. Spread a registry export instead, optionally through .map(...).'
  );
}

function foreignChainMessage(method: string): string {
  return (
    `${CONFIG_PATH} applies .${method}(...) to a registry list on the way into its projects ` +
    'array. Only .map(...) may sit in between: anything else drops projects locally or adds ' +
    `ones the generated CI matrix never sees. Change what ${REGISTRY_PATH} exports instead.`
  );
}

/** The value bindings the config takes from the registry, aliases resolved. */
interface RegistryBindings {
  readonly values: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
}

/** What one statement binds from the registry, or null when it binds nothing. */
function registryNamedBindings(statement: ts.Statement): ts.NamedImportBindings | null {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return null;
  }
  if (!REGISTRY_SPECIFIER.test(statement.moduleSpecifier.text)) return null;
  const clause = statement.importClause;
  // A type-only binding names no runtime value, so it can carry no project.
  if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return null;
  return clause.namedBindings ?? null;
}

function registryBindings(sourceFile: ts.SourceFile): RegistryBindings {
  const values = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    const bindings = registryNamedBindings(statement);
    if (bindings === null) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) values.add(element.name.text);
    }
  }
  return { values, namespaces };
}

/** The expression under the type-level and grouping wrappers TypeScript allows. */
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
}

/** A registry export named directly, or through a namespace import. */
function namesRegistryValue(node: ts.Expression, bindings: RegistryBindings): boolean {
  if (ts.isIdentifier(node)) return bindings.values.has(node.text);
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    bindings.namespaces.has(node.expression.text)
  );
}

type SpreadVerdict =
  | { readonly kind: 'derived' }
  | { readonly kind: 'chain'; readonly method: string }
  | { readonly kind: 'foreign'; readonly label: string };

/**
 * What one spread carries: a registry list (optionally mapped), a registry list
 * put through a call that can change its length, or something else entirely.
 */
function classifySpread(expression: ts.Expression, bindings: RegistryBindings): SpreadVerdict {
  const root = unwrap(expression);
  let current = root;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const method = current.expression.name.text;
    if (method !== 'map') return { kind: 'chain', method };
    current = unwrap(current.expression.expression);
  }
  if (namesRegistryValue(current, bindings)) return { kind: 'derived' };
  return { kind: 'foreign', label: root.getText().replaceAll(/\s+/g, ' ') };
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function violation(sourceFile: ts.SourceFile, node: ts.Node, message: string): ArchViolation {
  return { file: CONFIG_PATH, line: lineOf(sourceFile, node), message };
}

function isProjectsProperty(node: ts.PropertyAssignment): boolean {
  return (
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'projects'
  );
}

function projectsArrayViolations(
  sourceFile: ts.SourceFile,
  property: ts.PropertyAssignment,
  bindings: RegistryBindings
): ArchViolation[] {
  const initializer = unwrap(property.initializer);
  if (!ts.isArrayLiteralExpression(initializer)) {
    return [violation(sourceFile, initializer, NOT_AN_ARRAY_MESSAGE)];
  }
  return initializer.elements.flatMap((element) => {
    if (!ts.isSpreadElement(element)) {
      return [violation(sourceFile, element, HAND_WRITTEN_MESSAGE)];
    }
    const verdict = classifySpread(element.expression, bindings);
    if (verdict.kind === 'derived') return [];
    return [
      violation(
        sourceFile,
        element,
        verdict.kind === 'chain'
          ? foreignChainMessage(verdict.method)
          : foreignSpreadMessage(verdict.label)
      ),
    ];
  });
}

/** Every `.projects` member reached anywhere in the config. */
function memberAccessViolations(sourceFile: ts.SourceFile): ArchViolation[] {
  const violations: ArchViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'projects') {
      violations.push(violation(sourceFile, node, MEMBER_ACCESS_MESSAGE));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function projectsProperties(sourceFile: ts.SourceFile): ts.PropertyAssignment[] {
  const properties: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && isProjectsProperty(node)) properties.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return properties;
}

function configViolations(sourceFile: ts.SourceFile): ArchViolation[] {
  const properties = projectsProperties(sourceFile);
  if (properties.length === 0) {
    return [{ file: CONFIG_PATH, line: 1, message: NO_PROJECTS_MESSAGE }];
  }
  const bindings = registryBindings(sourceFile);
  return [
    ...properties.flatMap((property) => projectsArrayViolations(sourceFile, property, bindings)),
    ...memberAccessViolations(sourceFile),
  ];
}

const rule: ArchRule = {
  name: 'playwright-projects-from-registry',
  check(project) {
    const fileSystem = project.getFileSystem();
    const filePath = path.join(REPO_ROOT, CONFIG_PATH);
    if (!fileSystem.fileExistsSync(filePath)) {
      return [{ file: CONFIG_PATH, line: 1, message: MISSING_CONFIG_MESSAGE }];
    }
    return configViolations(
      ts.createSourceFile(
        CONFIG_PATH,
        fileSystem.readFileSync(filePath),
        ts.ScriptTarget.Latest,
        true
      )
    );
  },
};

export default rule;
