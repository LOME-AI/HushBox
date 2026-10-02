/**
 * API error-body lint extension: the vendored error-response-constructor rule.
 *
 * `createErrorResponse(code, details?)` builds every API error body; a
 * hand-built one is the defect (`docs/CODE-RULES.md` §Error Responses).
 *
 * The rule self-scopes by ABSOLUTE filename to the product Worker's source
 * tree, so the broad `files` glob below behaves identically regardless of
 * which package's eslint.config.js provides the glob base path.
 */
import errorResponseConstructor from './rules/error-response-constructor.mjs';

const errorResponsesPlugin = {
  meta: { name: 'error-responses', version: '1.0.0' },
  rules: {
    'error-response-constructor': errorResponseConstructor,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'error-responses',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'error-responses': errorResponsesPlugin },
    rules: {
      'error-responses/error-response-constructor': 'error',
    },
  },
];
