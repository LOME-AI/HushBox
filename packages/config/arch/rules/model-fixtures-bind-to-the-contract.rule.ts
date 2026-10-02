import path from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';
import { REPO_ROOT, WEB_SOURCE_TREE } from '../lib/source-scope.js';
import type { ObjectLiteralExpression, SourceFile, Type } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A catalog row written in an `apps/web` test sits where the compiler checks it
 * against the wire contract.
 *
 * WHAT THE DEFECT IS, and it is not a missing annotation. A stub built with no
 * declared return type infers one from its own empty default —
 * `vi.fn(() => ({ models: [], … }))` infers `models: never[]` — so every fixture
 * later written into that position is checked against nothing. Rows that the
 * models endpoint cannot emit then typecheck green, and a component keeps
 * passing against a catalog shape production never sees. Every such row in the
 * tree was bound to the contract by hand before this rule existed, which is a
 * fix made of data: one test file added afterwards with an unannotated stub
 * reintroduces the whole class. That is what this rule stands over.
 *
 * THE PROPERTY IS THE CONTEXTUAL TYPE, not the presence of a cast. An earlier
 * sweep keyed on type assertions and could only find a fixture somebody had
 * been FORCED to suppress; a fixture in a position that was never checked needs
 * no suppression, so nobody ever wrote one and there was nothing to key on. The
 * contextual type is what the compiler actually checks a literal against, so it
 * is the property the defect is defined by, and an assertion is merely one way
 * of destroying it.
 *
 * WHAT COUNTS AS CHECKED is that the position ACCEPTS a contract row and
 * CONSTRAINS one, not that it IS the contract. `Partial<Model>` and
 * `Readonly<Pick<Model, …>>` are both live in this tree and both check every
 * property they are handed against the contract's own; demanding the bare
 * contract would fire on legitimate code and a rule that fires on legitimate
 * code gets deleted. Whether the position was SPELLED with the contract's name
 * is not readable — a mapped type reached through a parameter default arrives
 * as an anonymous instantiation with its alias gone — so this asks the compiler
 * two things instead: is a contract row assignable here, and does the position
 * declare a property the contract declares. The second half is what keeps the
 * first from answering vacuously — `any`, `unknown`, `Record<string, unknown>`,
 * `object` and `{}` each take a contract row whole while declaring nothing for
 * any of it to be checked against.
 *
 * WHAT COUNTS AS MODEL-SHAPED is derived from the contract rather than listed,
 * so a property added to the contract becomes evidence without an edit here.
 * The literal must carry `id` and at least one property the catalog declares —
 * less {@link NOT_EVIDENCE}, the handful of contract property names that other
 * domain types in this repository also carry, each named there with the type
 * that carries it. Deriving over listing chooses the loud failure: a new
 * contract property that other rows also carry over-collects and gets held back
 * here in one line, where a fixed list would go on silently missing rows.
 *
 * ASSERTION MATCHERS ARE OUT. An object handed to `expect(…).toMatchObject(…)`
 * or a sibling matcher is an EXPECTED value, compared against a real one at run
 * time: a property the contract no longer carries makes that assertion fail
 * rather than pass silently, so the drift this rule exists to catch is already
 * caught there. The walk stops at a function boundary, so a fixture built
 * inside a callback that happens to sit under `expect(…)` is still judged.
 *
 * WHAT THIS DOES NOT REACH, stated as the residual it is:
 * - A hand-written interface that mirrors the contract closely enough to accept
 *   a contract row. It is a duplication defect rather than an unchecked
 *   position, and the fixtures bound to it ARE checked — against a copy.
 * - A row built by a factory and handed to the position as an identifier: the
 *   literal is judged where it is written, which is the factory's own return
 *   position, and that is where the annotation belongs.
 * - An assertion that SUPPLIES the contract rather than destroying it —
 *   `{ id, provider, modality } as Model`. The assertion is what suppressed
 *   the compiler's own check of the row, and it is also what makes the
 *   contract the position's type, so the row reads as checked here.
 * - Production web files. A fixture is a test-file shape; production code is
 *   checked by the consumers it is written for.
 */

/** The module that declares the wire contract, and the type that is it. */
const CONTRACT_MODULE = 'packages/shared/src/schemas/api/models.ts';
const CONTRACT_TYPE = 'Model';

