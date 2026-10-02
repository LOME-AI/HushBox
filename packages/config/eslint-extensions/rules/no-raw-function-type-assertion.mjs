/**
 * Bans a bare assertion that some value IS a function, in test files.
 *
 * "This is a function" is true of every branch a wiring test can select, so
 * such an assertion cannot falsify the branch its test names — the test stays
 * green with the wiring inverted. The two honest uses of the shape wear names
 * instead (`expectExposes`, `expectCompileTimeProof`), which is what lets the
 * ban ship with no exemption mechanism; the reasoning lives in the topic config
 * beside this file.
 *
 * The ban is by MEANING, not by the spellings a survey happened to find.
 * Enumerating `toBe('function')` and its three siblings would leave
 * `toEqual('function')`, a substitution-free template argument, a `typeof`
 * comparison asserted for truth, `expect.any(Function)` and `expect.soft` open
 * as regrowth routes for the identical claim, and a ban a rewrite walks around
 * is not a ban.
 *
 * By that same meaning, the NEGATIVE claim is out of scope and must stay out.
 * "This is not a function" is falsifiable by the code under it, so it is a real
 * assertion rather than a vacuous one; neither helper has a negative form, and
 * banning it would leave a developer with a true claim no vocabulary can
 * express. Polarity is therefore computed rather than ignored: `not` in the
 * matcher chain, an inequality operator, and an assertion against `false` each
 * flip it, and only a claim that comes out positive is reported.
 *
 * Its reach ends where the claim stops being readable from syntax: a matcher
 * argument that is a variable rather than a literal says nothing about which
 * type is expected, so it is left alone rather than guessed at.
 */

/**
 * Node types, derived from ESLint's own rule-node union. `@types/estree` is not
 * installed for this package — it reaches the ESLint types only through the
 * store — so an `import('estree')` specifier written here does not resolve.
 */
/** @typedef {Extract<import('eslint').Rule.Node, { type: 'CallExpression' }>} CallNode */
/** @typedef {CallNode['callee']} CalleeNode */
/** @typedef {CallNode['arguments'][number]} ArgumentNode */
/** @typedef {Extract<import('eslint').Rule.Node, { type: 'BinaryExpression' }>['left']} OperandNode */
/** @typedef {{ root: Extract<CalleeNode, { type: 'CallExpression' }>, negated: boolean }} ExpectChain */

/** The matchers that assert a value equals another value. */
const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

/** The comparisons that decide whether two values are the same. */
const IDENTITY_OPERATORS = new Set(['===', '==', '!==', '!=']);

/** True for `'function'`, `"function"` and the substitution-free backtick form. */
/** @param {ArgumentNode | OperandNode | undefined} node */
function isFunctionStringLiteral(node) {
  if (node === undefined) return false;
  if (node.type === 'Literal') return node.value === 'function';
  return (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis[0]?.value.cooked === 'function'
  );
}

/** @param {ArgumentNode | OperandNode | undefined} node */
function isTypeofExpression(node) {
  return node?.type === 'UnaryExpression' && node.operator === 'typeof';
}

/** True for the global `Function`, bare or reached through a namespace object. */
/** @param {ArgumentNode | undefined} node */
function isGlobalFunction(node) {
  if (node === undefined) return false;
  if (node.type === 'Identifier') return node.name === 'Function';
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'Function'
  );
}

/** True for `expect.any(Function)`, the argument-matcher spelling of the claim. */
/** @param {ArgumentNode | undefined} node */
function isExpectAnyFunction(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'expect' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'any' &&
    isGlobalFunction(node.arguments[0])
  );
}

/**
 * Whether a `typeof x <op> 'function'` comparison claims function-ness (`true`),
 * claims its absence (`false`), or is not that comparison at all (`null`).
 * @param {ArgumentNode | undefined} node
 * @returns {boolean | null}
 */
function typeofComparisonPolarity(node) {
  if (node?.type !== 'BinaryExpression') return null;
  if (!IDENTITY_OPERATORS.has(node.operator)) return null;
  const compares =
    (isTypeofExpression(node.left) && isFunctionStringLiteral(node.right)) ||
    (isTypeofExpression(node.right) && isFunctionStringLiteral(node.left));
  if (!compares) return null;
  return node.operator === '===' || node.operator === '==';
}

