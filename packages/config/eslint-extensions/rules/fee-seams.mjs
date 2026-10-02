/**
 * Confines fee application to the sanctioned seams.
 *
 * BILLING.md §Fee Structure: the customer markup lands in exactly two places —
 * catalog rate baking at ingestion (ceil) and the ModelProvider port's charge
 * conversion (half-even) — plus the definition-time reservation constants that
 * bake a raw provider figure billable exactly once at module init. Everything
 * else prices over already-billable rates through the shared estimator. A fee
 * helper imported anywhere else re-applies (or forgets) the markup and
 * silently drifts client, admission, and settlement apart.
 *
 * Detection is syntactic and name-based at the import/re-export seam: any
 * import specifier or `export … from` source-side name matching the
 * fee-helper pattern (`applyMarkup*` in `money.ts`, `applyFees*` in
 * `pricing.ts` — the two fee-defining modules under
 * `packages/shared/src/affordability/`, whose helpers must keep those prefixes
 * so the pattern covers them) is flagged unless the importing file is on the
 * sanctioned-seam allowlist (rule options — the single data source, in the
 * topic config) or is a test file (tests compute expected values). Star
 * re-exports of either fee-defining module are flagged too, so the helpers
 * cannot be laundered through an intermediate barrel. The name matcher's own
 * blind spot — a future helper under a third name — is narrowed, not closed,
 * from the other end by the colocated test: it parses both fee-defining
 * modules and requires the fee-applying exports it can see to be ones this
 * rule flags. It sees a function literal bound at module scope and exported,
 * whose body reaches a fee rate directly, through a derived module binding, or
 * by calling another such binding; a function reached through a call, an
 * alias, a bind, an assertion, a destructure, a default-exported identifier or
 * an object property is not seen, and neither is a bare-literal rate. A
 * re-export is seen by neither side in a seam file, where this rule inspects
 * nothing at all. That test states the boundary in full.
 * A module-object import binds no fee name at the
 * specifier, so those bindings (`import * as m` / `import m`) are tracked
 * through scope analysis and the fee access is flagged at the member
 * expression (`m.applyMarkupCeil(…)`) instead — shadowing is resolved by the
 * scope manager, so a same-named local parameter is not a false positive.
 *
 * Limitations (documented, accepted), each a shape no repo code uses and a
 * reviewer sees: any dynamic `import()` binding, whether destructured or held
 * as a module object (`const m = await import(…); m.applyMarkup…`) — only
 * static import declarations are tracked; a fully dynamic member access on a
 * module object (`m[key]` — a statically-known string key is matched); and
 * `export * as ns from` republication of a module that defines no fee helper,
 * whose consumer holds a named binding rather than a module object.
 *
 * A vendored rule instead of core `no-restricted-imports`: flat config replaces
 * (never merges) a rule key, and the allowlist is by absolute importer
 * filename, which the core rule cannot express.
 */

import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

const FEE_HELPER_NAME_PATTERN = /^(?:applyMarkup|applyFees)/;
/** Import specifiers that bind the whole module object rather than a name. */
const MODULE_OBJECT_SPECIFIERS = new Set(['ImportNamespaceSpecifier', 'ImportDefaultSpecifier']);

/** The source-side name of an import/export specifier (ESTree allows Literal). */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */
/**
 * The specifier nodes an import or a re-export declares.
 * @typedef {Extract<AstNode, { type: 'ImportDeclaration' }>['specifiers'][number] | Extract<AstNode, { type: 'ExportNamedDeclaration' }>['specifiers'][number]} SpecifierNode
 */

/** @param {SpecifierNode} spec */
function specifierName(spec) {
  // Only the named import specifier carries `imported`; the default and
  // namespace forms bind the module object and carry none.
  const id =
    spec.type === 'ExportSpecifier'
      ? spec.local
      : /** @type {{ imported?: AstNode }} */ (spec).imported;
  if (!id) return '';
  return id.type === 'Literal' ? String(id.value) : /** @type {{ name: string }} */ (id).name;
}

