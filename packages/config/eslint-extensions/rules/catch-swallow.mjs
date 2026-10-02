/**
 * No-silent-catch-swallow lint rule (audit F20). Path-scoped-inert: acts ONLY
 * on files under `apps/api/src/` and is silent everywhere else. Test files are
 * included deliberately: a test that swallows a failure passes whether the call
 * succeeded or failed, which is the false green the rule exists to prevent. In
 * that tree a `catch` block must visibly handle the
 * failure — the founder-ruled heuristic is that its body contains at least
 * one of: a `throw`, a `captureError(...)` call, or the construction/return of
 * a typed error/Result (an `err(...)`/`errAsync(...)` call or a `*DomainError`
 * reference).
 * Empty catch blocks are banned outright. A rare legitimate swallow escapes
 * via a justified `eslint-disable` line — that is the intended and only escape
 * hatch (there is no config allowlist).
 *
 * The search is deliberately confined to the catch's own control-flow frame:
 * the walk does not descend into nested functions or nested `catch` handlers,
 * because a throw/handler there belongs to a different frame and does not
 * handle this catch. It is confined to value positions for the same reason —
 * a `*DomainError` naming a type is erased before anything runs.
 *
 * Self-scopes by ABSOLUTE filename (default: the whole API source tree)
 * instead of relying on config `files` globs, because flat-config glob base
 * paths differ per consuming package while context.filename is always
 * absolute.
 */

const DEFAULT_FILES = String.raw`/apps/api/src/`;
const DOMAIN_ERROR = /DomainError$/;

/** The callee's simple name — the identifier, or a member expression's property. */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

/** @param {AstNode} callee */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return '';
}

/** A nested function/catch — a different control-flow frame; not walked. */
/** @param {AstNode} node */
function isFrameBoundary(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'CatchClause'
  );
}

/** A single node that visibly handles a failure. */
/** @param {AstNode} node */
function isHandlingNode(node) {
  if (node.type === 'ThrowStatement') return true;
  if (node.type === 'CallExpression') {
    const name = calleeName(node.callee);
    return name === 'captureError' || name === 'err' || name === 'errAsync';
  }
  if (node.type === 'Identifier') return DOMAIN_ERROR.test(node.name);
  return false;
}

/**
 * Object keys holding TYPE positions — annotations, generic arguments, cast
 * targets. A `*DomainError` under one of these is a type reference the
 * compiler erases, never a value the catch produced, so the walk must not read
 * it as handling evidence: the check asks what the catch DOES at runtime.
 * Keyed on the position rather than on node names because the erasable
 * subtrees hang off exactly these keys, while `TSAsExpression` and
 * `TSNonNullExpression` are themselves values whose `expression` child must
 * still be walked.
 */
const TYPE_POSITION_KEYS = new Set([
  'typeAnnotation',
  'typeArguments',
  'typeParameters',
  'returnType',
  'superTypeArguments',
  'implements',
]);

/** Recurses into a node's child nodes (arrays and single nodes), skipping `parent`. */
/**
 * @param {AstNode} node
 * @param {(child: AstNode) => void} visit
 */
function visitChildren(node, visit) {
  for (const key of Object.keys(node)) {
    if (key === 'parent' || TYPE_POSITION_KEYS.has(key)) continue;
    const value = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node))[key];
    if (Array.isArray(value)) {
      for (const child of value) visit(/** @type {AstNode} */ (child));
    } else if (value !== null && typeof value === 'object' && 'type' in value) {
      visit(/** @type {AstNode} */ (value));
    }
  }
}

/**
 * True when the catch block visibly handles its failure. Walks the block's own
 * frame, stopping at nested function/catch boundaries.
 */
/** @param {Extract<AstNode, { type: 'BlockStatement' }>} block */
function handlesFailure(block) {
  let handled = false;

  /** @param {AstNode} node */
  const visit = (node) => {
    if (handled || typeof node?.type !== 'string' || isFrameBoundary(node)) return;
    if (isHandlingNode(node)) {
      handled = true;
      return;
    }
    visitChildren(node, visit);
  };

  for (const statement of block.body) visit(statement);
  return handled;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban silent catch-swallow across the API source tree: a catch block must throw, call captureError, or construct/return a typed error/Result (err(...) / errAsync(...) / *DomainError). Empty catches are banned; rare legitimate swallows use a justified eslint-disable.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; non-matching files are skipped.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      emptyCatch:
        'Empty catch block swallows the failure silently — throw, call captureError, or return a typed error/Result (err(...) / errAsync(...) / *DomainError). Justify a rare deliberate swallow with an eslint-disable line.',
      silentCatch:
        'This catch swallows the failure silently — it must throw, call captureError, or construct/return a typed error/Result (err(...) / errAsync(...) / *DomainError). Justify a rare deliberate swallow with an eslint-disable line.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const scope = new RegExp(context.options[0]?.files ?? DEFAULT_FILES);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scope.test(filename)) return {};

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'CatchClause' }>} node */
      CatchClause(node) {
        const block = node.body;
        if (block.body.length === 0) {
          context.report({ node, messageId: 'emptyCatch' });
          return;
        }
        if (!handlesFailure(block)) {
          context.report({ node, messageId: 'silentCatch' });
        }
      },
    };
  },
};
