// Programmatic ESLint tests for the vendored fee-seams rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to
// synthetic code at synthetic repo paths, so these tests stay valid
// regardless of loader behavior and of the live tree's lint state.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import eslintPluginAstro from 'eslint-plugin-astro';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig, { FEE_APPLICATION_SEAMS } from '../fee-seams.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

/**
 * The fee-rate constants a fee applier is written in terms of: the three
 * components and their total (`affordability/constants.ts`) and the settlement
 * basis points (`affordability/money/money.ts`). A rate constant added under a name
 * outside this set is the one drift this list carries.
 */
const FEE_RATE_CONSTANTS = new Set([
  'CREDIT_CARD_FEE_RATE',
  'HUSHBOX_FEE_RATE',
  'MARKUP_BASIS_POINTS',
  'PROVIDER_FEE_RATE',
  'TOTAL_FEE_RATE',
]);

/**
 * The modules that define fee application today. Scoped, not swept: a rate
 * constant is read in plenty of places that describe the fee without applying
 * it, and widening this list would trade a real check for false positives.
 */
const FEE_DEFINING_MODULES = ['money.ts', 'pricing.ts'].map((file) =>
  path.join(repoRoot, 'packages/shared/src/affordability/money', file)
);

/** @typedef {import('eslint').AST.Program} Program */
/** @typedef {Program['body'][number]} TopLevelNode */
/** @typedef {{ node: unknown, isFunction: boolean }} Binding */

/**
 * Whether any identifier anywhere under `node` is one of `names`.
 * @param {unknown} node
 * @param {ReadonlySet<string>} names
 * @returns {boolean}
 */
function referencesAny(node, names) {
  if (node === null || typeof node !== 'object') return false;
  if ('type' in node && node.type === 'Identifier' && 'name' in node) {
    return typeof node.name === 'string' && names.has(node.name);
  }
  return Object.entries(node).some(
    ([key, value]) => key !== 'parent' && referencesAny(value, names)
  );
}

/** @param {{ type?: string } | null | undefined} node */
function isFunctionValued(node) {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'FunctionDeclaration'
  );
}

/**
 * The declaration a top-level statement introduces, unwrapping any export.
 * @param {TopLevelNode} statement
 */
function declarationOf(statement) {
  return statement.type === 'ExportNamedDeclaration' ||
    statement.type === 'ExportDefaultDeclaration'
    ? statement.declaration
    : statement;
}

/**
 * The `[name, binding]` pairs one declaration introduces.
 * @param {ReturnType<typeof declarationOf>} declaration
 * @returns {[string, Binding][]}
 */
function bindingsOf(declaration) {
  if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
    return [[declaration.id.name, { node: declaration.body, isFunction: true }]];
  }
  if (declaration?.type !== 'VariableDeclaration') return [];
  return declaration.declarations.flatMap((declarator) =>
    declarator.id.type === 'Identifier' && declarator.init
      ? [
          /** @type {[string, Binding]} */ ([
            declarator.id.name,
            { node: declarator.init, isFunction: isFunctionValued(declarator.init) },
          ]),
        ]
      : []
  );
}

/**
 * Every module-scope binding, mapped to the subtree that decides its fee-ness.
 * @param {Program['body']} body
 * @returns {Map<string, Binding>}
 */
function moduleBindings(body) {
  return new Map(body.flatMap((statement) => bindingsOf(declarationOf(statement))));
}

/**
 * The fee-carrying bindings, to a fixpoint: a binding is fee-carrying when it
 * names a fee rate, OR names another fee-carrying binding. That second clause
 * is what covers a hoisted multiplier and a helper that delegates to the fee
 * applier — both propagate fee-ness without naming a rate themselves.
 *
 * @param {Map<string, Binding>} bindings
 * @returns {ReadonlySet<string>}
 */
