/**
 * A limiter never admits on failure. `consume` already surfaces an unreachable
 * Redis, a script error and an unreadable reply as a typed `unavailable` error
 * — there is no decision value a caller could mistake for admission. The only
 * way back to a fail-open limiter is at the call site, by turning that error
 * into a verdict.
 *
 * The repo's error channel is `Result`, not exceptions, so the shape that
 * matters most is the ordinary one: bind the `consume` result, ask `isErr()`,
 * and admit in that branch. The rule therefore tracks BINDINGS — a name
 * initialised from a `consume` chain, and a parameter annotated with
 * `RateLimitDecision`, which is how a decision reaches a shared responder —
 * and flags, off either:
 *
 * 1. Defaulting the Result (`unwrapOr`, `unwrapOrElse`, `orElse`), or mapping
 *    its error half to an admission with `match`. Best-effort work is
 *    legitimately defaulted all over the backend, which is why the rule keys
 *    on the `consume` binding rather than on the combinator: an unrelated
 *    `.unwrapOr(null)` stays legal.
 * 2. Admitting from the failure path of an `isErr()` / `isOk()` test, negation
 *    included, wherever that path is written: the branch of an `if` or a
 *    ternary; the statements an `else`-less `if` falls through to once the
 *    success branch has returned — reached across an `else if` chain and inside
 *    a `switch` case, since control resumes after the chain rather than where
 *    the guard happens to sit; and the operand a `||` or `&&` yields when the
 *    decision failed. Where the failure path is established, a bare `true`
 *    admits as much as an `{ allowed: true }` — a limiter returning
 *    `Promise<boolean>` spells its verdict that way.
 * 3. Producing an admission from a `catch` — the `try/catch` clause or a
 *    promise `.catch()` handler. Money, auth and admission fail fast and never
 *    degrade; a caught throw is exactly the moment the counter's state is
 *    unknown. An admission reached through a hoisted constant counts: the rule
 *    resolves an identifier back to its initialiser.
 *
 * WHAT IT DOES NOT SEE. REPRESENTATIVE, NOT EXHAUSTIVE — this is syntactic
 * analysis over source text, so the set of spellings is unbounded and no list
 * can close it. These are the shapes worth knowing about; a construct nobody
 * would write is out of scope rather than a gap. It is
 * syntactic and file-local: a `consume` Result that reaches a helper by any
 * route other than a directly annotated parameter — unannotated, destructured,
 * or carried on an options object — is invisible, as is a helper that signals
 * admission by some sentinel other than `allowed: true` (returning `null`,
 * say, which is how the current middleware spells it). Binding
 * tracking is by NAME, not scope, so a same-named unrelated binding in the
 * same file is judged with the consume one — deliberately, since erring toward
 * a report is the safe direction for this prohibition.
 *
 * A fall-through is placed only where the guard's own success branch terminates
 * and the guard reaches a statement list through `else` alternates alone. A
 * guard nested in a CONSEQUENT (`if (enabled) if (d.isOk()) return v;`) is left
 * alone: what follows it runs on the success path too, so it is not the failure
 * path. Loops and labelled statements are not statement lists either.
 *
 * A bare `true` is read as an admission only off a decision, so a `catch` —
 * which the rule reaches without knowing a decision is involved — still needs
 * the `{ allowed: true }` shape to be seen. Widening it there would flag every
 * `.catch(() => true)` in the tree.
 *
 * Self-scopes by ABSOLUTE filename because flat-config glob base paths differ
 * per consuming package.
 */

const DEFAULT_SCOPE = String.raw`/apps/api/src/`;

const RECOVERY_COMBINATORS = new Set(['orElse', 'unwrapOr', 'unwrapOrElse']);

/** How a rate-limit decision is spelled where it crosses a function boundary. */
const DECISION_TYPE = /\bRateLimitDecision\b/;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */
/** @typedef {import('eslint').Rule.Node} LinkedNode */
/** @typedef {Extract<AstNode, { type: 'CallExpression' }>} CallNode */
/** @typedef {Extract<AstNode, { type: 'MemberExpression' }>} MemberNode */

/** `consume(…)` however it is reached — bare, or off a port object. */
/** @param {CallNode} node */
function isConsumeCall(node) {
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name === 'consume';
  return (
    callee.type === 'MemberExpression' &&
    /** @type {{ name?: string }} */ (callee.property).name === 'consume'
  );
}

