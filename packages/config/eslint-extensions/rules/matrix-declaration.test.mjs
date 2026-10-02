// Programmatic ESLint tests for the vendored matrix-declaration rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to fixture
// code, so these tests stay valid regardless of loader behavior.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../browser-matrix.config.mjs';
import matrixDeclaration from './matrix-declaration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function createLinter() {
  return new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

/**
 * @param {string} code
 * @param {string} filePath
 */
async function lintAtPath(code, filePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'browser-matrix/matrix-declaration');
}

const SPEC = 'e2e/chat/example.spec.ts';
const PLANE_SPEC = 'e2e/admin/example.spec.ts';

/**
 * Lints against a hand-written plane set rather than the shipped one, so the
 * decay case — a plane that stops being one project — is provable without
 * editing the project registry.
 *
 * @param {string} code
 * @param {string} filePath
 * @param {string[]} planes
 */
async function lintWithPlanes(code, filePath, planes) {
  const linter = new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      {
        files: ['**/*.spec.ts'],
        plugins: { 'browser-matrix': { rules: { 'matrix-declaration': matrixDeclaration } } },
        rules: { 'browser-matrix/matrix-declaration': ['error', { planes }] },
      },
    ],
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'browser-matrix/matrix-declaration');
}

describe('matrix-declaration', () => {
  it('accepts a describe declared with an inline matrix call', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test.describe('x', matrix({ engine: 'engine-matrix', formFactor: 'either' }), () => {});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });

  it('accepts a describe declared through a module-scope constant', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });
test.describe('x', SPEC_MATRIX, () => {});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });

  it('accepts a top-level test declared through a constant', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
const M = matrix({ engine: 'engine-any', formFactor: 'desktop', reason: 'r' });
test('x', M, async () => {});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });

  it('flags a top-level describe with no declaration', async () => {
    const code = `test.describe('x', () => {});\n`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(1);
  });

  it('flags a top-level test with no declaration', async () => {
    const code = `test('x', async () => {});\n`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(1);
  });

  it('flags a declaration object that bypasses the matrix helper', async () => {
    const code = `test.describe('x', { tag: '@engine-any-desktop' }, () => {});\n`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(1);
  });

  it('does not require a declaration on tests nested inside a declared describe', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
const M = matrix({ engine: 'engine-matrix', formFactor: 'either' });
test.describe('x', M, () => {
  test('inner', async () => {});
});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });

  it('ignores a module-scope constant that is not a matrix call', async () => {
    const code = `const NOT_A_DECLARATION = { tag: '@desktop' };
test.describe('x', NOT_A_DECLARATION, () => {});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(1);
  });

  it('ignores top-level statements that are not test calls', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
console.log('setup');
someHelper();
const M = matrix({ engine: 'engine-matrix', formFactor: 'either' });
test.describe('x', M, () => {});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });

  it('only inspects top-level statements, not a describe bound to a variable', async () => {
    const code = `const held = test.describe('x', () => {});\n`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });

  it('exempts a non-spec file even when the config glob reaches it', async () => {
    const linter = new ESLint({
      cwd: here,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        {
          files: ['**/*.ts'],
          plugins: { 'browser-matrix': { rules: { 'matrix-declaration': matrixDeclaration } } },
          rules: { 'browser-matrix/matrix-declaration': 'error' },
        },
      ],
    });
    const [result] = await linter.lintText(`test.describe('x', () => {});\n`, {
      filePath: path.join(here, 'e2e/helpers/thing.ts'),
    });
    if (result === undefined) throw new Error('ESLint returned no lint result');
    expect(
      result.messages.filter((m) => m.ruleId === 'browser-matrix/matrix-declaration')
    ).toHaveLength(0);
  });

  it('ignores non-spec files in the suite', async () => {
    const code = `test.describe('x', () => {});\n`;
    expect(await lintAtPath(code, 'e2e/helpers/thing.ts')).toHaveLength(0);
  });

  it('accepts an engine-fixed declaration on a spec inside the plane directory', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
const M = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });
test.describe('x', M, () => {});
`;
    expect(await lintAtPath(code, PLANE_SPEC)).toHaveLength(0);
  });

  it('flags an engine-fixed declaration on a spec the engine projects collect', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
const M = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });
test.describe('x', M, () => {});
`;
    const [message, ...rest] = await lintAtPath(code, SPEC);
    expect(rest).toEqual([]);
    expect(message?.messageId).toBe('fixedOutsidePlane');
  });

  it('flags an inline engine-fixed declaration outside the plane directory', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test('x', matrix({ engine: 'engine-fixed', formFactor: 'desktop' }), async () => {});
`;
    const [message] = await lintAtPath(code, SPEC);
    expect(message?.messageId).toBe('fixedOutsidePlane');
  });

  it('flags engine-fixed inside the plane directory once a second plane project exists', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
const M = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });
test.describe('x', M, () => {});
`;
    const [message, ...rest] = await lintWithPlanes(code, PLANE_SPEC, ['admin', 'admin-firefox']);
    expect(rest).toEqual([]);
    expect(message?.messageId).toBe('planeEngineNotFixed');
  });

  it('names the repair in the refusal, so the reader is not left with only the ban', async () => {
    // The developer who trips this did not write the spec it reddens, and there
    // are fourteen of them. A refusal that names no next step is the one that
    // gets disabled.
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test.describe('x', matrix({ engine: 'engine-fixed', formFactor: 'desktop' }), () => {});
`;
    const [refusal] = await lintWithPlanes(code, PLANE_SPEC, ['admin', 'admin-firefox']);
    const message = refusal?.message;
    expect(message).toContain('testDir');
    expect(message).toContain('playwright/projects.ts');
    expect(message).toContain('enclosing plane');
  });

  it('refuses the fixed arm when the rule is configured with no plane set at all', async () => {
    const linter = new ESLint({
      cwd: here,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        {
          files: ['**/*.spec.ts'],
          plugins: { 'browser-matrix': { rules: { 'matrix-declaration': matrixDeclaration } } },
          rules: { 'browser-matrix/matrix-declaration': 'error' },
        },
      ],
    });
    const [result] = await linter.lintText(
      `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test.describe('x', matrix({ engine: 'engine-fixed', formFactor: 'desktop' }), () => {});
`,
      { filePath: path.join(here, ...PLANE_SPEC.split('/')) }
    );
    if (result === undefined) throw new Error('ESLint returned no lint result');
    const message = result.messages.find((m) => m.ruleId === 'browser-matrix/matrix-declaration');
    expect(message?.messageId).toBe('planeEngineNotFixed');
    expect(message?.message).toContain('none');
  });

  it('reads the engine through a quoted key', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test.describe('x', matrix({ 'engine': 'engine-fixed', formFactor: 'desktop' }), () => {});
`;
    const [message] = await lintAtPath(code, SPEC);
    expect(message?.messageId).toBe('fixedOutsidePlane');
  });

  it('reads the engine past a spread and past the keys before it', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test.describe('x', matrix({ ...BASE, formFactor: 'desktop', engine: 'engine-fixed' }), () => {});
`;
    const [message] = await lintAtPath(code, SPEC);
    expect(message?.messageId).toBe('fixedOutsidePlane');
  });

  it('treats an engine it cannot read as declared rather than as the fixed arm', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test.describe('x', matrix({ engine: ENGINE, formFactor: 'desktop' }), () => {});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });

  it('treats a declaration passed as a reference rather than a literal as declared', async () => {
    const code = `import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
test.describe('x', matrix(DECLARATION), () => {});
`;
    expect(await lintAtPath(code, SPEC)).toHaveLength(0);
  });
});
