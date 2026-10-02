/**
 * `apps/web/src/lib/api-client.ts` is where typed API calls come from, and an
 * endpoint it covers is reached through it rather than by hand
 * (`docs/CODE-RULES.md` §API Client).
 *
 * A raw call bypasses everything the client carries as a matter of course —
 * the `AppType`-inferred route and response types, the credential mode, the
 * shared headers — so it fails at run time where the typed call fails at
 * compile time. The ban is on the CALL, not on the binding: reading
 * `globalThis.fetch` to wrap or restore it (the demo mock backend's shim does
 * exactly this) is how the platform primitive is legitimately handled, and is
 * not a request.
 *
 * Detection is syntactic on the callee: a bare `fetch(…)` or a global-rooted
 * `window`/`globalThis`/`self` `.fetch(…)`. A call through a binding the file
 * aliased first is deliberately unreported — the rule is a floor that catches
 * the shape people actually write, not a proof of no network access.
 *
 * The sanctioned callers arrive as `allowedFiles`, matched as repo-relative
 * path suffixes; the list and each entry's reason live in the topic config.
 *
 * A vendored rule rather than core `no-restricted-globals`: flat config
 * replaces a rule key instead of merging it, and the allowlist is by absolute
 * caller filename, which the core rule cannot express.
 */

import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

const WEB_SOURCE_SEGMENT = '/apps/web/src/';
const GLOBAL_ROOTS = new Set(['window', 'globalThis', 'self']);

/** True when the linted file is one of the sanctioned raw-fetch callers. */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

/**
 * @param {string} filename
 * @param {readonly string[]} allowedFiles
 */
function isSanctionedCaller(filename, allowedFiles) {
  return allowedFiles.some((caller) => filename === caller || filename.endsWith(`/${caller}`));
}

/** True when the callee is `fetch` or a global-rooted `<root>.fetch`. */
/** @param {Extract<AstNode, { type: 'CallExpression' }>['callee']} callee */
function isFetchCallee(callee) {
  if (callee.type === 'Identifier') return callee.name === 'fetch';
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property.type !== 'Identifier' || callee.property.name !== 'fetch') return false;
  return callee.object.type === 'Identifier' && GLOBAL_ROOTS.has(callee.object.name);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Confine raw fetch in the web app to the typed API client and the presigned-blob download.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawFetch:
        'Raw `fetch` in the web app bypasses the typed API client. Call the route through `apiClient` (apps/web/src/lib/api-client.ts), which is the single source for API calls.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!filename.includes(WEB_SOURCE_SEGMENT)) return {};
    if (TEST_FILE_PATTERN.test(filename)) return {};

    const allowedFiles = context.options[0]?.allowedFiles ?? [];
    if (isSanctionedCaller(filename, allowedFiles)) return {};

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'CallExpression' }>} node */
      CallExpression(node) {
        if (isFetchCallee(node.callee)) {
          context.report({ node: node.callee, messageId: 'rawFetch' });
        }
      },
    };
  },
};