/** The statically-known property name of a member access ('' when dynamic). */
/** @param {Extract<AstNode, { type: 'MemberExpression' }>} node */
function memberPropertyName(node) {
  // A non-computed member's property is an identifier by grammar; `computed`
  // does not discriminate the ESTree union, so the name is read through it.
  if (!node.computed) return /** @type {{ name: string }} */ (node.property).name;
  return node.property.type === 'Literal' ? String(node.property.value) : '';
}

/** True when the linted file is one of the sanctioned seam files. */
/**
 * @param {string} filename
 * @param {readonly string[]} allowedFiles
 */
function isSanctionedSeam(filename, allowedFiles) {
  return allowedFiles.some((seam) => filename === seam || filename.endsWith(`/${seam}`));
}

/** True when a star re-export source is a fee-defining module. */
/** @param {string} source */
function isFeeDefiningModule(source) {
  // A split yields at least one part, so the last one is always present.
  const basename = /** @type {string} */ (source.split('/').at(-1));
  return /^(?:money|pricing)(?:\.[cm]?[jt]s)?$/.test(basename);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Confine fee-application helpers (applyMarkup*, applyFees*) to the sanctioned seams: ' +
        'catalog ingestion, the ModelProvider port conversion, and the definition-time reservation constants.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['allowedFiles'],
        additionalProperties: false,
      },
    ],
    messages: {
      confined:
        "'{{name}}' applies the customer fee and is confined to the sanctioned seams " +
        '(fee-seams.config.mjs). Price over billable catalog rates or the shared estimator instead ' +
        'of re-applying the markup here.',
      starLaunder:
        "Star re-exporting '{{source}}' would republish the fee-application helpers outside the " +
        'sanctioned seams (fee-seams.config.mjs). Re-export the needed non-fee symbols by name instead.',
    },
  },

  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const { allowedFiles } = context.options[0];
    const filename = context.filename.replaceAll('\\', '/');
    if (TEST_FILE_PATTERN.test(filename) || isSanctionedSeam(filename, allowedFiles)) {
      return {};
    }

    /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportDeclaration' }> | Extract<import('eslint').Rule.Node, { type: 'ExportNamedDeclaration' }>} node */
    const checkSpecifiers = (node) => {
      for (const spec of node.specifiers) {
        const name = specifierName(spec);
        if (FEE_HELPER_NAME_PATTERN.test(name)) {
          context.report({ node: spec, messageId: 'confined', data: { name } });
        }
      }
    };

    // Deferred to Program:exit: `parent` links exist only once the traversal
    // that populates them has reached the end of the program.
    /** @type {import('eslint').Scope.Variable[]} */
    const moduleObjectVariables = [];

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportDeclaration' }>} node */
      ImportDeclaration(node) {
        checkSpecifiers(node);
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          // An imported binding always has a definition.
          if (
            MODULE_OBJECT_SPECIFIERS.has(
              /** @type {import('eslint').Scope.Definition} */ (variable.defs[0]).node.type
            )
          ) {
            moduleObjectVariables.push(variable);
          }
        }
      },
      'Program:exit'() {
        for (const variable of moduleObjectVariables) {
          for (const { identifier } of variable.references) {
            // ESLint links every node to its parent at run time; the ESTree type
            // a scope reference carries does not declare the link.
            const { parent } = /** @type {{ type: string, parent: AstNode }} */ (
              /** @type {unknown} */ (identifier)
            );
            if (parent.type !== 'MemberExpression') continue;
            const name = memberPropertyName(parent);
            if (FEE_HELPER_NAME_PATTERN.test(name)) {
              context.report({ node: parent, messageId: 'confined', data: { name } });
            }
          }
        }
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ExportNamedDeclaration' }>} node */
      ExportNamedDeclaration(node) {
        if (node.source) checkSpecifiers(node);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ExportAllDeclaration' }>} node */
      ExportAllDeclaration(node) {
        if (typeof node.source.value === 'string' && isFeeDefiningModule(node.source.value)) {
          context.report({
            node,
            messageId: 'starLaunder',
            data: { source: node.source.value },
          });
        }
      },
    };
  },
};