function feeCarryingNames(bindings) {
  const names = new Set(FEE_RATE_CONSTANTS);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, binding] of bindings) {
      if (names.has(name) || !referencesAny(binding.node, names)) continue;
      names.add(name);
      grew = true;
    }
  }
  return names;
}

/**
 * The names one declaration binds at module scope.
 * @param {ReturnType<typeof declarationOf>} declaration
 * @returns {string[]}
 */
function declaredNames(declaration) {
  if (declaration?.type === 'FunctionDeclaration')
    return declaration.id ? [declaration.id.name] : [];
  if (declaration?.type !== 'VariableDeclaration') return [];
  return declaration.declarations.flatMap((declarator) =>
    declarator.id.type === 'Identifier' ? [declarator.id.name] : []
  );
}

/**
 * The `[exported name, local name]` pairs one top-level statement publishes.
 * @param {TopLevelNode} statement
 * @returns {[string, string][]}
 */
function exportPairsOf(statement) {
  if (statement.type === 'ExportDefaultDeclaration') {
    const { declaration } = statement;
    const id = 'id' in declaration ? declaration.id : undefined;
    return id ? [[id.name, id.name]] : [];
  }
  if (statement.type !== 'ExportNamedDeclaration' || statement.source) return [];
  /** @type {[string, string][]} */
  const fromDeclaration = declaredNames(statement.declaration).map((name) => [name, name]);
  return [
    ...fromDeclaration,
    ...statement.specifiers.flatMap((specifier) =>
      specifier.exported.type === 'Identifier' && specifier.local.type === 'Identifier'
        ? [/** @type {[string, string]} */ ([specifier.exported.name, specifier.local.name])]
        : []
    ),
  ];
}

/**
 * Exported name → the module-scope binding it publishes, for function-valued exports.
 * @param {Program['body']} body
 * @param {Map<string, Binding>} bindings
 * @returns {Map<string, string>}
 */
function exportedFunctionBindings(body, bindings) {
  return new Map(
    body
      .flatMap((statement) => exportPairsOf(statement))
      .filter(([, localName]) => bindings.get(localName)?.isFunction)
  );
}

/** @param {string} code */
function feeApplyingExportsIn(code) {
  // The shared parser export is declared loosely, so its tree arrives as
  // `unknown`; the program shape is what the parser documents it to be.
  const ast = /** @type {Program} */ (tseslint.parser.parseForESLint(code).ast);
  const bindings = moduleBindings(ast.body);
  const feeNames = feeCarryingNames(bindings);
  return [...exportedFunctionBindings(ast.body, bindings)]
    .filter(([, localName]) => feeNames.has(localName))
    .map(([exportedName]) => exportedName);
}

/** @param {string} filePath */
function exportedFeeApplyingFunctions(filePath) {
  return feeApplyingExportsIn(readFileSync(filePath, 'utf8'));
}

/** The fee helpers the two fee-defining modules publish, read from their source. */
const FEE_HELPERS = new Set(
  FEE_DEFINING_MODULES.flatMap((file) => exportedFeeApplyingFunctions(file))
);

/**
 * Every node under `node`, the `parent` back-links excluded.
 * @param {unknown} node
 * @returns {Generator<Record<string, unknown>>}
 */
function* nodesIn(node) {
  if (node === null || typeof node !== 'object') return;
  const record = /** @type {Record<string, unknown>} */ (node);
  if (typeof record['type'] === 'string') yield record;
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'parent') yield* nodesIn(value);
  }
}

/**
 * A node's own fields, or an empty record for anything that is not a node.
 * @param {unknown} node
 * @returns {Record<string, unknown>}
 */
function fieldsOf(node) {
  return node !== null && typeof node === 'object'
    ? /** @type {Record<string, unknown>} */ (node)
    : {};
}

/**
 * The name an identifier binds; '' for anything else.
 * @param {unknown} node
 * @returns {string}
 */
function identifierName(node) {
  const { type, name } = fieldsOf(node);
  return type === 'Identifier' && typeof name === 'string' ? name : '';
}