/**
 * The truth value a matcher asserts of its subject, or `null` where it asserts
 * neither — a subject compared against anything but `true` or `false` carries
 * no polarity this rule can read.
 * @param {string} matcher
 * @param {ArgumentNode | undefined} argument
 * @returns {boolean | null}
 */
function assertedTruth(matcher, argument) {
  if (matcher === 'toBeTruthy') return true;
  if (matcher === 'toBeFalsy') return false;
  if (!EQUALITY_MATCHERS.has(matcher)) return null;
  // Two halves, and only one is a formality. The `?.` is load-bearing: a
  // matcher called with no argument at all — `expect(typeof x === 'function')
  // .toBe()` — reaches here with `argument` undefined, and without it the rule
  // throws, which ESLint surfaces as a fatal that fails that file's whole lint.
  // The `!== 'Literal'` half only narrows for the compiler; a non-literal
  // argument reaches the same `null` through the checks below either way.
  if (argument?.type !== 'Literal') return null;
  if (argument.value === true) return true;
  return argument.value === false ? false : null;
}

/** True when a callee names `expect`, bare or as one of its own methods. */
/** @param {CalleeNode} callee */
function isExpectCallee(callee) {
  if (callee.type === 'Identifier') return callee.name === 'expect';
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect'
  );
}

/**
 * The `expect(...)` call a matcher chain roots at, together with whether the
 * chain negates it — or null when it roots at anything else. `.resolves` and
 * `.rejects` are transparent; `not` is the one link that carries meaning.
 * @param {CalleeNode} node
 * @returns {ExpectChain | null}
 */
function expectChainOf(node) {
  let current = node;
  let negated = false;
  while (current.type === 'MemberExpression') {
    if (
      !current.computed &&
      current.property.type === 'Identifier' &&
      current.property.name === 'not'
    )
      negated = !negated;
    current = current.object;
  }
  if (current.type === 'CallExpression' && isExpectCallee(current.callee))
    return { root: current, negated };
  return null;
}

/**
 * True when a matcher call names its subject's type directly — the spellings
 * whose claim is positive by construction, so the chain's `not` is their only
 * polarity.
 * @param {string} matcher
 * @param {ArgumentNode | undefined} argument
 * @param {ArgumentNode | undefined} subject
 */
function namesFunctionType(matcher, argument, subject) {
  if (matcher === 'toBeTypeOf') return isFunctionStringLiteral(argument);
  if (matcher === 'toBeInstanceOf') return isGlobalFunction(argument);
  if (!EQUALITY_MATCHERS.has(matcher)) return false;
  // `expect.any(Function)` only stands for the claim when it IS the expected
  // value; as one field of a structural shape it describes that field, and the
  // assertion's subject is the shape.
  if (isExpectAnyFunction(argument)) return true;
  return isFunctionStringLiteral(argument) && isTypeofExpression(subject);
}

/**
 * True when this matcher call claims, on balance, that its subject is a
 * function.
 * @param {ExpectChain} chain
 * @param {string} matcher
 * @param {ArgumentNode | undefined} argument
 */
function claimsFunctionType(chain, matcher, argument) {
  const subject = chain.root.arguments[0];
  if (namesFunctionType(matcher, argument, subject)) return !chain.negated;
  const compared = typeofComparisonPolarity(subject);
  if (compared === null) return false;
  const asserted = assertedTruth(matcher, argument);
  if (asserted === null) return false;
  return compared === (asserted !== chain.negated);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid a bare assertion that a value is a function in test files, so a claim no branch can falsify cannot be spelled without a name that says what it means.',
    },
    schema: [],
    messages: {
      rawFunctionTypeAssertion:
        'A bare function-type assertion holds whatever the code under it does, so it cannot falsify the branch its test names. Both legitimate uses have a name, at `@hushbox/shared/test-assertions`: `expectExposes(subject, ...names)` where the claim is that a barrel or factory exposes a named API and nothing about which branch produced it, and `expectCompileTimeProof(thunk)` where the real assertion is an adjacent `@ts-expect-error` and the runtime call exists only to keep the symbol referenced against type erasure. Where neither fits, the site is a claim nothing supports: assert what actually discriminates the branch, or rename the test so it stops claiming it.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    return {
      /** @param {CallNode} node */
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        const chain = expectChainOf(callee.object);
        if (chain === null) return;
        if (claimsFunctionType(chain, callee.property.name, node.arguments[0])) {
          context.report({ node, messageId: 'rawFunctionTypeAssertion' });
        }
      },
    };
  },
};