/** @param {Extract<AstNode, { type: 'ObjectExpression' }>} node */
function isAdmissionObject(node) {
  return node.properties.some(
    (property) =>
      property.type === 'Property' &&
      property.key.type === 'Identifier' &&
      property.key.name === 'allowed' &&
      property.value.type === 'Literal' &&
      property.value.value === true
  );
}

/**
 * @param {unknown} node
 * @returns {node is AstNode}
 */
function isAstNode(node) {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (/** @type {{ type?: unknown }} */ (node).type) === 'string'
  );
}

/** @param {AstNode} node */
function isTrueLiteral(node) {
  return node.type === 'Literal' && node.value === true;
}

/** A statement that ends the function, so what follows it runs on the other path only. */
/**
 * @param {AstNode} statement
 * @returns {boolean}
 */
function terminates(statement) {
  if (statement.type === 'ReturnStatement' || statement.type === 'ThrowStatement') return true;
  return statement.type === 'BlockStatement' && statement.body.some((child) => terminates(child));
}

/** The statement list a node sits in — a block or program `body`, a switch case's `consequent`. */
/**
 * @param {LinkedNode} node
 * @returns {readonly LinkedNode[] | null}
 */
function siblingStatements(node) {
  // Read off the node rather than through the union: these members live on
  // different kinds, and only their array-ness decides the answer.
  const { body, consequent } = /** @type {{ body?: unknown, consequent?: unknown }} */ (node);
  if (Array.isArray(body)) return body;
  return Array.isArray(consequent) ? consequent : null;
}

/**
 * The statement whose siblings run once `node` has. A guard written as an
 * `else if` occupies no slot in a statement list of its own — control resumes
 * after the whole chain — so the walk climbs out of every `alternate` it sits in.
 */
/**
 * @param {LinkedNode} node
 * @returns {LinkedNode}
 */
function continuationOf(node) {
  let current = node;
  while (current.parent?.type === 'IfStatement' && current.parent.alternate === current) {
    current = current.parent;
  }
  return current;
}

/** What the failure path is when the `if` has no `else` and success returns first. */
/**
 * @param {Extract<LinkedNode, { type: 'IfStatement' }>} node
 * @returns {readonly LinkedNode[] | null}
 */
function fallThrough(node) {
  if (node.alternate !== null || !terminates(node.consequent)) return null;
  const tail = continuationOf(node);
  // The climb starts at a statement, which always sits inside another node.
  const siblings = siblingStatements(/** @type {LinkedNode} */ (tail.parent));
  if (siblings === null) return null;
  const index = siblings.indexOf(tail);
  return index === -1 ? null : siblings.slice(index + 1);
}

/** Every node under `root`, descending into nested functions only when asked. */
/**
 * @param {unknown} node
 * @param {(node: AstNode) => void} visit
 * @param {boolean} enterFunctions
 */
