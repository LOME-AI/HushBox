/**
 * Refuses a test module that creates a directory at a path rooted in this
 * repository.
 *
 * A fixture tree staged inside the repository is enumerated by every scanner
 * the repository runs over itself, and it hurts in two ways at once. The loud
 * one: the architecture layer globs whole workspace trees, so a concurrent
 * `pnpm arch:check` that lists a fixture directory between one test's setup
 * and the next's teardown dies with a directory-not-found naming a path that is
 * nobody's source — a gate failing because a test was running, blamed on
 * whatever change happens to be in the tree. The quiet one is worse: a fixture
 * that survives the glob has its `.ts` files parsed into the project all the
 * architecture rules run over, so hand-written violating shapes are evaluated
 * as repository source. A crash is at least loud.
 *
 * Location is what closes both, not timing: the scanners' globs are all rooted
 * at the repository, so a path outside it is not a member of any set they
 * enumerate, at any speed and on any machine.
 *
 * WHAT IS REFUSED IS CREATION, NOT REFERENCE. A committed fixture tree is
 * checked in on purpose and read by tests that create and remove nothing, so a
 * module-relative path is refused only where a directory is made at it. Writing
 * a FILE into a directory that already exists is outside the rule: the
 * repository has a test that writes one deliberately, and reporting it would
 * make this a rule people turn off.
 *
 * HOW A PATH IS READ AS REPOSITORY-ROOTED. Only the anchors a module can reach
 * without importing one — its own location (`import.meta`, `__dirname`,
 * `__filename`) and the working directory (`process.cwd()`) — and only at the
 * ROOT of the expression, which for `path.join`/`path.resolve` is the first
 * argument. That is why a temporary root with a module-derived leaf is not
 * reported, and why a subdirectory of an already-temporary root is not either.
 * Bindings are followed through their initialiser AND their later assignments,
 * because a root declared empty and filled in a hook is the shape a
 * half-finished scratch-directory refactor leaves behind.
 *
 * WHAT THE SCANNERS DO NOT SEE IS NOT REPORTED. A path naming an install
 * directory or a dot-directory is left alone, because neither reaches any
 * scanner: the architecture layer subtracts `node_modules` by name, and its
 * glob does not descend into a dot-segment at all — measured against ts-morph's
 * own file system, where a `.ts` two levels inside one is absent from the
 * result the layer's glob shape returns. That is what keeps a Playwright
 * storage-state directory and a workspace-link fixture out of the rule; both
 * are persistent run material at a path their readers must name, and reporting
 * them would make this a rule people turn off. The suppression is read off any
 * literal segment anywhere in the expression, so it is wider than the root: a
 * visible directory named beside a hidden one is not reported either.
 *
 * ITS BOUND IS THE FILE. A path handed in by another module — a shared fixture
 * helper that itself resolves a repository root — carries no anchor at this
 * call site and is not reported. The rule is early warning at the moment the
 * pattern is written, which is where every known instance of it was written; it
 * is not a proof that no test can reach a repository path.
 */
import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

// Node types, derived from ESLint's own rule-node union: `@types/estree` does
// not resolve from this package, so an `import('estree')` specifier written
// here would not type-check. That union is estree-shaped, which is also the
// bound on the walk below — a TypeScript-only wrapper such as an `as` cast
// around a path expression is not a kind it names, so the walk stops there.
/** @typedef {import('eslint').Rule.Node} RuleNode */
/** @typedef {Extract<RuleNode, { type: 'CallExpression' }>} CallNode */
/** @typedef {Extract<RuleNode, { type: 'NewExpression' }>} NewNode */
/** @typedef {Extract<RuleNode, { type: 'MemberExpression' }>} MemberNode */
/** @typedef {Extract<RuleNode, { type: 'BinaryExpression' }>} BinaryNode */
/** @typedef {CallNode['arguments'][number] | MemberNode['object'] | BinaryNode['left']} PathNode */
/** @typedef {Extract<PathNode, { type: 'Identifier' }>} IdentifierNode */
/** @typedef {Extract<PathNode, { type: 'CallExpression' | 'NewExpression' }>} CallLikeNode */
/** @typedef {import('eslint').SourceCode} SourceCode */
/** @typedef {import('eslint').Scope.Variable} Variable */

/**
 * The calls that bring a directory into existence. `mkdtemp` is here because a
 * template rooted in the repository stages its run directory there, which is
 * the same defect with a random suffix.
 */
const DIRECTORY_CREATORS = new Set(['mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync']);

/**
 * The calls whose FIRST argument decides where the result is rooted; every
 * later argument is a leaf and cannot move the root out of a temporary
 * directory.
 */
const PATH_COMPOSERS = new Set(['join', 'resolve']);

/** The module's own location, in the two spellings a module can name it. */
const MODULE_LOCATION = new Set(['__dirname', '__filename']);

/** The call that names the working directory, which is inside the repository. */
const WORKING_DIRECTORY = 'cwd';

/** The one directory name every scanner in this repository subtracts. */
const INSTALL_DIRECTORY = 'node_modules';

/** A path segment no scanner glob descends into, the relative prefixes aside. */
const HIDDEN_SEGMENT = /^\.[^./\\]/;

/**
 * The name a call names its callee by, for a bare call and for a member call.
 *
 * @param {CallLikeNode} node
 * @returns {string | undefined}
 */
function calleeName(node) {
  const { callee } = node;
  const named = callee.type === 'MemberExpression' && !callee.computed ? callee.property : callee;
  return named.type === 'Identifier' ? named.name : undefined;
}

/**
 * Every expression a variable is ever given: its initialiser and each assignment.
 *
 * @param {Variable} variable
 * @returns {PathNode[]}
 */
