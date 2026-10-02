// Programmatic ESLint tests for the vendored no-direct-env-branch rule.
// Deliberately independent of the eslint-extensions loader (the same pattern
// the other rule suites use): the rule is applied directly to fixture code, so
// a result is valid regardless of loader behaviour.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import noDirectEnvBranch from './no-direct-env-branch.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const RULE_ID = 'env-detection/no-direct-env-branch';

const APP_FILE = 'apps/web/src/components/chat/composer.tsx';

/** @type {import('eslint').Linter.Config[]} */
const ruleConfig = [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      'env-detection': {
        meta: { name: 'env-detection', version: '1.0.0' },
        rules: { 'no-direct-env-branch': noDirectEnvBranch },
      },
    },
    rules: { [RULE_ID]: 'error' },
  },
];

/** @param {string} code */
async function lintAtPath(code, filePath = APP_FILE) {
  const linter = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: ruleConfig,
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === RULE_ID);
}

describe('no-direct-env-branch', () => {
  it.each([
    ['boolean coercion', "export const x = !!import.meta.env['VITE_E2E'];\n"],
    ['negation', "export const x = !process.env['CI'];\n"],
    ['a Boolean() wrap', "export const x = Boolean(process.env['E2E']);\n"],
    ['an if test', "if (process.env['CI']) { doThing(); }\n"],
    ['a ternary test', "export const x = process.env['CI'] ? 1 : 2;\n"],
    ['a logical operand', "export const x = process.env['E2E'] || fallback;\n"],
    ['a value comparison', "export const x = process.env.NODE_ENV === 'production';\n"],
    ['dot access on import.meta.env', 'export const x = !import.meta.env.DEV;\n'],
  ])('flags %s', async (_label, code) => {
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  // The nearest legal shape: classify once through envUtils, branch on that.
  it('accepts branching on envUtils', async () => {
    expect(await lintAtPath('export const x = env.isE2E ? 1 : 2;\n')).toEqual([]);
  });

  it('accepts supplying the raw value to an EnvContext', async () => {
    expect(
      await lintAtPath('export const e = createEnvUtilities({ NODE_ENV: import.meta.env.MODE });\n')
    ).toEqual([]);
  });

  it('accepts a plain binding of the raw value', async () => {
    expect(
      await lintAtPath("const viteCI = import.meta.env['VITE_CI'];\nexport { viteCI };\n")
    ).toEqual([]);
  });

  // Presence plumbing, not classification: an EnvContext must omit absent keys
  // rather than carry them as undefined, so this comparison is how the value
  // reaches createEnvUtilities at all.
  it('accepts an undefined-presence guard around EnvContext assembly', async () => {
    expect(
      await lintAtPath(
        "export const e = { ...(process.env['CI'] === undefined ? {} : { CI: process.env['CI'] }) };\n"
      )
    ).toEqual([]);
  });

  it('accepts a check on some other environment variable', async () => {
    expect(await lintAtPath("export const x = !!process.env['HB_MINIO_API_PORT'];\n")).toEqual([]);
  });

  it('flags the read when the comparison puts it on the right', async () => {
    expect(
      await lintAtPath("export const x = 'production' === process.env.NODE_ENV;\n")
    ).toHaveLength(1);
  });

  it('accepts an undefined-presence guard written with the read on the right', async () => {
    expect(await lintAtPath('export const x = undefined === process.env.CI;\n')).toEqual([]);
  });

  it.each([
    ['a key computed at run time', 'if (process.env[key]) { go(); }\n'],
    ['a non-env member of process', 'if (process.argv.CI) { go(); }\n'],
    ['a bare identifier receiver', 'if (env.CI) { go(); }\n'],
    ['some other object named env', 'if (config.env.CI) { go(); }\n'],
    ['an env read off a call result', 'if (load().env.CI) { go(); }\n'],
  ])('accepts %s', async (_label, code) => {
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('accepts arithmetic on the value, which classifies nothing', async () => {
    expect(await lintAtPath("export const x = process.env.NODE_ENV + '!';\n")).toEqual([]);
  });

  it('accepts the read in a branch result rather than the branch test', async () => {
    expect(await lintAtPath('export const x = ready ? process.env.NODE_ENV : none;\n')).toEqual([]);
  });

  it('accepts a call whose callee is not Boolean', async () => {
    expect(await lintAtPath('export const x = String(process.env.NODE_ENV);\n')).toEqual([]);
  });

  it('accepts the read as a plain statement', async () => {
    expect(await lintAtPath('process.env.NODE_ENV;\n')).toEqual([]);
  });

  it('flags a while-loop test', async () => {
    expect(await lintAtPath("while (process.env['CI']) { spin(); }\n")).toHaveLength(1);
  });

  // The bundler's flags carry a reason of their own, and they point opposite
  // ways: a build that loads this repository's env files reports `DEV` true and
  // `PROD` false whatever mode its command named. Each refusal is asserted
  // against its own flag's values, because one sentence checked against a
  // single flag and fired for both states that flag's direction of both.
  it("states the development flag's own direction", async () => {
    const [message] = await lintAtPath('export const x = import.meta.env.DEV ? 1 : 2;\n');
    expect(message?.message).toMatch(/reports `DEV` true even when the command named production/);
    expect(message?.message).toMatch(/variable unset reports `DEV` false/);
  });

  it("states the production flag's own direction", async () => {
    const [message] = await lintAtPath('export const x = import.meta.env.PROD ? 1 : 2;\n');
    expect(message?.message).toMatch(/reports `PROD` false even when the command named production/);
    expect(message?.message).toMatch(/variable unset reports `PROD` true/);
  });

  it('gives each bundler flag a reason that is not the other with the key swapped', async () => {
    const [devMessage] = await lintAtPath('export const x = import.meta.env.DEV ? 1 : 2;\n');
    const [productionMessage] = await lintAtPath(
      'export const x = import.meta.env.PROD ? 1 : 2;\n'
    );
    expect(devMessage?.message.replaceAll('DEV', 'KEY')).not.toEqual(
      productionMessage?.message.replaceAll('PROD', 'KEY')
    );
  });

  it('gives a bundler flag a different reason than a classifier key', async () => {
    const [flag] = await lintAtPath('export const x = import.meta.env.DEV ? 1 : 2;\n');
    const [mode] = await lintAtPath("export const x = import.meta.env.MODE === 'production';\n");
    expect(flag?.message.replace('DEV', 'KEY')).not.toEqual(mode?.message.replace('MODE', 'KEY'));
  });

  // The advice closes on `MODE`, which this rule refuses as well, so it has to
  // carry the reader the rest of the way to the in-place disable the rule
  // sanctions. Following it must not land on a second refusal.
  it.each([
    ['the development flag', 'export const x = import.meta.env.DEV ? 1 : 2;\n'],
    ['the production flag', 'export const x = import.meta.env.PROD ? 1 : 2;\n'],
  ])('routes %s to the escape, not to a key it refuses too', async (_label, code) => {
    const [message] = await lintAtPath(code);
    expect(message?.message).toMatch(/`MODE` is refused/);
    expect(message?.message).toMatch(/eslint-disable-next-line/);
  });

  // The escape itself: a gate that must stay a build-time constant reads `MODE`
  // and disables this rule in place with that reason.
  it('is silenced by an in-place disable, which is the escape a strippable gate would take', async () => {
    expect(
      await lintAtPath(
        '/* eslint-disable-next-line env-detection/no-direct-env-branch -- build-time constant */\n' +
          "export const x = import.meta.env.MODE === 'development';\n"
      )
    ).toEqual([]);
  });

  it('is silent outside application source', async () => {
    expect(
      await lintAtPath("export const x = !!process.env['CI'];\n", 'scripts/ensure-stack-cli.ts')
    ).toEqual([]);
  });

  it('is silent in tests, which drive the harness through raw values', async () => {
    expect(
      await lintAtPath("export const x = !!process.env['CI'];\n", 'apps/web/src/lib/env.test.ts')
    ).toEqual([]);
  });

  it('is silent in a spec-marked module, which is a test file here too', async () => {
    expect(
      await lintAtPath("export const x = !!process.env['CI'];\n", 'apps/web/src/lib/env.spec.ts')
    ).toEqual([]);
  });
});