/** The web package's own program, which is what resolves its `@/` alias. */
const WEB_TSCONFIG = 'apps/web/tsconfig.json';

/** The alias whose resolution decides whether a handed project can be read for types. */
const WEB_ALIAS = '@/*';

/**
 * Contract property names that are NOT evidence of a catalog row on their own,
 * each with a type in this repository that also carries it. Held back from the
 * derived marker set; every entry must still BE a contract property, which is
 * asserted, so a contract rename retires an entry loudly instead of leaving it
 * inert.
 */
const NOT_EVIDENCE: Readonly<Record<string, string>> = {
  id: 'Every row in the system carries one.',
  name: 'A selected-model entry, a store row and a display record all carry one.',
  description: 'Generic prose field; carried by workflow and definition records.',
  created: 'A creation stamp is on most persisted rows.',
  isSmartModel: 'Assistant message rows carry it to mark a Smart Model answer.',
  reasoning: 'Message content items carry a reasoning record of their own.',
};

const RULE = 'model-fixtures-bind-to-the-contract';
const fail: (message: string) => never = failWith(RULE);

const MESSAGE =
  'A catalog row written where nothing checks it against the wire contract ' +
  `(${CONTRACT_TYPE} in ${CONTRACT_MODULE}). A stub with no declared return type infers ` +
  'its shape from its own empty default, so every fixture in that position is checked ' +
  'against nothing and a row the models endpoint cannot emit typechecks green. Declare ' +
  'the position: annotate the stub factory (apps/web/src/test-utils/models-hook-stub.ts ' +
  'is the shared one for a useModels stub), annotate the declaration, or `satisfies` the ' +
  'contract at the literal.';

/**
 * The program this rule reads types off.
 *
 * The layer's shared project is built with no compiler configuration, so the
 * web package's `@/` alias resolves to nothing in it: a fixture reached through
 * an aliased type reads as having no contextual type at all, and legitimate
 * code is reported. This rule therefore builds a program from the web package's
 * own tsconfig — unless it is handed one that already resolves that alias,
 * which is how the colocated test drives it.
 */
function typedWebProject(project: Project): Project {
  /* v8 ignore start -- @preserve the CLI path: the layer's shared project carries no compiler
     configuration, so this is the arm `pnpm arch:check` takes on every run, in the pre-push
     gate and in CI. Reaching it from an in-memory test means building the web package's whole
     program inside the test, which is the reason the coverage config already holds the
     arch runner itself out. */
  const paths: Record<string, string[]> | undefined = project.getCompilerOptions().paths;
  if (paths?.[WEB_ALIAS] === undefined) {
    return new Project({ tsConfigFilePath: path.join(REPO_ROOT, WEB_TSCONFIG) });
  }
  /* v8 ignore stop */
  return project;
}

/** The contract type, read off its declaration; every way of missing it throws. */
function contractType(project: Project): Type {
  const module = sourceFileAt(project, CONTRACT_MODULE);
  if (module === undefined) {
    fail(
      `'${CONTRACT_MODULE}' names no file in the scanned tree, so no fixture can be judged ` +
        'against the wire contract. Point this rule at its new home.'
    );
  }
  const declaration = module.getTypeAlias(CONTRACT_TYPE);
  if (declaration === undefined) {
    fail(
      `'${CONTRACT_TYPE}' is no longer declared in ${CONTRACT_MODULE}, so no fixture can be ` +
        'judged against the wire contract. Point this rule at its new name.'
    );
  }
  return declaration.getType();
}

/**
 * The property names that mark a literal as a catalog row: the contract's own,
 * less the ones other domain types share.
 */
function markerNames(contract: Type): ReadonlySet<string> {
  const declared = new Set(contract.getApparentProperties().map((property) => property.getName()));
  for (const held of Object.keys(NOT_EVIDENCE)) {
    if (declared.has(held)) continue;
    fail(
      `'${held}' is held back as weak evidence of a catalog row but is no longer a property of ` +
        `${CONTRACT_TYPE}. Drop the entry, or point it at the property that replaced it.`
    );
  }
  return new Set([...declared].filter((property) => !(property in NOT_EVIDENCE)));
}

