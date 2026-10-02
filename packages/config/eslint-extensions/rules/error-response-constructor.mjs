/**
 * `createErrorResponse(code, details?)` builds every API error body; a
 * hand-built one is the defect (`docs/CODE-RULES.md` §Error Responses).
 *
 * The wire contract is `{ code, details? }` and nothing else — no message
 * field, no `error` envelope — because clients resolve copy from the code via
 * `friendlyErrorMessage`. A hand-built body is therefore not a style slip: it
 * ships a shape the frontend renders as nothing, and it escapes the closed
 * `ErrorCode` registry the constructor types its argument against.
 *
 * Two syntactic shapes carry that mistake, and the rule reports each:
 *
 * - a `.json(body, status)` response whose status is a 4xx/5xx numeric
 *   literal and whose body is not a `createErrorResponse(…)` call;
 * - a `.json({ error: … })` response at any status — the spelling the
 *   doctrine sentence names, off-contract whatever it wraps.
 *
 * A status computed at run time (`STATUS_BY_DOMAIN_CODE[error.code]`, a
 * `RefusalStatus` parameter) is deliberately unreported by the first arm: the
 * rule reads syntax rather than values, so it asks only about statuses it can
 * see. That makes it a floor, not a proof — the shared refusal helpers those
 * call sites route through carry the contract for them, and each helper is
 * itself written as `c.json(createErrorResponse(…), …)`, which this rule does
 * check.
 *
 * A vendored rule rather than core `no-restricted-syntax`: flat config
 * replaces a rule key instead of merging it, so reusing the core rule for one
 * tree would drop the base config's selectors for every file it matched.
 */

import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

const API_SOURCE_SEGMENT = '/apps/api/src/';
const ERROR_RESPONSE_CONSTRUCTOR = 'createErrorResponse';

/** True for a numeric literal in the HTTP error range. */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

/**
 * @param {AstNode | undefined} node
 * @returns {node is Extract<AstNode, { type: 'Literal' }>}
 */
function isErrorStatusLiteral(node) {
  return node?.type === 'Literal' && typeof node.value === 'number' && node.value >= 400;
}

/** True when the expression is a direct `createErrorResponse(…)` call. */
/** @param {AstNode | undefined} node */
function isConstructorCall(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === ERROR_RESPONSE_CONSTRUCTOR
  );
}

/** The statically-known name of an object key ('' when computed at run time). */
/** @param {AstNode} property */
function propertyName(property) {
  if (property.type !== 'Property') return '';
  if (property.computed) {
    return property.key.type === 'Literal' ? String(property.key.value) : '';
  }
  // A non-computed key is an identifier or a literal by grammar; `computed`
  // does not discriminate the ESTree union, so the literal arm is named here.
  return property.key.type === 'Identifier'
    ? property.key.name
    : String(/** @type {{ value?: unknown }} */ (property.key).value);
}

/** True for an object literal carrying an `error` key. */
/** @param {AstNode | undefined} node */
function hasErrorKey(node) {
  return (
    node?.type === 'ObjectExpression' &&
    node.properties.some((property) => propertyName(property) === 'error')
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require createErrorResponse for API error bodies; the wire contract is { code, details? } and nothing else.',
    },
    schema: [],
    messages: {
      handBuiltErrorBody:
        'A {{status}} response must carry `createErrorResponse(code, details?)`. The wire contract is `{ code, details? }` — clients resolve copy from the code, so a hand-built body renders as nothing.',
      errorKeyBody:
        'An `error` key is off-contract for an API response body. Return `createErrorResponse(code, details?)`, whose shape is `{ code, details? }`.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!filename.includes(API_SOURCE_SEGMENT)) return {};
    if (TEST_FILE_PATTERN.test(filename)) return {};

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'CallExpression' }>} node */
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression') return;
        if (callee.computed || callee.property.type !== 'Identifier') return;
        if (callee.property.name !== 'json') return;

        const [body, status] = node.arguments;
        if (body === undefined) return;

        if (hasErrorKey(body)) {
          context.report({ node: body, messageId: 'errorKeyBody' });
          return;
        }
        if (isErrorStatusLiteral(status) && !isConstructorCall(body)) {
          context.report({
            node: body,
            messageId: 'handBuiltErrorBody',
            data: { status: String(status.value) },
          });
        }
      },
    };
  },
};
