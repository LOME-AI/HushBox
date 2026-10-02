/**
 * Restricts `@sentry/*` imports to the Sentry telemetry adapter
 * (apps/api/src/lib/telemetry/adapters), the single seam to Sentry. Every
 * event that leaves for Sentry is scrubbed there (`scrubSentryEvent`), so a
 * stray `import * as Sentry from '@sentry/cloudflare'` anywhere else would
 * bypass the scrub and could ship message content or PII to a third party —
 * the exact leak the telemetry port exists to prevent. Convention is not
 * enough for a leak of that severity; this makes the confinement enforceable.
 *
 * A vendored rule instead of core `no-restricted-imports` for the same reason
 * as no-external-cockatiel: flat config replaces (never merges) a rule key
 * across config objects, so reusing the core rule here would silently clobber
 * the base config's no-restricted-imports entries for every matching file.
 *
 * Self-scopes by absolute filename because flat-config glob base paths differ
 * per consuming package.
 */

const DEFAULT_ALLOWED = String.raw`/apps/api/src/lib/telemetry/adapters/`;

/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

/** @param {AstNode | null | undefined} source */
const isSentrySource = (source) =>
  source &&
  source.type === 'Literal' &&
  typeof source.value === 'string' &&
  source.value.startsWith('@sentry/');

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Allow @sentry/* imports only inside the telemetry Sentry adapter; everywhere else routes through the telemetry port so events are scrubbed.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; matching files may import @sentry/*.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      banned:
        'Import @sentry/* only inside apps/api/src/lib/telemetry/adapters (the Sentry adapter) — route through the telemetry port so every event is scrubbed.',
    },
  },
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
      if (isSentrySource(source)) {
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
