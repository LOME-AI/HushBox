/**
 * A branch asks `envUtils` (from `createEnvUtilities()`) which mode it is in;
 * `NODE_ENV`, `CI` and `E2E` are read inside that classifier and nowhere else
 * (`docs/CODE-RULES.md` §Environment Detection).
 *
 * `createEnvUtilities` is the single classifier: it turns raw platform values
 * into the named environments the codebase branches on (`isLocalDev`,
 * `isDevServer`, `isCI`, `isE2E`, `isProduction`). A direct check re-derives
 * one of those by hand and gets it subtly wrong — `isLocalDev` is not
 * `NODE_ENV === 'development'`, since an end-to-end run counts as development
 * for any word that variable carries but `production` (the pin that keeps a
 * production build production) and CI never counts whatever the word, and
 * `isDevServer` excludes E2E and vitest besides — so hand-rolled branches
 * disagree with the classifier under exactly the conditions they were written
 * for.
 *
 * The rule distinguishes CHECKING an environment value from SUPPLYING one,
 * because supplying is how the classifier gets built and must stay legal. A
 * read is a check when the code classifies with it:
 *
 * - coerced to boolean — `!x`, `!!x`, `Boolean(x)`, an `if`/ternary/loop test,
 *   or an operand of `&&`/`||`/`??`;
 * - compared against a value — `x === 'production'`.
 *
 * A read compared against `undefined` is deliberately NOT a check: an
 * `EnvContext` must omit an absent key rather than carry it as undefined, so
 * that comparison is the plumbing by which the value reaches the classifier.
 * A plain read (`NODE_ENV: import.meta.env.MODE`, `const ci = env['VITE_CI']`)
 * is likewise a supply, not a branch — which is why the env modules need no
 * exemption entry. A file that binds the value first and branches on the
 * binding one line later is unreported: the rule catches the shape people
 * write, and is a floor rather than a proof.
 *
 * Templates are in the file set alongside modules, because a template branches
 * on the environment as readily as a module does. One shape there legitimately
 * cannot comply: a gate whose whole purpose is to be absent from the production
 * bundle needs a build-time constant the bundler can strip, and a runtime
 * `envUtils` value cannot serve that — it exists only once the bundle it would
 * have to be stripped from is already built. Such a gate would carry an
 * in-place disable stating that reason, which keeps the exception visible at
 * the site that takes it rather than as a silent gap in the file set.
 *
 * A vendored rule rather than core `no-restricted-properties`: flat config
 * replaces a rule key instead of merging it, and the core rule cannot see
 * whether the read is being branched on.
 */

import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

const APPLICATION_SOURCE_PATTERN = /\/(?:apps|packages)\/[^/]+\/src\//;

/**
 * The bundler's development and production flags, each mapped to the refusal
 * that states its own direction. Both are decided by `NODE_ENV` alone — `DEV`
 * is `NODE_ENV !== 'production'` and `PROD` its negation, an unset variable
 * defaulting to `production` for a build — so neither tracks the mode the build
 * was run for. The env loader (`scripts/with-env.ts`) sets `NODE_ENV` to
 * `development` for every local stack, so a build that loads it reports `DEV`
 * true and `PROD` false however the command named its mode, and the same build
 * with the variable unset reports the reverse. Two builds of one site
 * disagreeing that way is how a build-time gate on one flag put a
 * development-only island into one output and not the other.
 *
 * A message per flag rather than one for both: one sentence firing for two keys
 * states one key's direction of both, and for whichever key it was not written
 * against it reads as the reverse of what happens.
 */
const BUNDLER_FLAG_MESSAGES = new Map([
  ['DEV', 'bundlerDevFlagBranch'],
  ['PROD', 'bundlerProdFlagBranch'],
]);

/** The advice every bundler-flag refusal ends on, written once for both. */
const BUNDLER_FLAG_ADVICE =
  'Branch on an `envUtils` value (`env.isLocalDev`, `env.isCI`, `env.isE2E`, `env.isProduction`). A gate that must be a build-time constant the bundler can strip cannot use one of those, which are computed when the bundle runs: compare `import.meta.env.MODE`, which the running command fixes — and, since `MODE` is refused here too, carry an in-place `eslint-disable-next-line` for this rule stating that reason.';

/** The environment signals `createEnvUtilities` owns the classification of. */
const CLASSIFYING_KEYS = new Set([
  'NODE_ENV',
  'CI',
  'E2E',
  'MODE',
  ...BUNDLER_FLAG_MESSAGES.keys(),
  'VITE_CI',
  'VITE_E2E',
]);

