// Programmatic ESLint tests for the vendored error-response-constructor rule.
// Deliberately independent of the eslint-extensions loader (the same pattern
// the other rule suites use): the extension config is applied directly to
// fixture code, so a result is valid regardless of loader behaviour.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../error-responses.config.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const RULE_ID = 'error-responses/error-response-constructor';

const ROUTE_FILE = 'apps/api/src/slices/billing/routes.ts';

function createLinter() {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

/** @param {string} code */
async function lintAtPath(code, filePath = ROUTE_FILE) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === RULE_ID);
}

describe('error-response-constructor', () => {
  it('flags a hand-built body on an error status', async () => {
    expect(await lintAtPath("export const r = c.json({ code: 'NOPE' }, 400);\n")).toHaveLength(1);
  });

  it('names the status it refused in the report', async () => {
    const [message] = await lintAtPath("export const r = c.json({ code: 'NOPE' }, 503);\n");
    expect(message?.message).toContain('503');
  });

  it('flags the `error` envelope the doctrine sentence names, at any status', async () => {
    expect(await lintAtPath("export const r = c.json({ error: 'boom' }, 200);\n")).toHaveLength(1);
  });

  it('flags an `error` envelope written with a quoted key', async () => {
    expect(await lintAtPath("export const r = c.json({ 'error': 'boom' });\n")).toHaveLength(1);
  });

  // The nearest legal shape: the house spelling every refusal helper uses.
  it('accepts createErrorResponse on an error status', async () => {
    expect(
      await lintAtPath(
        'export const r = c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);\n'
      )
    ).toEqual([]);
  });

  it('accepts createErrorResponse with details', async () => {
    expect(
      await lintAtPath(
        'export const r = c.json(createErrorResponse(ERROR_CODES.RATE_LIMITED, { retryAfterSeconds }), 429);\n'
      )
    ).toEqual([]);
  });

  it('accepts a success body, which carries no error contract', async () => {
    expect(await lintAtPath('export const r = c.json({ balance }, 200);\n')).toEqual([]);
  });

  it('accepts a success body with no status argument', async () => {
    expect(await lintAtPath('export const r = c.json({ balance });\n')).toEqual([]);
  });

  it('leaves a runtime-computed status to the shared refusal helpers', async () => {
    expect(
      await lintAtPath('export const r = c.json(body, STATUS_BY_DOMAIN_CODE[error.code]);\n')
    ).toEqual([]);
  });

  it('ignores a zero-argument .json() — that reads a response, it does not write one', async () => {
    expect(await lintAtPath('export const body = await response.json();\n')).toEqual([]);
  });

  it('sees through a computed key that spells `error`', async () => {
    expect(await lintAtPath("export const r = c.json({ ['error']: 'boom' }, 400);\n")).toHaveLength(
      1
    );
  });

  it('falls back to the status check when a key is computed at run time', async () => {
    const found = await lintAtPath('export const r = c.json({ [key]: value }, 400);\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('createErrorResponse');
  });

  it('flags a spread-only body on an error status', async () => {
    expect(await lintAtPath('export const r = c.json({ ...rest }, 400);\n')).toHaveLength(1);
  });

  it('ignores a computed .json access, which is not the response helper shape', async () => {
    expect(await lintAtPath("export const r = c['json']({ error: 'x' }, 400);\n")).toEqual([]);
  });

  it('ignores a non-numeric status argument', async () => {
    expect(await lintAtPath("export const r = c.json({ a }, '400');\n")).toEqual([]);
  });

  it('flags a body built by some other call on an error status', async () => {
    expect(await lintAtPath('export const r = c.json(helpers.build(), 400);\n')).toHaveLength(1);
  });

  it('accepts a success status below the error range', async () => {
    expect(await lintAtPath('export const r = c.json({ a }, 201);\n')).toEqual([]);
  });

  it('is silent outside the product Worker source tree', async () => {
    expect(
      await lintAtPath(
        "export const r = c.json({ error: 'boom' }, 400);\n",
        'apps/docket/src/server.ts'
      )
    ).toEqual([]);
  });

  it('is silent in tests, which construct off-contract bodies as fixtures', async () => {
    expect(
      await lintAtPath(
        "export const r = c.json({ error: 'boom' }, 400);\n",
        'apps/api/src/slices/billing/routes.test.ts'
      )
    ).toEqual([]);
  });

  it('is silent in a spec-marked module, which is a test file here too', async () => {
    expect(
      await lintAtPath(
        "export const r = c.json({ error: 'boom' }, 400);\n",
        'apps/api/src/slices/billing/routes.spec.ts'
      )
    ).toEqual([]);
  });
});