function walk(node, visit, enterFunctions) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, enterFunctions);
    return;
  }
  if (!isAstNode(node)) return;
  visit(node);
  if (!enterFunctions && FUNCTION_TYPES.has(node.type)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'parent') walk(value, visit, enterFunctions);
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep rate limiting fail-closed: a consume() error may not become a verdict, and no admission may be produced from a failed branch or a catch.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          scopedFiles: {
            type: 'string',
            description: 'Regex matched against the absolute filename; matching files are checked.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      defaulted:
        'A rate-limit decision defaulted away from its error — limiters fail closed. Surface the `unavailable` error (503) instead of recovering it into a verdict.',
      guarded:
        'An admission produced from a rate-limit failure branch — limiters fail closed. Return the `unavailable` error from that branch instead of admitting on unknown counter state.',
      caught:
        'An admission produced from a catch — limiters fail closed. Let the failure surface as an `unavailable` error instead of admitting on unknown counter state.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const scoped = new RegExp(context.options[0]?.scopedFiles ?? DEFAULT_SCOPE);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scoped.test(filename)) return {};

    /** Binding name → the expression it was initialised from. */
    /** @type {Map<string, AstNode | null | undefined>} */
    const initialisers = new Map();
    /** Binding names holding a rate-limit decision Result. */
    /** @type {Set<string>} */
    const decisions = new Set();

    /** @typedef {CallNode & { callee: MemberNode }} MemberCallNode */
    /** @type {MemberCallNode[]} */
    const combinatorCalls = [];
    /** @type {MemberCallNode[]} */
    const matchCalls = [];
    /** @type {MemberCallNode[]} */
    const promiseCatches = [];
    /** @type {Extract<LinkedNode, { type: 'CatchClause' }>[]} */
    const catchClauses = [];
    /** @type {Extract<LinkedNode, { type: 'IfStatement' }>[]} */
    const ifStatements = [];
    /** @type {Extract<LinkedNode, { type: 'ConditionalExpression' }>[]} */
    const ternaries = [];
    /** @type {Extract<LinkedNode, { type: 'LogicalExpression' }>[]} */
    const logicals = [];

    /** True when the expression's chain reaches a `consume(…)` or a bound one. */
    /**
     * @param {unknown} node
     * @returns {boolean}
     */
    function isDecision(node) {
      if (!isAstNode(node)) return false;
      switch (node.type) {
        case 'CallExpression': {
          return isConsumeCall(node) || isDecision(node.callee);
        }
        case 'MemberExpression': {
          return isDecision(node.object);
        }
        case 'AwaitExpression': {
          return isDecision(node.argument);
        }
        case 'Identifier': {
          return decisions.has(node.name);
        }
        default: {
          return false;
        }
      }
    }

    /**
     * @param {Extract<AstNode, { type: 'ArrowFunctionExpression' | 'FunctionExpression' }>} handler
     * @param {boolean} bareTrue
     * @param {Set<AstNode>} seen
     * @returns {boolean}
     */
    function returnsAdmission(handler, bareTrue, seen) {
      if (handler.body.type !== 'BlockStatement') return isAdmission(handler.body, bareTrue, seen);
      let admits = false;
      walk(
        handler.body,
        (node) => {
          if (node.type === 'ReturnStatement' && isAdmission(node.argument, bareTrue, seen)) {
            admits = true;
          }
        },
        false
      );
      return admits;
    }

    /** An admission carried by a binding, a wrapping call, or a handler's return. */
    /**
     * @param {AstNode} node
     * @param {boolean} bareTrue
     * @param {Set<AstNode>} seen
     * @returns {boolean}
     */
    function admissionThrough(node, bareTrue, seen) {
      switch (node.type) {
        case 'ObjectExpression': {
          return isAdmissionObject(node);
        }
        case 'Identifier': {
          return isAdmission(initialisers.get(node.name), bareTrue, seen);
        }
        case 'CallExpression': {
          return node.arguments.some((argument) => isAdmission(argument, bareTrue, seen));
        }
        case 'ArrowFunctionExpression':
        case 'FunctionExpression': {
          return returnsAdmission(node, bareTrue, seen);
        }
        default: {
          return false;
        }
      }
    }

    /**
     * An admission, however it is spelled — inline, hoisted, or wrapped. A bare
     * `true` counts only where the caller has already established that the
     * value is a limiter's verdict, since `true` alone means nothing.
     */
    /**
     * @param {unknown} node
     * @param {boolean} bareTrue
     * @param {Set<AstNode>} [seen]
     * @returns {boolean}
     */
    function isAdmission(node, bareTrue, seen = new Set()) {
      if (!isAstNode(node) || seen.has(node)) return false;
      seen.add(node);
      if (bareTrue && isTrueLiteral(node)) return true;
      return admissionThrough(node, bareTrue, seen);
    }

    /** Anything inside `node` that admits — an admission built, or one returned. */
    /**
     * @param {unknown} node
     * @param {boolean} bareTrue
     */
    function admitsAnywhere(node, bareTrue) {
      let admits = false;
      walk(
        node,
        (child) => {
          if (child.type === 'ObjectExpression' && isAdmissionObject(child)) admits = true;
          if (child.type === 'ReturnStatement' && isAdmission(child.argument, bareTrue)) {
            admits = true;
          }
        },
        true
      );
      return admits;
    }

    /** An expression whose value IS a verdict — an admission, or a decision's `allowed`. */
    /** @param {AstNode} node */
    function isVerdict(node) {
      if (
        node.type === 'MemberExpression' &&
        node.property.type === 'Identifier' &&
        node.property.name === 'allowed'
      ) {
        return true;
      }
      return isAdmission(node, true);
    }

    /** `'isErr'` / `'isOk'` asked of a rate-limit decision, else `null`. */
    /**
     * @param {AstNode} node
     * @returns {'isErr' | 'isOk' | null}
     */
    function decisionPredicate(node) {
      if (node.type !== 'CallExpression') return null;
      const callee = node.callee;
      if (callee.type !== 'MemberExpression') return null;
      if (callee.property.type !== 'Identifier') return null;
      const name = callee.property.name;
      if (name !== 'isErr' && name !== 'isOk') return null;
      return isDecision(callee.object) ? name : null;
    }

    /** `'consequent' | 'alternate'` — which branch of `test` runs on failure. */
    /**
     * @param {AstNode} test
     * @returns {'consequent' | 'alternate' | null}
     */
    function failedBranch(test) {
      if (test.type === 'UnaryExpression' && test.operator === '!') {
        const inner = failedBranch(test.argument);
        if (inner === null) return null;
        return inner === 'consequent' ? 'alternate' : 'consequent';
      }
      const predicate = decisionPredicate(test);
      if (predicate === null) return null;
      return predicate === 'isErr' ? 'consequent' : 'alternate';
    }

    function reportDefaulted() {
      for (const node of combinatorCalls) {
        if (isDecision(node.callee.object)) context.report({ node, messageId: 'defaulted' });
      }
      for (const node of matchCalls) {
        if (!isDecision(node.callee.object)) continue;
        if (isAdmission(node.arguments[1], true)) context.report({ node, messageId: 'defaulted' });
      }
    }

    function reportCaught() {
      for (const node of promiseCatches) {
        if (node.arguments.some((argument) => isAdmission(argument, false))) {
          context.report({ node, messageId: 'caught' });
        }
      }
      for (const node of catchClauses) {
        if (admitsAnywhere(node.body, false)) context.report({ node, messageId: 'caught' });
      }
    }

    function reportGuardedBranch() {
      for (const node of ifStatements) {
        const branch = failedBranch(node.test);
        if (branch === null) continue;
        const failurePath = node[branch] ?? fallThrough(node);
        if (failurePath !== null && admitsAnywhere(failurePath, true)) {
          context.report({ node, messageId: 'guarded' });
        }
      }
      for (const node of ternaries) {
        const branch = failedBranch(node.test);
        if (branch !== null && isAdmission(node[branch], true)) {
          context.report({ node, messageId: 'guarded' });
        }
      }
    }

    /** What `A || B` / `A && B` over a decision test yields when the decision failed. */
    /**
     * @param {Extract<AstNode, { type: 'LogicalExpression' }>} node
     * @param {'consequent' | 'alternate'} branch
     */
    function shortCircuitAdmits(node, branch) {
      const leftIsTruthyOnFailure = branch === 'consequent';
      if (node.operator === '||') {
        return leftIsTruthyOnFailure ? isVerdict(node.right) : isAdmission(node.right, true);
      }
      return node.operator === '&&' && leftIsTruthyOnFailure && isAdmission(node.right, true);
    }

    function reportShortCircuit() {
      for (const node of logicals) {
        const branch = failedBranch(node.left);
        if (branch === null) continue;
        if (shortCircuitAdmits(node, branch)) context.report({ node, messageId: 'guarded' });
      }
    }

    return {
      /** @param {Extract<LinkedNode, { type: 'VariableDeclarator' }>} node */
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier') return;
        initialisers.set(node.id.name, node.init);
        if (isDecision(node.init)) decisions.add(node.id.name);
      },
      /** @param {Extract<LinkedNode, { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }>} node */
      ':function'(node) {
        for (const parameter of node.params) {
          // `typeAnnotation` is the TypeScript parser's addition to the ESTree node.
          const { typeAnnotation } = /** @type {{ typeAnnotation?: AstNode }} */ (parameter);
          if (parameter.type !== 'Identifier' || typeAnnotation === undefined) continue;
          const annotation = context.sourceCode.getText(typeAnnotation);
          if (DECISION_TYPE.test(annotation)) decisions.add(parameter.name);
        }
      },
      /** @param {Extract<LinkedNode, { type: 'CallExpression' }>} node */
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        const call = /** @type {MemberCallNode} */ (node);
        const name = /** @type {{ name?: string }} */ (call.callee.property).name;
        if (name !== undefined && RECOVERY_COMBINATORS.has(name)) combinatorCalls.push(call);
        if (name === 'match') matchCalls.push(call);
        if (name === 'catch') promiseCatches.push(call);
      },
      /** @param {Extract<LinkedNode, { type: 'CatchClause' }>} node */
      CatchClause(node) {
        catchClauses.push(node);
      },
      /** @param {Extract<LinkedNode, { type: 'IfStatement' }>} node */
      IfStatement(node) {
        ifStatements.push(node);
      },
      /** @param {Extract<LinkedNode, { type: 'ConditionalExpression' }>} node */
      ConditionalExpression(node) {
        ternaries.push(node);
      },
      /** @param {Extract<LinkedNode, { type: 'LogicalExpression' }>} node */
      LogicalExpression(node) {
        logicals.push(node);
      },
      'Program:exit'() {
        reportDefaulted();
        reportCaught();
        reportGuardedBranch();
        reportShortCircuit();
      },
    };
  },
};
