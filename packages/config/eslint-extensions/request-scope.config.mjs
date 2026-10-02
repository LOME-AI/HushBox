/**
 * Request-scope binding lint extension: the vendored no-bare-scoped-set rule.
 *
 * A request-scoped variable — a member of the `ScopedVariable` union in
 * `apps/api/src/lib/context/request-scope.ts` — lives on two surfaces at once:
 * `c.var` and the ambient request scope. `bindRequestValue` is the single
 * writer for both, and the rule refuses the commit that would diverge them.
 *
 * The rule self-scopes by ABSOLUTE filename (the `apps/api/src` tree, minus
 * the module that owns the write), so the broad `files` globs below are
 * correct under any consuming package's glob base path.
 */
import noBareScopedSet from './rules/no-bare-scoped-set.mjs';

const requestScopePlugin = {
  meta: { name: 'request-scope', version: '1.0.0' },
  rules: {
    'no-bare-scoped-set': noBareScopedSet,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'request-scope',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'request-scope': requestScopePlugin },
    rules: {
      'request-scope/no-bare-scoped-set': 'error',
    },
  },
];
