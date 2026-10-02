/**
 * Restricts raw `cockatiel` imports to the resilience policy factory
 * (apps/api/src/lib/resilience), which is the single seam to the library;
 * everything else composes the factory's exported policies. Keeping one seam
 * is what makes "no in-isolate circuit breakers" enforceable: the factory
 * exposes retry/timeout only.
 *
 * A vendored rule instead of core `no-restricted-imports` because flat
 * config replaces (never merges) a rule key across config objects — reusing
 * the core rule here would silently clobber the base config's
 * no-restricted-imports entries (animation-library bans) for every matching
 * file, in whichever direction the loader orders the configs.
 *
 * Self-scopes by absolute filename for the same reason as must-use-result:
 * flat-config glob base paths differ per consuming package.
 */

const DEFAULT_ALLOWED = String.raw`/apps/api/src/lib/resilience/`;

const LIBRARY = 'cockatiel';

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Allow raw cockatiel imports only inside the resilience policy factory; everywhere else uses its exported policies.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; matching files may import cockatiel.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      banned:
        'Import cockatiel only inside apps/api/src/lib/resilience (the policy factory) — compose its exported retry/timeout policies instead.',
    },
  },
  /** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const allowed = new RegExp(context.options[0]?.allowedFiles ?? DEFAULT_ALLOWED);
    const filename = context.filename.replaceAll('\\', '/');
    if (allowed.test(filename)) return {};

    /**
     * @param {AstNode} node
     * @param {AstNode | null | undefined} source
     */
    const checkSource = (node, source) => {
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      // A subpath reaches the same library, so the seam has to cover it; the
      // slash is what keeps a different package that merely begins with these
      // letters out.
      if (source.value === LIBRARY || source.value.startsWith(`${LIBRARY}/`)) {
        context.report({ node, messageId: 'banned' });
      }
    };

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportDeclaration' }>} node */
      ImportDeclaration(node) {
        checkSource(node, node.source);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportExpression' }>} node */
      ImportExpression(node) {
        checkSource(node, node.source);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ExportNamedDeclaration' }>} node */
      ExportNamedDeclaration(node) {
        checkSource(node, node.source);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ExportAllDeclaration' }>} node */
      ExportAllDeclaration(node) {
        checkSource(node, node.source);
      },
    };
  },
};