/** The names a literal writes its properties under, quoting stripped. */
function propertyNames(literal: ObjectLiteralExpression): ReadonlySet<string> {
  const names = new Set<string>();
  for (const property of literal.getProperties()) {
    if (Node.isSpreadAssignment(property)) continue;
    names.add(property.getName().replaceAll(/^['"`]|['"`]$/g, ''));
  }
  return names;
}

/** A literal shaped like a catalog row: an `id` plus something only the catalog declares. */
function isModelShaped(literal: ObjectLiteralExpression, markers: ReadonlySet<string>): boolean {
  const names = propertyNames(literal);
  return names.has('id') && [...names].some((name) => markers.has(name));
}

/** Whether the position declares any property the contract declares. */
function constrainsContract(position: Type, contract: Type): boolean {
  return contract
    .getApparentProperties()
    .some((property) => position.getProperty(property.getName()) !== undefined);
}

/**
 * The alternatives a position offers a literal. A union is asked member by
 * member because that is how the literal is checked: the compiler picks the
 * member the literal matches, so `Model | undefined` checks the row against
 * the contract. Asked whole it would answer for neither member — a union
 * declares only what every member declares, and `undefined` declares nothing.
 */
function alternatives(position: Type): Type[] {
  return position.isUnion() ? position.getUnionTypes() : [position];
}

/**
 * Whether this position checks a contract row.
 *
 * Two halves of one question, because acceptance alone answers it vacuously:
 * the position must accept a contract row AND constrain something about the
 * row it accepts. `Record<string, unknown>`, `object` and `{}` take every
 * object there is and declare not one property to check any of them against,
 * which is the same nothing `any` and `unknown` do by accepting every value at
 * all — so all five fall out of the second half rather than a list of names,
 * and `never` out of the first, because nothing is assignable to it.
 */
function checksContract(position: Type | undefined, contract: Type): boolean {
  if (position === undefined) return false;
  return alternatives(position).some(
    (alternative) =>
      contract.isAssignableTo(alternative) && constrainsContract(alternative, contract)
  );
}

/** The identifier a callee chain is rooted at, whatever it is reached through. */
function calleeRoot(call: Node): Node {
  let root = call;
  while (
    Node.isPropertyAccessExpression(root) ||
    Node.isElementAccessExpression(root) ||
    Node.isCallExpression(root)
  ) {
    root = root.getExpression();
  }
  return root;
}

/**
 * Whether this literal is an EXPECTED value handed to an assertion matcher —
 * an argument of a call rooted at `expect`, reached without crossing into a
 * function body.
 */
function isMatcherArgument(literal: ObjectLiteralExpression): boolean {
  let child: Node = literal;
  let parent = child.getParent();
  while (parent !== undefined && !Node.isFunctionLikeDeclaration(parent)) {
    if (Node.isCallExpression(parent)) {
      if (!parent.getArguments().includes(child)) return false;
      const root = calleeRoot(parent.getExpression());
      return Node.isIdentifier(root) && root.getText() === 'expect';
    }
    child = parent;
    parent = parent.getParent();
  }
  return false;
}

/** The web test files this rule judges. */
function isInScope(sourceFile: SourceFile): boolean {
  const filePath = relativePath(sourceFile);
  return filePath.includes(WEB_SOURCE_TREE) && isTestFile(filePath);
}

/** Every catalog-shaped literal in ONE file whose position does not check it. */
function fileViolations(
  sourceFile: SourceFile,
  markers: ReadonlySet<string>,
  contract: Type
): ArchViolation[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
    .filter(
      (literal) =>
        isModelShaped(literal, markers) &&
        !isMatcherArgument(literal) &&
        !checksContract(literal.getContextualType(), contract)
    )
    .map((literal) => ({
      file: relativePath(sourceFile),
      line: literal.getStartLineNumber(),
      message: MESSAGE,
    }));
}

/** Every catalog-shaped literal in a web test whose position does not check it. */
function modelFixtureViolations(project: Project): ArchViolation[] {
  const contract = contractType(project);
  const markers = markerNames(contract);
  return project
    .getSourceFiles()
    .filter((sourceFile) => isInScope(sourceFile))
    .flatMap((sourceFile) => fileViolations(sourceFile, markers, contract));
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    return modelFixtureViolations(typedWebProject(project));
  },
};

export default rule;
