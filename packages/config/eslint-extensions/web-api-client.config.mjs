/**
 * Typed-API-client confinement lint extension: the vendored no-raw-fetch rule.
 *
 * `apps/web/src/lib/api-client.ts` is where typed API calls come from, and an
 * endpoint it covers is reached through it rather than by hand
 * (`docs/CODE-RULES.md` §API Client).
 *
 * The rule self-scopes by ABSOLUTE filename to the web app's source tree, so
 * the broad `files` glob below behaves identically regardless of which
 * package's eslint.config.js provides the glob base path.
 */
import noRawFetch from './rules/no-raw-fetch.mjs';

/**
 * The sanctioned raw-fetch callers — the ONE authoritative list, matched as
 * repo-relative path suffixes of the calling file. Each carries the reason it
 * calls the platform primitive, and neither reason generalises:
 *
 * - `apps/web/src/lib/api-client.ts` — IS the typed client. It is where the
 *   doctrine's "single source" resolves to a network call, and the one file
 *   that must reach the primitive for every other file to be able not to.
 * - `apps/web/src/hooks/crypto/use-decrypt-blob.ts` — GETs a presigned R2
 *   URL, which is not an API endpoint and is deliberately credential-free
 *   (the typed client attaches session headers this request must not carry).
 *   Storage bytes never travel through the API, so no typed route exists to
 *   route it through.
 */
export const RAW_FETCH_CALLERS = [
  'apps/web/src/lib/api-client.ts',
  'apps/web/src/hooks/crypto/use-decrypt-blob.ts',
];

const webApiClientPlugin = {
  meta: { name: 'web-api-client', version: '1.0.0' },
  rules: {
    'no-raw-fetch': noRawFetch,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'web-api-client',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'web-api-client': webApiClientPlugin },
    rules: {
      'web-api-client/no-raw-fetch': ['error', { allowedFiles: RAW_FETCH_CALLERS }],
    },
  },
];
