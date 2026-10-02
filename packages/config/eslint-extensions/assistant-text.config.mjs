/**
 * Assistant-text ownership lint extension: the vendored no-delimiter-literal
 * rule.
 *
 * The raw text of an assistant message has exactly one grammar, owned by the
 * shared assistant-text grammar module. The rule applies repo-wide
 * (every package linting through createBaseConfig); the files it exempts, and
 * the delimiters each may hold, are its `EXEMPTIONS` map of repo-relative path
 * suffixes, matched against the end of each linted file's absolute path, so the
 * broad `files` glob below is safe under any package's glob base path.
 */
import noDelimiterLiteral from './rules/no-delimiter-literal.mjs';

const assistantTextPlugin = {
  meta: { name: 'assistant-text', version: '1.0.0' },
  rules: {
    'no-delimiter-literal': noDelimiterLiteral,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'no-delimiter-literal',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'assistant-text': assistantTextPlugin },
    rules: {
      'assistant-text/no-delimiter-literal': 'error',
    },
  },
];
