// Programmatic ESLint tests for the vendored no-bare-scoped-set rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to fixture
// code, so these tests stay valid regardless of loader behavior.
//
// Fixtures are INLINE and are linted at synthesized absolute paths, because
// the rule self-scopes by absolute filename — the scope is as much of the
// behaviour as the report itself.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../request-scope.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function createLinter() {
  return new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

/**
 * Lints inline code at a synthesized path under this directory. The tail is
 * what the rule reads — it scopes on the tree a filename ends in — and the
 * path stays under the linter's own base path, which is where ESLint will
 * lint a file at all.
 *
 * @param {string} code
 * @param {string} treePath
 */
async function lintAtPath(code, treePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...treePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'request-scope/no-bare-scoped-set');
}

const API_FILE = 'apps/api/src/slices/sample/routes.test.ts';

describe('no-bare-scoped-set', () => {
  it('flags a bare set of the database handle', async () => {
    expect(await lintAtPath("c.set('db', handle);\n", API_FILE)).toHaveLength(1);
  });

  it('flags a bare set of the redis client', async () => {
    expect(await lintAtPath("c.set('redis', fake);\n", API_FILE)).toHaveLength(1);
  });

  it('flags a bare set of the telemetry port', async () => {
    expect(await lintAtPath("c.set('logger', recorder);\n", API_FILE)).toHaveLength(1);
  });

  it('flags a bare set of the principal', async () => {
    expect(await lintAtPath("c.set('principal', actor);\n", API_FILE)).toHaveLength(1);
  });

  it('names bindRequestValue as the remedy', async () => {
    const [message] = await lintAtPath("c.set('db', handle);\n", API_FILE);

    expect(message?.message).toContain('bindRequestValue');
  });

  it('allows the single writer that binds both surfaces', async () => {
    expect(await lintAtPath("bindRequestValue(c, 'db', handle);\n", API_FILE)).toEqual([]);
  });

  it('leaves a variable outside the scoped set alone', async () => {
    expect(await lintAtPath("c.set('requestId', id);\n", API_FILE)).toEqual([]);
  });

  it('leaves a key it cannot read as a literal alone', async () => {
    expect(await lintAtPath('c.set(key, value);\n', API_FILE)).toEqual([]);
  });

  it('leaves a key that is no string at all alone', async () => {
    expect(await lintAtPath('c.set(1, value);\n', API_FILE)).toEqual([]);
  });

  it('flags the key whatever object carries the set', async () => {
    expect(await lintAtPath("cache.set('db', handle);\n", API_FILE)).toHaveLength(1);
  });

  it('flags the same call written through a computed member', async () => {
    expect(await lintAtPath("c['set']('db', handle);\n", API_FILE)).toHaveLength(1);
  });

  it('leaves a call through a member it cannot read alone', async () => {
    expect(await lintAtPath("c[method]('db', handle);\n", API_FILE)).toEqual([]);
  });

  it('leaves a read of the same variable alone', async () => {
    expect(await lintAtPath("c.get('db');\n", API_FILE)).toEqual([]);
  });

  it('leaves a set carrying no key at all alone', async () => {
    expect(await lintAtPath('c.set();\n', API_FILE)).toEqual([]);
  });

  it('reports every bare set in the file, not only the first', async () => {
    expect(
      await lintAtPath("c.set('redis', fake);\nc.set('logger', recorder);\n", API_FILE)
    ).toHaveLength(2);
  });

  it('is silent in the module that owns the write to both surfaces', async () => {
    expect(
      await lintAtPath("c.set('db', handle);\n", 'apps/api/src/lib/context/request-scope.ts')
    ).toEqual([]);
  });

  it('is silent outside the product Worker tree', async () => {
    expect(await lintAtPath("c.set('db', handle);\n", 'apps/web/src/lib/sample.ts')).toEqual([]);
  });
});
