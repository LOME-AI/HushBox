/**
 * Bans the retired fixed-window counter shape `{ count, firstAttempt }`.
 *
 * That pair is the stored state of a read-then-write limiter: the reader has to
 * fetch both fields, decide whether the window has rolled, and write both back,
 * which is precisely the non-atomic gate that admits `cap × concurrency`. The
 * surviving primitive stores a bare integer under a key whose TTL IS the
 * window, so a rate-limit entry that needs a `firstAttempt` is by construction
 * a second implementation.
 *
 * The pair is what identifies it. A lone `count` is ordinary (the decision
 * itself carries one), and a lone `firstAttempt`-prefixed name belongs to
 * unrelated code — only both together name the retired shape.
 *
 * Self-scopes by ABSOLUTE filename because flat-config glob base paths differ
 * per consuming package.
 */

const DEFAULT_SCOPE = String.raw`/apps/api/src/`;

const COUNT = 'count';
const FIRST_ATTEMPT = 'firstAttempt';

/**
 * The declared name of an object property, a type member or an interface
 * member. A spread carries no key, and a computed or numeric key names nothing
 * the rule can compare — both are simply not the field it looks for.
 */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */
/** @typedef {{ readonly type?: string, readonly key?: AstNode }} KeyedMember */

/**
 * @param {KeyedMember} member
 * @returns {string}
 */
function memberName(member) {
  const key = member.key;
  if (key?.type === 'Identifier') return key.name;
  return key?.type === 'Literal' && typeof key.value === 'string' ? key.value : '';
}

/** @param {readonly KeyedMember[]} members */
function declaresWindowShape(members) {
  const names = new Set(members.map((member) => memberName(member)));
  return names.has(COUNT) && names.has(FIRST_ATTEMPT);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban the retired {count, firstAttempt} fixed-window counter shape; rate limits store a bare integer whose key TTL is the window.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          scopedFiles: {
            type: 'string',
            description: 'Regex matched against the absolute filename; matching files are checked.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      banned:
        'The retired {count, firstAttempt} window shape — its read-then-write gate admits cap × concurrency. Declare a ThrottleLimit/ReservationLimit entry and call `consume` instead.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const scoped = new RegExp(context.options[0]?.scopedFiles ?? DEFAULT_SCOPE);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scoped.test(filename)) return {};

    /**
     * @param {AstNode} node
     * @param {readonly KeyedMember[]} members
     */
    const check = (node, members) => {
      if (declaresWindowShape(members)) context.report({ node, messageId: 'banned' });
    };

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ObjectExpression' }>} node */
      ObjectExpression(node) {
        check(node, node.properties);
      },
      // The TypeScript-only declaration nodes ESTree does not name; each is read
      // only for the member keys the shape check compares.
      /** @param {import('eslint').Rule.Node & { members: readonly KeyedMember[] }} node */
      TSTypeLiteral(node) {
        check(node, node.members);
      },
      /** @param {import('eslint').Rule.Node & { body: readonly KeyedMember[] }} node */
      TSInterfaceBody(node) {
        check(node, node.body);
      },
    };
  },
};
