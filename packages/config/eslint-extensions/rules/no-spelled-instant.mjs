/**
 * Refuses an ISO timestamp spelled in a test module.
 *
 * Every instant a test uses comes from the shared test-time module, so a test
 * commits nothing that says when it was written and its instants agree with
 * every other test's. A spelled timestamp breaks both.
 *
 * WHAT COUNTS AS AN INSTANT. A calendar date joined to a time of day by `T` —
 * any hour, with or without seconds, fractions or an offset. A bare date is not
 * an instant and is left alone, because dates appear as data (a day key, an
 * audit directory name) where no clock is involved.
 *
 * WHERE IT IS READ. Every string literal (a string literal type included), every
 * static part of a template literal, and JSX text — the places a test writes a
 * value. A value assembled at run time is invisible to it, which is what the
 * rule's own suite relies on; the rule is a gate on spelling, not a proof that
 * no test reaches a literal instant.
 *
 * The rule self-scopes by filename through `test-file-spellings.ts`, and takes
 * the directories it exempts as absolute paths from its config, where each
 * carries its reason.
 */
import path from 'node:path';
import { TEST_FILE_PATTERN } from '../../test-file-spellings.ts';

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid an ISO timestamp spelled in a test module; take the instant from the shared test-time module.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          exemptDirectories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                directory: { type: 'string' },
                reason: { type: 'string', minLength: 1 },
              },
              required: ['directory', 'reason'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      spelledInstant:
        'A test spells no instant. Take it from `@hushbox/shared/test-time` (e.g. `isoAt(TEST_DAY_START + n * DAY_MS)`), or from `@hushbox/shared/test-instants` in a module that cannot load the test runner.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};
    /** @type {{ exemptDirectories?: { directory: string }[] }} */
    const options = context.options[0] ?? {};
    const exempt = (options.exemptDirectories ?? []).some(({ directory }) =>
      context.filename.startsWith(directory + path.sep)
    );
    if (exempt) return {};

    /**
     * @param {import('eslint').Rule.Node} node
     * @param {string} text
     */
    function check(node, text) {
      if (ISO_INSTANT.test(text)) context.report({ node, messageId: 'spelledInstant' });
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
      /** @param {import('eslint').Rule.Node & { value: string }} node */
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
};