/**
 * The name a call invokes: the callee itself, or the statically-known property
 * of a member access on a module object. A computed property reached through a
 * variable is known only at run time, so it names nothing here — the same blind
 * spot the rule's own member matcher carries.
 * @param {unknown} callee
 * @returns {string}
 */
function calleeName(callee) {
  const { type, computed, property } = fieldsOf(callee);
  if (type !== 'MemberExpression') return identifierName(callee);
  if (computed !== true) return identifierName(property);
  const literal = fieldsOf(property);
  return literal['type'] === 'Literal' ? String(literal['value']) : '';
}

/**
 * Whether a re-export's specifier list republishes a fee helper.
 * @param {unknown} specifiers
 * @returns {boolean}
 */
function publishesFeeHelper(specifiers) {
  const list = Array.isArray(specifiers) ? specifiers : [];
  return list.some((specifier) => FEE_HELPERS.has(identifierName(fieldsOf(specifier)['local'])));
}

/**
 * How one node reaches a fee helper, or '' when it does not.
 * @param {Record<string, unknown>} node
 * @returns {string}
 */
function feeHelperReachAt(node) {
  const type = node['type'];
  if (type === 'CallExpression') {
    return FEE_HELPERS.has(calleeName(node['callee'])) ? 'call' : '';
  }
  if (type === 'ExportNamedDeclaration' && node['source'] !== null) {
    return publishesFeeHelper(node['specifiers']) ? 'publication' : '';
  }
  if (type === 'FunctionDeclaration' || type === 'VariableDeclarator') {
    return FEE_HELPERS.has(identifierName(node['id'])) ? 'declaration' : '';
  }
  return '';
}

/**
 * The three ways a module reaches a fee helper: it calls one, publishes one by
 * re-export, or declares one. A seam file that does none of the three has no
 * fee application left to sanction, so its allowlist entry is dead and
 * re-admits the file the day one of the three returns.
 *
 * Read from the parsed source rather than by searching the text, so a helper's
 * name in a comment or in a string reaches nothing. The boundary, stated rather
 * than enumerated: a call on a statically-known callee, a named re-export, and
 * a module-scope binding under a helper's own name. A star re-export of a
 * fee-defining module publishes the helpers too and is not seen here.
 *
 * @param {string} code
 * @returns {string[]}
 */
function feeHelperReachesIn(code) {
  const { ast } = tseslint.parser.parseForESLint(code);
  const reaches = new Set([...nodesIn(ast)].map((node) => feeHelperReachAt(node)));
  reaches.delete('');
  return [...reaches];
}

/**
 * Whether a module holds nothing but re-exports — an export-all, or a named
 * export carrying a source. That is the barrel shape, whose whole job is
 * publication. An exported declaration with a body is code, so a module holding
 * one is applying or computing something and answers for that instead.
 * @param {string} code
 * @returns {boolean}
 */
function isReExportOnlyModule(code) {
  const { ast } = tseslint.parser.parseForESLint(code);
  const body = fieldsOf(ast)['body'];
  const statements = Array.isArray(body) ? body : [];
  return statements.every((statement) => {
    const { type, source } = fieldsOf(statement);
    return (
      type === 'ExportAllDeclaration' || (type === 'ExportNamedDeclaration' && source !== null)
    );
  });
}

/**
 * What sanctions a seam's exemption: declaring the helpers sanctions the module
 * that defines them, publishing them sanctions a barrel, and every other file
 * has to call one. Publication alone from a module that is not a barrel
 * sanctions nothing — a file that swaps its call for a re-export applies no fee,
 * which is the decay a stale seam entry hides.
 *
 * @param {string} code
 * @returns {string[]}
 */
function seamSanctions(code) {
  const reaches = feeHelperReachesIn(code);
  const publishesAsBarrel = reaches.includes('publication') && isReExportOnlyModule(code);
  return reaches.filter((reach) => reach !== 'publication' || publishesAsBarrel);
}

