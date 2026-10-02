/**
 * Bans a bare `.set` of a request-scoped variable — a member of the
 * `ScopedVariable` union in `apps/api/src/lib/context/request-scope.ts` —
 * inside the product Worker's source tree, outside the one module that owns
 * the write.
 *
 * Each of those variables is exposed on TWO surfaces: `c.var`, read by
 * everything holding a `Context`, and the ambient request scope, read by the
 * composition-root adapters that hold none. `bindRequestValue` is the single
 * writer for both. A bare `c.set` writes only the first, so the ambient
 * readers go on answering with whatever the pipeline bound — and the direction
 * that fails is the green one: a fixture injecting a fake to prove a failure
 * path leaves the ambient consumers on the real client and the test passes
 * having exercised nothing.
 *
 * A type cannot close this. Hono derives the setter and the getter from the
 * same `Variables` entry, so a key readable through the ambient scope is
 * writable through `c.set` by construction, and there is no type that admits
 * the read while refusing the write.
 *
 * The check is SYNTACTIC AND RECEIVER-AGNOSTIC: any `.set` whose first
 * argument is one of those names, written as a literal, is reported, whatever
 * it is called on. Asking what the receiver is would make a lint gate depend
 * on a program-wide type build, and the trade is cheap here — a `Map` keyed by
 * one of those names would be reported, and its remedy is to name its key
 * something that is not a request-scoped variable.
 *
 * Self-scopes by ABSOLUTE filename (the `apps/api/src` tree, exempting the
 * owning module), so the `files` globs in the topic config can stay broad and
 * behave identically under any consuming package's glob base path.
 */

// Node types, derived from ESLint's own rule-node union: `@types/estree` does
// not resolve from this package, so an `import('estree')` specifier written
// here would not type-check.
/** @typedef {Extract<import('eslint').Rule.Node, { type: 'CallExpression' }>} CallNode */
/** @typedef {Extract<CallNode['callee'], { type: 'MemberExpression' }>} MemberNode */

const API_SOURCE = /\/apps\/api\/src\//;

const OWNING_MODULE = 'apps/api/src/lib/context/request-scope.ts';

/**
 * The variables the ambient request scope carries alongside `c.var`. A `.mjs`
 * module cannot import the type they come from, so this list is the one place
 * they are spelled a second time; the architecture rule
 * `scoped-set-gate-matches-the-scoped-type` is what holds it equal to
 * `ScopedVariable`.
 */
const SCOPED_KEYS = new Set(['db', 'redis', 'logger', 'principal']);

/**
 * True when a call goes through a member named `set`, spelled either way. A
 * member computed from anything else is outside the rule, exactly as a key it
 * cannot read as a literal is.
 *
 * @param {MemberNode} callee
 */
function isSetMember(callee) {
  const { property, computed } = callee;
  return computed
    ? property.type === 'Literal' && property.value === 'set'
    : property.type === 'Identifier' && property.name === 'set';
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bind a request-scoped variable through bindRequestValue; a bare set writes c.var alone and leaves the ambient request scope stale.',
    },
    schema: [],
    messages: {
      bare: "Bare set of the request-scoped variable '{{key}}' — this writes c.var alone, so everything reading the ambient request scope keeps answering with the value the pipeline bound. Call bindRequestValue(c, '{{key}}', value), the single writer for both surfaces.",
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!API_SOURCE.test(filename) || filename.endsWith(OWNING_MODULE)) return {};

    return {
      /** @param {CallNode} node */
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression') return;
        if (!isSetMember(callee)) return;
        const [key] = node.arguments;
        if (key?.type !== 'Literal' || typeof key.value !== 'string') return;
        if (!SCOPED_KEYS.has(key.value)) return;
        context.report({ node, messageId: 'bare', data: { key: key.value } });
      },
    };
  },
};
