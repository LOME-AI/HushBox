/**
 * Admin op-body purity lint rule. Path-scoped-inert: acts ONLY on non-test
 * files under `apps/api/src/slices/admin/domain/operations/` and is silent
 * everywhere else. Op bodies compose published `*WithinTx` helpers on the
 * engine-owned `SettlementTx` — no raw platform time/randomness, no network,
 * no infra/adapter value imports (the ts-morph `admin-op-purity` arch rule
 * carries the structural half: ops importable only by the registry wiring).
 */
import path from 'node:path';
import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

const OP_BODY = /\/apps\/api\/src\/slices\/admin\/domain\/operations\//;
const BANNED_PACKAGE =
  /^(?:drizzle-orm|@hushbox\/db|@neondatabase|@upstash|resend|aws4fetch|cockatiel)(?:\/|$)/;
const ADAPTER_MODULE = /\/adapters\//;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban raw Date.now/Math.random/fetch and infra/adapter value imports in admin op bodies (compose published *WithinTx helpers on the engine-owned SettlementTx instead).',
    },
    schema: [],
    messages: {
      dateNow: 'Admin op bodies must not call Date.now() — deterministic effects only.',
      mathRandom: 'Admin op bodies must not call Math.random() — deterministic effects only.',
      fetch:
        "Admin op bodies must not call fetch — this rule reads the body's own text, so it refuses a network capability the body mints for itself; an injected capability is declared on the op family's post-commit dependencies, which the engine hands to a registered ephemeral effect after the transaction commits.",
      valueImport:
        "Admin op bodies must not value-import '{{specifier}}' — compose published slice barrels on the engine-owned SettlementTx.",
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!OP_BODY.test(filename) || TEST_FILE_PATTERN.test(filename)) return {};
    const importerDir = path.posix.dirname(filename);

    // `importKind` is the TypeScript parser's addition to the ESTree node.
    /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportDeclaration' }> & { importKind?: string }} node */
    const checkImport = (node) => {
      if (node.importKind === 'type') return;
      const source = node.source;
      /* v8 ignore next -- @preserve unreachable: an ImportDeclaration's source is always a
         string Literal (TS-ESTree types it `source: StringLiteral`). The guard is reachable
         only where the same check also visits ImportExpression, whose specifier can be computed. */
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      const banned = specifier.startsWith('.')
        ? ADAPTER_MODULE.test(path.posix.resolve(importerDir, specifier))
        : BANNED_PACKAGE.test(specifier);
      if (banned) context.report({ node, messageId: 'valueImport', data: { specifier } });
    };

    /** @param {import('eslint').Rule.Node} node */
    const dateNow = (node) => {
      context.report({ node, messageId: 'dateNow' });
    };
    /** @param {import('eslint').Rule.Node} node */
    const mathRandom = (node) => {
      context.report({ node, messageId: 'mathRandom' });
    };
    /** @param {import('eslint').Rule.Node} node */
    const bannedFetch = (node) => {
      context.report({ node, messageId: 'fetch' });
    };

    // Both the bare form (`Date.now`) and the global-rooted form
    // (`globalThis.Date.now` / `window.Date.now` / `self.Date.now`); likewise
    // fetch as a bare call and off `globalThis`/`window`/`self`.
    return {
      'MemberExpression[object.name="Date"][property.name="now"]': dateNow,
      'MemberExpression[object.type="MemberExpression"][object.property.name="Date"][property.name="now"]':
        dateNow,
      'MemberExpression[object.name="Math"][property.name="random"]': mathRandom,
      'MemberExpression[object.type="MemberExpression"][object.property.name="Math"][property.name="random"]':
        mathRandom,
      'CallExpression[callee.type="Identifier"][callee.name="fetch"]': bannedFetch,
      'MemberExpression[object.name=/^(globalThis|window|self)$/][property.name="fetch"]':
        bannedFetch,
      ImportDeclaration: checkImport,
    };
  },
};
