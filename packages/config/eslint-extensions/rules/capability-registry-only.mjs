/**
 * Capability resolution goes through the registry, never the interpreter.
 * Every `*-execution` module under slices/workflows/domain/nodes/ (the modelCall /
 * transform / subWorkflow capabilities) may be imported for a runtime value
 * ONLY by the live execution registry — the single seam the interpreter
 * resolves capabilities through. This is the structural half of "no
 * interpreter-embedded work node": the interpreter dispatches every value
 * node through `resolveExecution`, and this rule makes it impossible for the
 * interpreter (or the slice barrel) to reach a node execution directly.
 *
 * Type-only imports/exports are allowed (the registry re-exports capability
 * types); only runtime-value imports are confined. Vendored + self-scoping for
 * the same flat-config reasons as the sibling rules.
 */
import path from 'node:path';
import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

const NODE_EXECUTION =
  /\/apps\/api\/src\/slices\/workflows\/domain\/nodes\/[\w-]+-execution(?:\.[cm]?[jt]s)?$/;
const REGISTRY =
  /\/apps\/api\/src\/slices\/workflows\/domain\/engine\/live-execution-registry(?:\.[cm]?[jt]s)?$/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Confine runtime imports of workflow node executions to the live execution registry — capabilities resolve through the registry, never the interpreter.',
    },
    schema: [],
    messages: {
      banned:
        "'{{specifier}}' imports a capability node execution — only the live execution registry may. Resolve capabilities through createLiveExecutionRegistry.",
    },
  },
  /** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (
      REGISTRY.test(filename) ||
      NODE_EXECUTION.test(filename) ||
      TEST_FILE_PATTERN.test(filename)
    ) {
      return {};
    }
    const importerDir = path.posix.dirname(filename);

    /**
     * `importKind`/`exportKind` are the TypeScript parser's additions to the
     * ESTree nodes.
     * @param {AstNode & { importKind?: string, exportKind?: string }} node
     * @param {AstNode | null | undefined} source
     */
    const check = (node, source) => {
      if (node.importKind === 'type' || node.exportKind === 'type') return;
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      if (!specifier.startsWith('.')) return;
      if (NODE_EXECUTION.test(path.posix.resolve(importerDir, specifier))) {
        context.report({ node, messageId: 'banned', data: { specifier } });
      }
    };

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportDeclaration' }>} node */
      ImportDeclaration(node) {
        check(node, node.source);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportExpression' }>} node */
      ImportExpression(node) {
        check(node, node.source);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ExportNamedDeclaration' }>} node */
      ExportNamedDeclaration(node) {
        check(node, node.source);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ExportAllDeclaration' }>} node */
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
    };
  },
};
