/**
 * Requires every E2E spec to declare its browser matrix.
 *
 * A spec's project set is derived from two declared properties (see
 * `scripts/lib/playwright/browser-matrix.ts`). A spec that declares neither is the failure
 * this whole mechanism exists to prevent, so it has to be caught before the
 * suite runs — an undeclared spec under a narrowed invocation is precisely one
 * that never executes, which is why a runtime fixture cannot catch it and this
 * sits at the lint rung instead.
 *
 * Only MODULE-SCOPE `test` / `test.describe` calls need a declaration:
 * Playwright applies a describe's tags to everything inside it, so requiring a
 * declaration on nested tests would demand redundant restatement.
 *
 * A declaration is either an inline `matrix({...})` call or an identifier bound
 * at module scope to one. Hand-written `{ tag: … }` options do not satisfy the
 * rule — the helper is what makes both axes mandatory and keeps the tag
 * vocabulary in one place.
 *
 * The `planes` option carries the plane projects, and is what makes the
 * `engine-fixed` arm checkable: that arm claims the enclosing plane fixes the
 * engine, which is a fact about where the file sits rather than about the
 * behaviour, so only this rung can see it. A plane's specs live in
 * `e2e/<project name>/` — its testDir — so a plane whose directory stops
 * matching its name reddens every `engine-fixed` spec in it, which is the loud
 * direction.
 *
 * More than one plane project refuses the arm outright, deliberately broader
 * than the decay it guards: the registry says which plane projects exist but not
 * which directory each serves, so a second one may or may not be a second engine
 * over the same specs. Silence there is the one failure this arm must not have,
 * so the rule refuses rather than guessing, and its message carries the two-step
 * repair — give the registry each plane's testDir, then scope this check to the
 * enclosing plane — because the developer who trips it did not write the specs
 * it reddens, and a refusal naming no next step is the one that gets disabled.
 */

const MATRIX_HELPER = 'matrix';

/** True for `test(...)` and `test.describe(...)`. */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */

/** @param {Extract<AstNode, { type: 'CallExpression' }>} node */
function isTestCall(node) {
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'test';
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'test' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'describe'
  );
}

/** True when the node is a `matrix({...})` call. */
/**
 * @param {AstNode | null | undefined} node
 * @returns {node is Extract<AstNode, { type: 'CallExpression' }>}
 */
function isMatrixCall(node) {
  return (
    node !== null &&
    node !== undefined &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === MATRIX_HELPER
  );
}

const FIXED_ENGINE = 'engine-fixed';

/**
 * The statically-known name of an object key, empty when it has none.
 *
 * @param {AstNode} property
 * @returns {string}
 */
function propertyName(property) {
  if (property.type !== 'Property') return '';
  const { key } = property;
  if (key.type === 'Identifier') return key.name;
  return key.type === 'Literal' ? String(key.value) : '';
}

/**
 * The `engine` a `matrix({...})` call declares, when it is a literal. A computed
 * or spread engine reads as undeclared here rather than as some arm: the type
 * already refuses one, and guessing would be the only way this rule could accept
 * `engine-fixed` without seeing it.
 */
/**
 * @param {Extract<AstNode, { type: 'CallExpression' }>} node
 * @returns {string}
 */
function declaredEngine(node) {
  const [argument] = node.arguments;
  if (argument?.type !== 'ObjectExpression') return '';
  for (const property of argument.properties) {
    if (propertyName(property) !== 'engine') continue;
    // Only the property form carries a value, and `propertyName` returns '' for
    // every other kind, so a name match establishes the form.
    const { value } = /** @type {Extract<AstNode, { type: 'Property' }>} */ (property);
    return value.type === 'Literal' ? String(value.value) : '';
  }
  return '';
}

/** Every `test(...)` / `test.describe(...)` call at module scope. */
/** @param {Extract<AstNode, { type: 'Program' }>} program */
function* topLevelTestCalls(program) {
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement') continue;
    const call = statement.expression;
    if (call.type === 'CallExpression' && isTestCall(call)) yield call;
  }
}

/** Distinguishes a call that declares nothing from one whose engine is unreadable. */
const UNDECLARED = Symbol('undeclared');

/**
 * The engine a test call's second argument declares, through either accepted
 * form — the inline `matrix({...})` call or a module-scope constant bound to one.
 */
/**
 * @param {AstNode | null | undefined} argument
 * @param {ReadonlyMap<string, string>} declaredNames
 * @returns {string | typeof UNDECLARED}
 */
function declaredEngineFor(argument, declaredNames) {
  if (isMatrixCall(argument)) return declaredEngine(argument);
  if (argument?.type === 'Identifier' && declaredNames.has(argument.name)) {
    return /** @type {string} */ (declaredNames.get(argument.name));
  }
  return UNDECLARED;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every E2E spec to declare its engine and form-factor properties through the matrix() helper.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          planes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      undeclared:
        'This spec declares no browser matrix. Pass matrix({ engine, formFactor }) as the second argument — the project set is derived from it, and an undeclared spec silently changes which projects run it.',
      fixedOutsidePlane:
        'engine-fixed says the enclosing plane fixes the engine, and this spec is in no plane directory ({{directories}}). The engine projects collect this file, so declare engine-matrix, engine-any or engine-pinned instead — engine-fixed elects no carrier, so here it would leave the spec running nowhere.',
      planeEngineNotFixed:
        'engine-fixed rests on the registry declaring exactly one plane project, and it now declares {{planes}}. This rule finds a plane by name — its specs live in e2e/<project name>/ — which cannot tell whether two plane projects now serve one directory. Repair it in two steps: carry each plane testDir in the registry (scripts/lib/playwright/projects.ts) so playwright.config.ts and this rule read one statement of it, then scope this check to the enclosing plane, the one whose testDir holds the spec, and refuse only a plane that more than one project serves.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!filename.endsWith('.spec.ts')) return {};

    /** @type {readonly string[]} */
    const planes = context.options[0]?.planes ?? [];
    const planeDirectories = planes.map((plane) => `/e2e/${plane}/`);

    /** Module-scope constants bound to a `matrix(...)` call, by declared engine. */
    /** @type {Map<string, string>} */
    const declaredNames = new Map();

    /** The reasons `engine-fixed` does not hold for this file, if any. */
    /** @returns {{ messageId: string, data: Record<string, string> } | undefined} */
    function fixedArmProblem() {
      if (planes.length !== 1) {
        return { messageId: 'planeEngineNotFixed', data: { planes: planes.join(', ') || 'none' } };
      }
      if (planeDirectories.some((directory) => filename.includes(directory))) return;
      return {
        messageId: 'fixedOutsidePlane',
        data: { directories: planeDirectories.join(', ') },
      };
    }

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'VariableDeclarator' }>} node */
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isMatrixCall(node.init))
          declaredNames.set(node.id.name, declaredEngine(node.init));
      },
      /** @param {Extract<AstNode, { type: 'Program' }>} program */
      'Program:exit'(program) {
        for (const call of topLevelTestCalls(program)) {
          const engine = declaredEngineFor(call.arguments[1], declaredNames);
          if (engine === UNDECLARED) {
            context.report({ node: call, messageId: 'undeclared' });
            continue;
          }
          if (engine !== FIXED_ENGINE) continue;
          const problem = fixedArmProblem();
          if (problem !== undefined) context.report({ node: call, ...problem });
        }
      },
    };
  },
};