const BOOLEAN_TEST_PARENTS = new Set([
  'IfStatement',
  'ConditionalExpression',
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'LogicalExpression',
]);

const VALUE_COMPARISONS = new Set(['===', '!==', '==', '!=']);

/** The statically-known property name of a member access ('' when dynamic). */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

/** @param {Extract<AstNode, { type: 'MemberExpression' }>} node */
function memberPropertyName(node) {
  // A non-computed member's property is an identifier by grammar; `computed`
  // does not discriminate the ESTree union, so the name is read through it.
  if (!node.computed) return /** @type {{ name: string }} */ (node.property).name;
  return node.property.type === 'Literal' ? String(node.property.value) : '';
}

/** True for `process.env` or `import.meta.env`. */
/** @param {AstNode} node */
function isEnvObject(node) {
  if (node.type !== 'MemberExpression') return false;
  if (memberPropertyName(node) !== 'env') return false;
  const { object } = node;
  if (object.type === 'Identifier') return object.name === 'process';
  return object.type === 'MetaProperty' && object.meta.name === 'import';
}

/** True when the node is the literal `undefined`. */
/** @param {AstNode} node */
function isUndefinedLiteral(node) {
  return node.type === 'Identifier' && node.name === 'undefined';
}

/** True when the read is used to classify the environment rather than supply it. */
/**
 * @param {AstNode} node
 * @param {AstNode} parent
 */
function isClassifyingUse(node, parent) {
  if (parent.type === 'UnaryExpression') return parent.operator === '!';

  if (parent.type === 'CallExpression') {
    return parent.callee.type === 'Identifier' && parent.callee.name === 'Boolean';
  }

  if (parent.type === 'BinaryExpression') {
    if (!VALUE_COMPARISONS.has(parent.operator)) return false;
    // Presence plumbing for EnvContext assembly, not classification.
    const other = parent.left === node ? parent.right : parent.left;
    return !isUndefinedLiteral(other);
  }

  if (!BOOLEAN_TEST_PARENTS.has(parent.type)) return false;
  // A loop/branch body is not a test; only the condition position classifies.
  // `LogicalExpression` is the exception: either operand classifies, so it has
  // no position to compare. The cast is what reads `test` off the rest, since
  // the ESTree union does not narrow on membership in a local set.
  return (
    parent.type === 'LogicalExpression' || /** @type {{ test?: AstNode }} */ (parent).test === node
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Branch on envUtils, never on a raw read of an environment signal createEnvUtilities classifies, the bundler flags included; createEnvUtilities is the single classifier.',
    },
    schema: [],
    messages: {
      directEnvBranch:
        'Branching on `{{key}}` directly re-derives what `createEnvUtilities()` already classifies. Read the environment once into an `envUtils` and branch on it (`env.isLocalDev`, `env.isCI`, `env.isE2E`, `env.isProduction`).',
      bundlerDevFlagBranch: `\`DEV\` is \`NODE_ENV !== 'production'\` and nothing else — the mode the build was run for never reaches it. The env loader here sets \`NODE_ENV\` to \`development\` for every local stack, so a build that loads it reports \`DEV\` true even when the command named production mode, and the same build with the variable unset reports \`DEV\` false. ${BUNDLER_FLAG_ADVICE}`,
      bundlerProdFlagBranch: `\`PROD\` is \`NODE_ENV === 'production'\` and nothing else — the mode the build was run for never reaches it. The env loader here sets \`NODE_ENV\` to \`development\` for every local stack, so a build that loads it reports \`PROD\` false even when the command named production mode, and the same build with the variable unset reports \`PROD\` true. ${BUNDLER_FLAG_ADVICE}`,
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!APPLICATION_SOURCE_PATTERN.test(filename)) return {};
    if (TEST_FILE_PATTERN.test(filename)) return {};

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'MemberExpression' }>} node */
      MemberExpression(node) {
        if (!isEnvObject(node.object)) return;
        const key = memberPropertyName(node);
        if (!CLASSIFYING_KEYS.has(key)) return;
        if (!isClassifyingUse(node, node.parent)) return;
        const messageId = BUNDLER_FLAG_MESSAGES.get(key) ?? 'directEnvBranch';
        context.report({ node, messageId, data: { key } });
      },
    };
  },
};
