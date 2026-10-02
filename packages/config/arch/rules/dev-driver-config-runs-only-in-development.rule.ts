import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile, relativePath } from '../lib/paths.js';
import { REPO_ROOT, discoverSourceTrees, workspaceSourceTree } from '../lib/source-scope.js';
import type { CallExpression, PrefixUnaryExpression, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The local driver configuration reaches the database factory only where the
 * environment is development — on the development side of an environment
 * branch, or after a refusal of a non-local connection string.
 *
 * Why a rule rather than a test: the factory writes the Neon driver's
 * module-level `neonConfig` once and never restores it, so the first call in a
 * process that carries the development configuration leaves every later call in
 * that isolate on the local-proxy settings whatever options it passes. A test
 * that builds both arms therefore observes the same driver state on each, which
 * is why the branch's own test can assert no more than that both arms return an
 * object: invert the branch, or delete it, and the test stays green. Nothing
 * else reports it either — typecheck and lint are indifferent to which arm an
 * options object sits in.
 *
 * WHAT IT PROVES IS THE CALL SHAPE, NEVER THE RESULTING CLIENT. It cannot show
 * that a client built under the guard connects, and no static rule can. What it
 * does establish is that the development configuration is never reached on the
 * production side of a branch, which is the mutation the branch's own test
 * cannot see.
 *
 * POLARITY, NOT MERE GUARDEDNESS, IS THE CLAIM. A rule asking only that the call
 * sit under an environment branch passes an inverted branch, because the
 * inverted branch is still branching on the environment. So each guard is read
 * for which way it runs: the development configuration must be on the arm that
 * runs when the environment IS development — the true arm of `isDev`, the false
 * arm of `isProduction`, and the same for either negated. A condition assembled
 * from several terms says nothing this rule reads, so the call is reported: the
 * same conservative default as an unclassified flag, where a shape the rule
 * cannot read fails the gate rather than passing over the corpus in silence.
 *
 * THE FLAG NAMES ARE CLASSIFIED CONSERVATIVELY AND THEIR DECAY IS LOUD. Only
 * flags that settle the development-versus-production axis prove anything here;
 * anything else — a CI or end-to-end flag, a flag added to the environment
 * contract tomorrow — proves nothing and leaves the call reported. That default
 * is what makes a completeness check against the environment contract
 * unnecessary rather than merely absent: an unclassified or renamed flag can
 * only make this rule stricter, never laxer, so every way these names can go
 * stale fails the gate rather than passing over the corpus in silence.
 *
 * TWO GUARDS, BECAUSE THERE ARE TWO PROOFS. An environment branch is one. A
 * function that refuses a connection string outside the local host before
 * reaching the factory is the other, and it is not the weaker of the two: it
 * establishes the local proxy is being asked for a local database, which is the
 * fact the environment branch establishes indirectly. Reading only the branch
 * idiom would report the refusal shape as a violation, and exempting the file
 * that carries it would be an exception list where a second sanctioned proof
 * belongs.
 *
 * WHAT IT DOES NOT CATCH: the configuration reaching the factory through a
 * variable (`const options = { neonDev: LOCAL_NEON_DEV_CONFIG }; createDb(url,
 * options)`), because the rule reads the arguments written at the call and an
 * assembled options object leaves nothing there to read; and a guard written in
 * an enclosing function rather than the one holding the call, which is refused
 * rather than followed — a function defined under a branch can be called from
 * anywhere, so reading the branch above it would prove something the code does
 * not say.
 */

const RULE = 'dev-driver-config-runs-only-in-development';

/** The database factory, named as it is written at a call site. */
const FACTORY = 'createDb';

/** The factory option and the shared constant that carry the local driver settings. */
const DEV_OPTION = 'neonDev';
const DEV_CONFIG = 'LOCAL_NEON_DEV_CONFIG';

/** Environment flags whose truth means the environment IS development. */
const DEVELOPMENT_FLAGS: ReadonlySet<string> = new Set(['isDev', 'isLocalDev', 'isDevServer']);

/** Environment flags whose truth means the environment is NOT development. */
const PRODUCTION_FLAGS: ReadonlySet<string> = new Set(['isProduction']);

/** The predicate that settles a connection string as local, read as a call. */
const LOCALITY_PREDICATE = 'isLocalHostUrl';

/**
 * Directory names marking a tree that exists only so tests can run, matched
 * wherever they sit so the exemption survives the tree moving. Both hold
 * modules the repository's own test-file spelling does not reach, which is why
 * they are named here rather than left to {@link isTestFile}.
 */
const TEST_ONLY_DIRECTORIES: Readonly<Record<string, string>> = {
  'test-support': 'Helpers imported only by integration tests; nothing here ships to the Worker.',
  'workers-validation':
    'The workerd harness a node-environment test drives; never wired into a composition root.',
};

/**
 * The tooling workspace, anchored at the repository root: `apps/sandbox/scripts`
 * is a real directory in another workspace, and a contains-`scripts/` reading of
 * the same question would hand this rule a second tree to exempt while looking
 * identical to the one it means. It is out for the reason
 * `dev-fixtures-unreachable-from-production` holds it out: a command-line entry
 * point in that workspace never ships to the Worker, and every one of its
 * database clients is a local one on purpose.
 */
const SCRIPTS_ROOT = path.join(
  REPO_ROOT,
  workspaceSourceTree(discoverSourceTrees(REPO_ROOT), 'scripts')
);

const REMEDY =
  'the local driver configuration must reach the factory only where the environment is ' +
  'development: put it on the arm an environment branch runs in development ' +
  '(the true arm of isDev, the false arm of isProduction), or refuse a non-local connection ' +
  'string before the call. A branch alone is not enough — an inverted branch is still a branch.';

/** Which way a condition runs: true means development, or true means production. */
type Polarity = 'development' | 'production';

function opposite(polarity: Polarity | undefined): Polarity | undefined {
  if (polarity === undefined) return undefined;
  return polarity === 'development' ? 'production' : 'development';
}

/** The name a condition tests, off an identifier, a property access, or a call. */
function testedName(expression: Node): string | undefined {
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getName();
  if (Node.isCallExpression(expression)) return testedName(expression.getExpression());
  return undefined;
}

/**
 * What a condition being TRUE says about the environment, or undefined when it
 * says nothing this rule can read.
 */
function polarityOf(expression: Node): Polarity | undefined {
  if (Node.isParenthesizedExpression(expression)) return polarityOf(expression.getExpression());
  if (Node.isPrefixUnaryExpression(expression)) return negationPolarity(expression);
  return namedPolarity(expression);
}

/** A negation inverts what its operand says; any other unary operator says nothing. */
function negationPolarity(expression: PrefixUnaryExpression): Polarity | undefined {
  return expression.getOperatorToken() === SyntaxKind.ExclamationToken
    ? opposite(polarityOf(expression.getOperand()))
    : undefined;
}

/** What a flag or predicate named directly says about the environment. */
function namedPolarity(expression: Node): Polarity | undefined {
  const name = testedName(expression);
  if (name === undefined) return undefined;
  if (Node.isCallExpression(expression)) {
    return name === LOCALITY_PREDICATE ? 'development' : undefined;
  }
  if (DEVELOPMENT_FLAGS.has(name)) return 'development';
  return PRODUCTION_FLAGS.has(name) ? 'production' : undefined;
}

/** True when the statement refuses outright — it throws, however it is wrapped. */
function alwaysThrows(statement: Node): boolean {
  if (Node.isThrowStatement(statement)) return true;
  return (
    Node.isBlock(statement) && statement.getStatements().some((node) => Node.isThrowStatement(node))
  );
}

/**
 * A refusal standing between the top of a block and `statement`: an `if` with no
 * else whose condition means "not development" and whose body throws, so
 * everything after it runs only in development.
 */
function refusedBefore(block: Node, statement: Node): boolean {
  if (!Node.isBlock(block) && !Node.isSourceFile(block)) return false;
  return block
    .getStatements()
    .filter((candidate) => candidate.getPos() < statement.getPos())
    .some(
      (candidate) =>
        Node.isIfStatement(candidate) &&
        candidate.getElseStatement() === undefined &&
        alwaysThrows(candidate.getThenStatement()) &&
        polarityOf(candidate.getExpression()) === 'production'
    );
}

/** The node kinds the upward walk refuses to cross, each being its own call site. */
function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/** The environment a two-armed guard establishes for whichever arm holds `child`. */
function armPolarity(
  condition: Node,
  whenTrue: Node,
  whenFalse: Node | undefined,
  child: Node
): Polarity | undefined {
  if (whenTrue === child) return polarityOf(condition);
  if (whenFalse === child) return opposite(polarityOf(condition));
  return undefined;
}

/** What the branch one step above the call establishes, when it is a branch at all. */
function guardPolarity(parent: Node, child: Node): Polarity | undefined {
  if (Node.isConditionalExpression(parent)) {
    return armPolarity(parent.getCondition(), parent.getWhenTrue(), parent.getWhenFalse(), child);
  }
  if (Node.isIfStatement(parent)) {
    return armPolarity(
      parent.getExpression(),
      parent.getThenStatement(),
      parent.getElseStatement(),
      child
    );
  }
  return undefined;
}

/**
 * True when the call runs only in development. The walk stops at the function
 * holding the call: a branch further out governs where that function was
 * DEFINED, never where it is called from.
 */
function runsOnlyInDevelopment(call: Node): boolean {
  let child = call;
  let parent = child.getParent();
  while (parent !== undefined) {
    if (guardPolarity(parent, child) === 'development') return true;
    if (refusedBefore(parent, child)) return true;
    if (isFunctionLike(parent)) return false;
    child = parent;
    parent = child.getParent();
  }
  return false;
}

/** True when the call's own arguments carry the local driver configuration. */
function carriesDevConfig(call: CallExpression): boolean {
  return call.getArguments().some((argument) => {
    if (Node.isIdentifier(argument) && argument.getText() === DEV_CONFIG) return true;
    return argument
      .getDescendants()
      .some(
        (node) =>
          (Node.isIdentifier(node) && node.getText() === DEV_CONFIG) ||
          (Node.isPropertyAssignment(node) && node.getName() === DEV_OPTION)
      );
  });
}

/**
 * Every call of the factory carrying the development configuration. The callee
 * is read as a bare identifier: a method of the same name on an injected
 * runtime (`runtime.createDb(env)`) is a seam the caller supplies rather than
 * this factory, and reading it here would report the injection point instead of
 * the branch.
 */
function devConfigCalls(sourceFile: SourceFile): CallExpression[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      const callee = call.getExpression();
      return Node.isIdentifier(callee) && callee.getText() === FACTORY;
    })
    .filter((call) => carriesDevConfig(call));
}

