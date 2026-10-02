// @ts-check

/**
 * Requires a reason on every lint suppression.
 *
 * A suppression asserts that a rule is wrong about the line beneath it. Written
 * bare, the assertion is unreviewable: a later reader cannot tell a deliberate
 * exception from a directive someone added to get past a gate, so it is never
 * revisited and never retired. The reason is what makes it either.
 *
 * The demanded text is ESLint's own description form, not a convention layered
 * over it: {@link SEPARATOR} is the pattern ESLint itself splits a directive's
 * justification on, so a directive ESLint reads as explained is one this rule
 * reads as explained. Its reach is wider than the ` -- ` most sites are written
 * with — any whitespace, two or more dashes, any whitespace — which is why a
 * reason may start on the line below the separator in a block comment.
 *
 * Detection is over comment text rather than through any directive API: ESLint
 * exposes its parsed directives to the linter, never to a rule.
 *
 * A directive naming no rules cannot be reported in a way any verdict reads. It
 * disables every rule from its own position onward, and a problem is suppressed
 * when the directive's position is at or before the problem's — so the report
 * this rule makes about that comment falls inside what the comment disables,
 * reaching only ESLint's suppressed-message channel. The block and same-line
 * spellings are positioned at the comment's start and so cover themselves; the
 * next-line spelling is positioned at the comment's end and does not.
 *
 * @typedef {import('eslint').AST.Program['comments'][number] & { range: [number, number] }} LocatedComment
 */

const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?![-\w])/u;

/** The justification separator, spelled as ESLint's own parser spells it. */
const SEPARATOR = /\s-{2,}\s/u;

/** @param {string} text */
const carriesReason = (text) => {
  const match = SEPARATOR.exec(text);
  return match !== null && text.slice(match.index + match[0].length).trim() !== '';
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Require a reason, written after ESLint's ` -- ` separator, on every eslint-disable directive.",
    },
    schema: [],
    messages: {
      missingReason:
        'This suppression claims a rule is wrong here and says nothing about why. Write the reason after ` -- `, following the rule names.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        for (const comment of /** @type {readonly LocatedComment[]} */ (
          sourceCode.getAllComments()
        )) {
          if (!DIRECTIVE.test(comment.value) || carriesReason(comment.value)) continue;
          context.report({
            loc: {
              start: sourceCode.getLocFromIndex(comment.range[0]),
              end: sourceCode.getLocFromIndex(comment.range[1]),
            },
            messageId: 'missingReason',
          });
        }
      },
    };
  },
};
