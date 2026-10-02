// Programmatic ESLint tests for the vendored no-inline-routing-options rule.
// Snippets are plain-JS-parseable so the default espree parser handles them;
// the rule is pure-AST (no type services needed).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../routing-options.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const adaptersDir = path.join(here, 'apps', 'api', 'src', 'slices', 'models', 'adapters');

function createLinter() {
  return new ESLint({ cwd: here, overrideConfigFile: true, overrideConfig: extensionConfig });
}

/**
 * @param {string} code
 * @param {string} file
 */
async function lint(code, file) {
  const [result] = await createLinter().lintText(code, { filePath: path.join(adaptersDir, file) });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'routing-options/no-inline-routing-options');
}

describe('no-inline-routing-options', () => {
  it('flags an inline provider routing literal in adapter code', async () => {
    const code =
      'const settings = { provider: { zdr: true, data_collection: "deny", allow_fallbacks: false } };\n' +
      'export const x = settings;\n';
    const findings = await lint(code, 'language-adapter.ts');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.messageId).toBe('inlineProvider');
  });

  it('flags an inline extraBody.provider routing literal in adapter code', async () => {
    const code =
      'const settings = { extraBody: { provider: { zdr: true }, transforms: [] } };\n' +
      'export const x = settings;\n';
    const findings = await lint(code, 'video-adapter.ts');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.messageId).toBe('inlineExtraBodyProvider');
  });

  it('allows spreading the shared routing helpers', async () => {
    const code =
      'import { languageRoutingOptions } from "@hushbox/shared";\n' +
      'const settings = { ...languageRoutingOptions() };\n' +
      'export const x = settings;\n';
    expect(await lint(code, 'language-adapter.ts')).toEqual([]);
  });

  it('does not flag a descriptor provider field (a plain string value)', async () => {
    const code =
      'const descriptor = { provider: "openai", id: "openai/gpt-4o" };\nexport const x = descriptor;\n';
    expect(await lint(code, 'language-adapter.ts')).toEqual([]);
  });

  it('flags an inline provider block whose zdr key is quoted', async () => {
    const code =
      'const settings = { provider: { "zdr": true, "data_collection": "deny" } };\n' +
      'export const x = settings;\n';
    const findings = await lint(code, 'language-adapter.ts');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.messageId).toBe('inlineProvider');
  });

  it('leaves a provider block assembled by spread alone — no key is written to judge', async () => {
    const code =
      'const settings = { provider: { ...sharedRouting } };\nexport const x = settings;\n';
    expect(await lint(code, 'language-adapter.ts')).toHaveLength(0);
  });

  it('exempts the helper module itself', async () => {
    const code =
      'export function mediaRoutingOptions() {\n' +
      '  return { extraBody: { provider: { zdr: true, data_collection: "deny", allow_fallbacks: false }, transforms: [] } };\n' +
      '}\n';
    const [result] = await createLinter().lintText(code, {
      filePath: path.join(adaptersDir, 'routing-options.ts'),
    });
    if (result === undefined) throw new Error('ESLint returned no lint result');
    expect(
      result.messages.filter((m) => m.ruleId === 'routing-options/no-inline-routing-options')
    ).toEqual([]);
  });

  it('exempts a test-setup module in adapter code', async () => {
    const code = 'const s = { provider: { zdr: true } };\nexport const x = s;\n';
    expect(await lint(code, 'language-adapter.setup.ts')).toEqual([]);
  });

  it('governs an adapter whose name merely carries a marker mid-way', async () => {
    const code = 'const s = { provider: { zdr: true } };\nexport const x = s;\n';
    expect(await lint(code, 'language-adapter.test.helper.ts')).toHaveLength(1);
  });

  it('ignores files outside the adapters scope', async () => {
    const code = 'const s = { provider: { zdr: true } };\nexport const x = s;\n';
    const [result] = await createLinter().lintText(code, {
      filePath: path.join(here, 'apps', 'web', 'src', 'lib', 'elsewhere.ts'),
    });
    if (result === undefined) throw new Error('ESLint returned no lint result');
    expect(
      result.messages.filter((m) => m.ruleId === 'routing-options/no-inline-routing-options')
    ).toEqual([]);
  });
});