/** @param {string} filePath */
function seamSource(filePath) {
  return readFileSync(filePath, 'utf8');
}

function createLinter() {
  return new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
      // `.astro` parses through the same plugin config the repo lints it with;
      // its own rules are irrelevant here because messages are filtered to this
      // rule's id, and its parser and processor arrive as one unit.
      ...eslintPluginAstro.configs.recommended,
      ...extensionConfig,
    ],
  });
}

/**
 * @param {string} code
 * @param {string} repoRelativePath
 */
async function lintAtPath(code, repoRelativePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...repoRelativePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'money/fee-seams');
}

describe('fee-seams', () => {
  it('flags an applyMarkupCeil import outside the sanctioned seams', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupCeil } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/turn-definition.ts'
      )
    ).toHaveLength(1);
  });

  it('flags an applyMarkup import regardless of local alias', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkup as bake } from '@hushbox/shared';\n",
        'apps/web/src/hooks/billing/use-prompt-budget.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a fee-helper import from any module path, not only the shared barrel', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkup } from './money.js';\n",
        'apps/api/src/slices/billing/domain/charge.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a future fee helper matching the applyMarkup* name pattern', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupFloor } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a named re-export that launders a fee helper outward', async () => {
    expect(
      await lintAtPath(
        "export { applyMarkupCeil } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/index.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a renaming re-export (matching is on the source-side name)', async () => {
    expect(
      await lintAtPath(
        "export { applyMarkup as bakeFee } from '@hushbox/shared';\n",
        'packages/crypto/src/index.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a star re-export of a money module outside the seams', async () => {
    expect(
      await lintAtPath(
        "export * from '../money.js';\n",
        'packages/shared/src/affordability/estimate/index.ts'
      )
    ).toHaveLength(1);
  });

  it('reports one violation per matching specifier', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkup, applyMarkupCeil, usdToNanoUsd } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/pricing.ts'
      )
    ).toHaveLength(2);
  });

  it('allows every sanctioned seam site to import the fee helpers', async () => {
    for (const seam of FEE_APPLICATION_SEAMS) {
      expect(
        await lintAtPath("import { applyMarkup, applyMarkupCeil } from '@hushbox/shared';\n", seam)
      ).toEqual([]);
    }
  });

  it('allows the shared barrel to publish the helpers via named re-export', async () => {
    expect(
      await lintAtPath(
        "export { applyMarkup, applyMarkupCeil } from './money.js';\n",
        'packages/shared/src/index.ts'
      )
    ).toEqual([]);
  });

  it('allows test files to import the helpers for expected-value math', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupCeil } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/settlement.integration.test.ts'
      )
    ).toEqual([]);
  });

  it('allows a spec-marked module the same expected-value math', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupCeil } from '@hushbox/shared';\n",
        'e2e/billing/billing.spec.ts'
      )
    ).toEqual([]);
  });

  it('allows a setup-marked module the same expected-value math', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupCeil } from '@hushbox/shared';\n",
        'apps/api/src/test-support/chat-routes.integration.setup.ts'
      )
    ).toEqual([]);
  });

  it('allows unrelated imports from the shared barrel', async () => {
    expect(
      await lintAtPath(
        "import { usdToNanoUsd, roundHalfEvenDiv } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('allows star re-exports of non-money modules', async () => {
    expect(
      await lintAtPath("export * from './types.js';\n", 'apps/api/src/slices/chat/index.ts')
    ).toEqual([]);
  });

  it('flags a string-literal import name (ES2022 arbitrary module namespace names)', async () => {
    expect(
      await lintAtPath(
        "import { 'applyMarkupCeil' as bake } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a fee helper reached through a namespace import', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const rate = shared.applyMarkupCeil(1n);\n",
        'apps/api/src/slices/chat/domain/turn-context.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a fee helper reached through a default module-object import', async () => {
    expect(
      await lintAtPath(
        "import shared from '@hushbox/shared';\nexport const rate = shared.applyMarkup(1n, 15);\n",
        'apps/web/src/hooks/billing/use-prompt-budget.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a string-literal fee-helper access on a namespace import', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const rate = shared['applyMarkupCeil'](1n);\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toHaveLength(1);
  });

  it('allows a namespace fee-helper call at every sanctioned seam', async () => {
    for (const seam of FEE_APPLICATION_SEAMS) {
      expect(
        await lintAtPath(
          "import * as shared from '@hushbox/shared';\nexport const rate = shared.applyMarkupCeil(1n);\n",
          seam
        )
      ).toEqual([]);
    }
  });

  it('ignores a fully dynamic namespace member access', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const pick = (key: string): unknown => shared[key as keyof typeof shared];\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('ignores a dynamic import() module-object binding (documented limitation)', async () => {
    expect(
      await lintAtPath(
        "export const rate = async (): Promise<bigint> => {\n  const m = await import('@hushbox/shared');\n  return m.applyMarkupCeil(1n);\n};\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('ignores a fee-helper access on a binding that shadows the namespace import', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const bake = (shared: { applyMarkupCeil: (n: bigint) => bigint }): bigint =>\n  shared.applyMarkupCeil(1n);\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('allows a bare module-object binding with no fee-helper access', async () => {
    expect(
      await lintAtPath(
        "import shared from '@hushbox/shared';\nimport * as money from '@hushbox/shared';\nexport { shared, money };\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('ignores local declarations that merely match the name pattern', async () => {
    expect(
      await lintAtPath(
        'const applyMarkupLocal = (n: bigint): bigint => n;\nexport { applyMarkupLocal };\n',
        'apps/api/src/slices/chat/domain/local.ts'
      )
    ).toEqual([]);
  });

  it('flags an applyFees import outside the sanctioned seams', async () => {
    expect(
      await lintAtPath(
        "import { applyFees } from '@hushbox/shared';\n",
        'apps/api/src/slices/models/domain/list-models.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a named re-export that launders applyFees outward', async () => {
    expect(
      await lintAtPath(
        "export { applyFees } from '@hushbox/shared';\n",
        'apps/web/src/lib/money.ts'
      )
    ).toHaveLength(1);
  });

  it('flags applyFees reached through a namespace import', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const price = shared.applyFees(1);\n",
        'apps/web/src/lib/format.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a star re-export of the pricing module outside the seams', async () => {
    expect(
      await lintAtPath(
        "export * from '../pricing.js';\n",
        'packages/shared/src/affordability/estimate/index.ts'
      )
    ).toHaveLength(1);
  });

  it('allows test files to import applyFees for expected-value math', async () => {
    expect(
      await lintAtPath(
        "import { applyFees } from '@hushbox/shared';\n",
        'apps/web/src/lib/format.test.ts'
      )
    ).toEqual([]);
  });

  // The one suite member that reads the live tree on purpose: it is what makes
  // the rule's name matcher falsifiable. A fee helper added beside the existing
  // ones under a name the pattern misses fails here instead of shipping
  // unenforced the way `applyFees` did — for the shapes the predicate sees.
  //
  // The boundary, stated once rather than enumerated: the predicate sees a
  // FUNCTION LITERAL BOUND AT MODULE SCOPE and exported — a declaration, an
  // arrow or function const, `export default function f`, or the same reached
  // through a specifier list (aliases reported under the exported name) —
  // whose body reaches a fee rate directly, through a module-scope binding
  // derived from one, or by calling another such binding. A function reached
  // any other way is not seen: through a call, an alias, a `.bind`, a type
  // assertion, a destructure, a default-exported identifier, or a property of
  // an object or class. Nor is a rate written as a bare numeric literal, which
  // reaches no binding at all. The tests below are examples of that boundary,
  // never the list of what falls outside it.
  //
  // Re-exports sit outside the guard entirely, and the rule covers only one of
  // the four cases, so this is stated rather than assumed: inside a seam file
  // the rule registers no visitors at all, so a re-export there is never
  // flagged whatever it is named; inside a non-seam file it is flagged only
  // when the name matches the matcher. A fee applier that arrives in either
  // module by re-export under an unmatched name is caught by nothing here.
  it('flags every fee-applying helper the shared money modules export', async () => {
    const helpers = FEE_DEFINING_MODULES.flatMap((file) => exportedFeeApplyingFunctions(file));
    expect(helpers.toSorted()).toEqual([
      'applyFees',
      'applyMarkup',
      'applyMarkupCeil',
      'applyMarkupCeilFromUsdDecimal',
      'applyMarkupFromPicoUsd',
      'applyMarkupInverseFloorToPicoUsd',
    ]);
    for (const name of helpers) {
      expect(
        await lintAtPath(
          `import { ${name} } from '@hushbox/shared';\n`,
          'apps/api/src/slices/chat/domain/turn.ts'
        ),
        name
      ).toHaveLength(1);
    }
  });

  // The affordability barrel republished `applyFees` and was exempted wholesale
  // while that was fixed. The exemption is gone, so the line that earned it is
  // now flagged like any other — planting it back is what proves that.
  it('flags the affordability barrel republishing applyFees', async () => {
    expect(
      await lintAtPath(
        "export { applyFees } from './pricing.js';\n",
        'packages/shared/src/affordability/index.ts'
      )
    ).toHaveLength(1);
  });

  // The marketing site is the documented consumer of the float helper and is
  // written in `.astro`, so the rule's glob has to reach that extension.
  it('flags an applyFees import in an astro page', async () => {
    expect(
      await lintAtPath(
        '---\nimport { applyFees } from "@hushbox/shared";\nconst price = applyFees(1);\n---\n<p>{price}</p>\n',
        'apps/marketing/src/pages/pricing.astro'
      )
    ).toHaveLength(1);
  });

  it('pins the seam list to exactly the sanctioned inventory', () => {
    expect(FEE_APPLICATION_SEAMS.toSorted()).toEqual(
      [
        'packages/shared/src/affordability/money/money.ts',
        'packages/shared/src/index.ts',
        'packages/shared/src/affordability/estimate/tool-pricing.ts',
        'apps/api/src/slices/models/domain/catalog/normalize.ts',
        'apps/api/src/slices/billing/domain/money.ts',
        'scripts/lib/playwright/seeded-image-model.ts',
        'scripts/lib/playwright/seeded-video-model.ts',
      ].toSorted()
    );
  });
});

// A seam entry exempts one file from the confinement. The entry outlives the
// reason for it: once the file stops reaching a fee helper altogether it applies
// no fee, and the exemption sits there re-admitting the file the moment fee
// application returns to it. One case per entry, so the failure names the seam.
describe('sanctioned seam liveness', () => {
  for (const seam of FEE_APPLICATION_SEAMS) {
    it(`${seam} still applies a fee`, () => {
      expect(seamSanctions(seamSource(path.join(repoRoot, seam)))).not.toEqual([]);
    });
  }

  it('reads a helper name from the parsed source, not from a comment', () => {
    expect(feeHelperReachesIn('// applyMarkupCeil is the ceil-rounding helper\n')).toEqual([]);
  });

  it('reads a helper name from the parsed source, not from a string', () => {
    expect(feeHelperReachesIn("throw new RangeError('applyMarkup: rejected');\n")).toEqual([]);
  });

  it('refuses a re-export from a module that is not a barrel', () => {
    expect(
      seamSanctions("import { x } from './x.ts';\nexport { applyMarkupCeil } from './money.ts';\n")
    ).toEqual([]);
  });

  it('accepts a re-export from a barrel, which publishes rather than applies', () => {
    expect(seamSanctions("export { applyMarkupCeil } from './money.ts';\n")).toEqual([
      'publication',
    ]);
  });

  it('refuses a re-export beside an exported declaration that carries a body', () => {
    expect(
      seamSanctions(
        "export { applyMarkupCeil } from './money.ts';\nexport function describeRate() {\n  return 1;\n}\n"
      )
    ).toEqual([]);
  });
});

// The guard above is only worth its comment if it sees the shapes a fee helper
// would plausibly be written in. Each case here is an ordinary way to write one,
// not an evasion.
describe('fee-applier detection', () => {
  it('detects an exported arrow const', () => {
    expect(
      feeApplyingExportsIn('export const applyIt = (n) => n * (1 + TOTAL_FEE_RATE);\n')
    ).toEqual(['applyIt']);
  });

  it('detects a function exported through a specifier list', () => {
    expect(
      feeApplyingExportsIn(
        'function applyIt(n) {\n  return n * TOTAL_FEE_RATE;\n}\nexport { applyIt };\n'
      )
    ).toEqual(['applyIt']);
  });

  it('detects a default-exported fee applier', () => {
    expect(
      feeApplyingExportsIn(
        'export default function applyIt(n) {\n  return n * TOTAL_FEE_RATE;\n}\n'
      )
    ).toEqual(['applyIt']);
  });

  it('detects a body priced through a module-scope multiplier', () => {
    expect(
      feeApplyingExportsIn(
        'const MULTIPLIER = 1 + TOTAL_FEE_RATE;\nexport function applyIt(n) {\n  return n * MULTIPLIER;\n}\n'
      )
    ).toEqual(['applyIt']);
  });

  it('detects a helper that delegates to a fee applier', () => {
    expect(
      feeApplyingExportsIn(
        'export function applyIt(n) {\n  return n * TOTAL_FEE_RATE;\n}\nexport function priceOne(n) {\n  return applyIt(n);\n}\n'
      ).toSorted()
    ).toEqual(['applyIt', 'priceOne']);
  });

  it('detects a body using a component fee rate rather than the total', () => {
    expect(
      feeApplyingExportsIn('export function applyIt(n) {\n  return n * CREDIT_CARD_FEE_RATE;\n}\n')
    ).toEqual(['applyIt']);
  });

  it('ignores an exported function that reads no fee rate', () => {
    expect(feeApplyingExportsIn('export function addOne(n) {\n  return n + 1;\n}\n')).toEqual([]);
  });

  it('ignores a non-exported fee applier', () => {
    expect(
      feeApplyingExportsIn('function applyIt(n) {\n  return n * TOTAL_FEE_RATE;\n}\n')
    ).toEqual([]);
  });

  // Examples of the boundary, pinned so it stays a measured fact and so
  // widening it later is a visible edit. Deliberately not a list of what falls
  // outside: the predicate sees a function literal bound at module scope, so
  // every other way of binding a function lands here, named or not.
  it('does not see an export whose initializer is a call', () => {
    expect(feeApplyingExportsIn('export const applyIt = makeApplier(TOTAL_FEE_RATE);\n')).toEqual(
      []
    );
  });

  it('does not see a default-exported identifier', () => {
    expect(
      feeApplyingExportsIn(
        'function applyIt(n) {\n  return n * TOTAL_FEE_RATE;\n}\nexport default applyIt;\n'
      )
    ).toEqual([]);
  });

  it('does not see a rate written as a bare literal', () => {
    expect(feeApplyingExportsIn('export function applyIt(n) {\n  return n * 1.15;\n}\n')).toEqual(
      []
    );
  });

  it('does not see an anonymous default export', () => {
    expect(feeApplyingExportsIn('export default (n) => n * TOTAL_FEE_RATE;\n')).toEqual([]);
  });

  it('does not see a fee applier held as a property of an exported object', () => {
    expect(
      feeApplyingExportsIn('export const fees = {\n  applyIt: (n) => n * TOTAL_FEE_RATE,\n};\n')
    ).toEqual([]);
  });
});