function assignedExpressions(variable) {
  const expressions = [];
  for (const definition of variable.defs) {
    if (definition.node.type === 'VariableDeclarator' && definition.node.init !== null) {
      expressions.push(definition.node.init);
    }
  }
  for (const reference of variable.references) {
    if (reference.writeExpr) {
      expressions.push(reference.writeExpr);
    }
  }
  return expressions;
}

/**
 * What an identifier stands for, found in the innermost scope that binds it and
 * taken once, so a binding that refers back to itself terminates the walk.
 *
 * @param {IdentifierNode} node
 * @param {SourceCode} sourceCode
 * @param {Set<Variable>} seen
 * @returns {readonly PathNode[]}
 */
function bindingExpressions(node, sourceCode, seen) {
  // ESLint attaches `parent` to every node in the tree, but its published types
  // carry it only on the node a visitor is handed — so a node reached by
  // walking out of that one is spelled without it, and the scope lookup wants
  // exactly this node rather than some other spelling of it.
  /** @type {import('eslint').Scope.Scope | null} */
  let scope = sourceCode.getScope(/** @type {RuleNode} */ (node));
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) {
      if (seen.has(variable)) {
        return [];
      }
      seen.add(variable);
      return assignedExpressions(variable);
    }
    scope = scope.upper;
  }
  return [];
}

/**
 * The arguments a call contributes: its first alone when it composes a path root.
 *
 * @param {CallLikeNode} node
 * @param {boolean} rootOnly
 * @returns {readonly PathNode[]}
 */
function callArguments(node, rootOnly) {
  const name = calleeName(node);
  const composes = rootOnly && name !== undefined && PATH_COMPOSERS.has(name);
  return composes ? node.arguments.slice(0, 1) : node.arguments;
}

/**
 * Where one expression kind carries the path onwards.
 *
 * @param {PathNode} node
 * @param {SourceCode} sourceCode
 * @param {Set<Variable>} seen
 * @param {boolean} rootOnly
 * @returns {readonly PathNode[]}
 */
function pathParts(node, sourceCode, seen, rootOnly) {
  switch (node.type) {
    case 'Identifier': {
      return bindingExpressions(node, sourceCode, seen);
    }
    case 'CallExpression':
    case 'NewExpression': {
      return callArguments(node, rootOnly);
    }
    case 'MemberExpression': {
      return [node.object];
    }
    case 'TemplateLiteral': {
      return node.expressions;
    }
    case 'BinaryExpression': {
      return [node.left, node.right];
    }
    case 'AwaitExpression': {
      return [node.argument];
    }
    default: {
      return [];
    }
  }
}

/**
 * Every expression the path `node` is built from, bindings followed.
 * `rootOnly` narrows a path composer to the argument that decides its root.
 *
 * @param {PathNode} node
 * @param {SourceCode} sourceCode
 * @param {Set<Variable>} seen
 * @param {boolean} rootOnly
 * @returns {Generator<PathNode>}
 */
function* pathExpressions(node, sourceCode, seen, rootOnly) {
  yield node;
  for (const part of pathParts(node, sourceCode, seen, rootOnly)) {
    yield* pathExpressions(part, sourceCode, seen, rootOnly);
  }
}

/**
 * Whether this expression names a location that is inside the repository.
 *
 * @param {PathNode} node
 */
function isRepositoryAnchor(node) {
  if (node.type === 'MetaProperty') {
    return node.meta.name === 'import';
  }
  if (node.type === 'Identifier') {
    return MODULE_LOCATION.has(node.name);
  }
  return node.type === 'CallExpression' && calleeName(node) === WORKING_DIRECTORY;
}

/**
 * Whether a written path names a segment no scanner reaches.
 *
 * @param {string} value
 */
function hasUnscannedSegment(value) {
  return value
    .split(/[/\\]/)
    .some((segment) => segment === INSTALL_DIRECTORY || HIDDEN_SEGMENT.test(segment));
}

/**
 * Whether this expression writes out a segment no scanner reaches.
 *
 * @param {PathNode} node
 */
function namesUnscannedSegment(node) {
  if (node.type === 'Literal') {
    return typeof node.value === 'string' && hasUnscannedSegment(node.value);
  }
  if (node.type === 'TemplateLiteral') {
    return node.quasis.some((quasi) => hasUnscannedSegment(quasi.value.cooked ?? ''));
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid a test module from creating a directory inside the repository, where every scanner enumerates it.',
    },
    schema: [],
    messages: {
      repoRootedFixtureDirectory:
        "This stages a directory inside the repository, where the architecture scan and every other repo-wide scanner enumerates it: a scan that lists it between this test's setup and its teardown dies naming a path that is nobody's source, and any TypeScript left inside it is parsed as repository source. Stage it outside the repository instead — `withScratchDirectory` in `scripts/lib/scratch-directory.ts` makes one under the OS temp directory and removes it however the body ends.",
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) {
      return {};
    }
    const { sourceCode } = context;
    /** @param {PathNode} target */
    const isRepositoryDirectory = (target) =>
      [...pathExpressions(target, sourceCode, new Set(), true)].some((part) =>
        isRepositoryAnchor(part)
      ) &&
      ![...pathExpressions(target, sourceCode, new Set(), false)].some((part) =>
        namesUnscannedSegment(part)
      );

    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (name === undefined || !DIRECTORY_CREATORS.has(name)) {
          return;
        }
        const [target] = node.arguments;
        if (target === undefined || !isRepositoryDirectory(target)) {
          return;
        }
        context.report({ node, messageId: 'repoRootedFixtureDirectory' });
      },
    };
  },
};
