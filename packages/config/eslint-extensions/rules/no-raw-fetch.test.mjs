// Programmatic ESLint tests for the vendored no-raw-fetch rule.
// Deliberately independent of the eslint-extensions loader (the same pattern
// the other rule suites use): the extension config is applied directly to
// fixture code, so a result is valid regardless of loader behaviour.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig, { RAW_FETCH_CALLERS } from '../web-api-client.config.mjs';
import noRawFetch from './no-raw-fetch.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const RULE_ID = 'web-api-client/no-raw-fetch';

const WEB_FILE = 'apps/web/src/hooks/use-conversations.ts';

function createLinter() {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

/** @param {string} code */
async function lintAtPath(code, filePath = WEB_FILE) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === RULE_ID);
}

describe('no-raw-fetch', () => {
  it('flags a bare fetch call in the web app', async () => {
    expect(await lintAtPath("export const r = fetch('/api/conversations');\n")).toHaveLength(1);
  });

  it.each(['window', 'globalThis', 'self'])('flags a %s-rooted fetch call', async (root) => {
    expect(
      await lintAtPath(`export const r = ${root}.fetch('/api/conversations');\n`)
    ).toHaveLength(1);
  });

  it('flags a fetch call in a .tsx component', async () => {
    expect(
      await lintAtPath(
        "export const r = fetch('/api/x');\n",
        'apps/web/src/components/chat/composer.tsx'
      )
    ).toHaveLength(1);
  });

  // The nearest legal shape: the same call routed through the typed client.
  it('accepts a typed-client call', async () => {
    expect(await lintAtPath('export const r = apiClient.conversations.$get();\n')).toEqual([]);
  });

  it('accepts reading the platform fetch without calling it', async () => {
    expect(await lintAtPath('export const original = globalThis.fetch;\n')).toEqual([]);
  });

  it('accepts a method named fetch on some other object', async () => {
    expect(await lintAtPath('export const r = queryClient.fetch();\n')).toEqual([]);
  });

  it('accepts another method on a global root', async () => {
    expect(await lintAtPath("export const r = window.alert('hi');\n")).toEqual([]);
  });

  it('accepts a computed access, which is one token away from the banned shape', async () => {
    expect(await lintAtPath("export const r = window['fetch']('/api/x');\n")).toEqual([]);
  });

  it('accepts a call that is not a member expression at all', async () => {
    expect(await lintAtPath("export const r = request('/api/x');\n")).toEqual([]);
  });

  it('flags every caller when the rule is configured with no allowlist', async () => {
    const [sanctionedCaller] = RAW_FETCH_CALLERS;
    if (sanctionedCaller === undefined) throw new Error('the sanctioned-caller list is empty');
    const linter = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        {
          files: ['**/*.ts'],
          plugins: {
            'web-api-client': {
              meta: { name: 'web-api-client', version: '1.0.0' },
              rules: { 'no-raw-fetch': noRawFetch },
            },
          },
          rules: { [RULE_ID]: 'error' },
        },
      ],
    });
    const [result] = await linter.lintText("export const r = fetch('/api/x');\n", {
      filePath: path.join(REPO_ROOT, ...sanctionedCaller.split('/')),
    });
    if (result === undefined) throw new Error('ESLint returned no lint result');
    expect(result.messages.filter((m) => m.ruleId === RULE_ID)).toHaveLength(1);
  });

  it.each(RAW_FETCH_CALLERS)('exempts %s, which is named as a sanctioned caller', async (file) => {
    expect(
      await lintAtPath("export const r = fetch('https://example.test/blob');\n", file)
    ).toEqual([]);
  });

  it('is silent outside the web app source tree', async () => {
    expect(
      await lintAtPath("export const r = fetch('https://example.test');\n", 'apps/api/src/lib/x.ts')
    ).toEqual([]);
  });

  it('is silent in tests, which drive the app through a fetch shim', async () => {
    expect(
      await lintAtPath(
        "export const r = fetch('/api/x');\n",
        'apps/web/src/demo/mock-backend/fetch-shim.test.ts'
      )
    ).toEqual([]);
  });

  it('is silent in a spec-marked module, which is a test file here too', async () => {
    expect(
      await lintAtPath(
        "export const r = fetch('/api/x');\n",
        'apps/web/src/demo/mock-backend/fetch-shim.spec.ts'
      )
    ).toEqual([]);
  });
});