function hasTestOnlyDirectory(filePath: string): boolean {
  const segments = new Set(filePath.split('/'));
  return Object.keys(TEST_ONLY_DIRECTORIES).some((directory) => segments.has(directory));
}

function isInScope(sourceFile: SourceFile): boolean {
  const filePath = sourceFile.getFilePath();
  return (
    !isTestFile(filePath) && !filePath.startsWith(SCRIPTS_ROOT) && !hasTestOnlyDirectory(filePath)
  );
}

/**
 * The rule's own subject going missing reports nothing, so it throws instead:
 * every check would keep passing over a population that no longer exists.
 */
function assertPopulationExists(count: number): void {
  if (count > 0) return;
  throw new Error(
    `${RULE}: no production call of ${FACTORY} carries the local driver configuration ` +
      `(a \`${DEV_OPTION}\` option, or \`${DEV_CONFIG}\`), so this rule stands over nothing. ` +
      'Either the factory or the configuration was renamed — point the rule at the new ' +
      'spelling — or the local-proxy path was removed, and the rule should go with it.'
  );
}

const rule: ArchRule = {
  name: RULE,
  check(project: Project) {
    const calls = project
      .getSourceFiles()
      .filter((sourceFile) => isInScope(sourceFile))
      .flatMap((sourceFile) =>
        devConfigCalls(sourceFile).map((call) => ({ sourceFile, call }) as const)
      );
    assertPopulationExists(calls.length);

    return calls
      .filter(({ call }) => !runsOnlyInDevelopment(call))
      .map(
        ({ sourceFile, call }): ArchViolation => ({
          file: relativePath(sourceFile),
          line: call.getStartLineNumber(),
          message: `This ${FACTORY} call carries the local driver configuration with nothing proving the environment is development — ${REMEDY}`,
        })
      );
  },
};

export default rule;
