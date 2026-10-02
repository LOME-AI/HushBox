/**
 * Bans the assistant-text delimiters in string values outside the one grammar
 * module: the record separator that frames a segment (U+001E) and the
 * natively emitted `<think>` / `</think>` tags.
 *
 * An assistant message's raw text is owned by the shared assistant-text grammar
 * module, the ONLY code that may read or write its delimiters. Every other
 * consumer (the stream reducer, history replay, display) goes through its
 * exported API, so a delimiter string anywhere else is a second implementation
 * in the making. Detection is on string values (string literals and template
 * quasis), not comments: prose may mention the format; code may not write it.
 *
 * Exemptions are per delimiter, keyed by ABSOLUTE filename suffix so the
 * repo-wide `files` glob is safe under any consuming package's glob base path.
 * {@link EXEMPTIONS} maps each exempt file to exactly the delimiters it may hold:
 * the grammar module, its test and its two property tests hold every
 * delimiter; the legal copy digest holds the record separator only, as the
 * separator of the legal copy its digest is taken over.
 *
 * This file never holds the record separator itself; it builds the character
 * from its code point.
 */

const THINK_OPEN = { value: '<think>', name: '<think>' };
const THINK_CLOSE = { value: '</think>', name: '</think>' };
const RECORD_SEPARATOR = {
  value: String.fromCodePoint(0x1e),
  name: 'record separator (U+001E)',
};

const DELIMITERS = [THINK_OPEN, THINK_CLOSE, RECORD_SEPARATOR];

/** @type {ReadonlyArray<{ suffix: string; allowed: ReadonlyArray<typeof THINK_OPEN> }>} */
const EXEMPTIONS = [
  { suffix: 'packages/shared/src/assistant-text/grammar.ts', allowed: DELIMITERS },
  { suffix: 'packages/shared/src/assistant-text/grammar.test.ts', allowed: DELIMITERS },
  { suffix: 'packages/shared/src/assistant-text/grammar.property.test.ts', allowed: DELIMITERS },
  { suffix: 'packages/shared/src/assistant-text/reducer.property.test.ts', allowed: DELIMITERS },
  { suffix: 'packages/shared/src/legal/copy-digest.ts', allowed: [RECORD_SEPARATOR] },
];

/**
 * The delimiters a file may not hold.
 * @param {string} filename
 */
function bannedIn(filename) {
  const exemption = EXEMPTIONS.find((entry) => filename.endsWith(entry.suffix));
  if (exemption === undefined) return DELIMITERS;
  return DELIMITERS.filter((delimiter) => !exemption.allowed.includes(delimiter));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid the assistant-text delimiters (U+001E and the think tags) outside the shared grammar module.',
    },
    schema: [],
    messages: {
      banned:
        'The {{delimiter}} delimiter belongs to packages/shared/src/assistant-text/grammar.ts alone. Build or parse assistant text through its exported API, never by writing the delimiter.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const banned = bannedIn(context.filename.replaceAll('\\', '/'));
    if (banned.length === 0) return {};

    /**
     * @param {import('eslint').Rule.Node} node
     * @param {string} value
     */
    function check(node, value) {
      const delimiter = banned.find((candidate) => value.includes(candidate.value));
      if (delimiter !== undefined) {
        context.report({ node, messageId: 'banned', data: { delimiter: delimiter.name } });
      }
    }

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'Literal' }>} node */
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'TemplateElement' }>} node */
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
