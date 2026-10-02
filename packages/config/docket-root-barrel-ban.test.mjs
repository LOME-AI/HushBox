// Programmatic ESLint test for the docket console's root-barrel ban: a *value*
// import of `@hushbox/docket` drags `node:fs`, `node:crypto` and `node:path`
// into the browser bundle, and nothing else can see it — the console's vitest
// suite runs on Node, so the break surfaces only once a browser loads the
// bundle.
//
// The ban is configuration living in apps/docket/eslint.config.js, so this test
// consumes that composed array directly rather than a copy, replaying its
// restricted-import blocks in composition order so a later block replaces an
// earlier one exactly as ESLint does in the app. Each block is reduced to those
// rules because the whole config is type-aware — fixture text has no file on
// disk for the TypeScript project service to resolve, and the resulting parse
// error would suppress every rule.
//
// The ban rides the `@typescript-eslint` rule key while the console-field ban
// rides the core one, and flat config replaces (never merges) a rule key: put
// both on the core key and whichever block loses the ordering race disappears
// with a fully green lint. That is why the console-field assertion is here too
// — it is the only thing that fails when a later edit trades one ban for the
// other.
import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import docketConsoleConfig from '../../apps/docket/eslint.config.js';

const RESTRICTED_IMPORT_RULES = [
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
];

// The blocks scope by relative `src` globs, which resolve against the root the
// composing package lints from — here, this package's own root.
const lintRoot = import.meta.dirname;

const restrictedImportBlocks = docketConsoleConfig
  .filter((entry) => RESTRICTED_IMPORT_RULES.some((rule) => entry?.rules?.[rule] !== undefined))
  .map((entry) => ({
    // A global block carries no `files`; an empty `files` array is invalid.
    ...(entry.files ? { files: entry.files } : {}),
    ...(entry.ignores ? { ignores: entry.ignores } : {}),
    rules: Object.fromEntries(
      RESTRICTED_IMPORT_RULES.filter((rule) => entry.rules[rule] !== undefined).map((rule) => [
        rule,
        entry.rules[rule],
      ])
    ),
  }));

const linter = new ESLint({
  cwd: lintRoot,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { '@typescript-eslint': tseslint.plugin },
    },
    ...restrictedImportBlocks,
  ],
});

const CLIENT_MODULE = path.join('src', 'components', 'fixture.tsx');
const SERVER_MODULE = path.join('src', 'server', 'fixture.ts');
const CLI_MODULE = path.join('src', 'cli', 'fixture.ts');

const ROOT_BARREL_VALUE_IMPORT = "import { loadFindings } from '@hushbox/docket';\n";
const ROOT_BARREL_TYPE_IMPORT = "import type { Finding } from '@hushbox/docket';\n";
const CONSOLE_FIELD_IMPORT = "import { Input } from '@hushbox/ui';\n";

async function restrictedImportCount(code, relativePath) {
  const [result] = await linter.lintText(code, {
    filePath: path.join(lintRoot, relativePath),
  });
  return result.messages.filter((message) => RESTRICTED_IMPORT_RULES.includes(message.ruleId))
    .length;
}

describe('docket console root-barrel import ban', () => {
  it('flags a value import of @hushbox/docket in console client source', async () => {
    expect(await restrictedImportCount(ROOT_BARREL_VALUE_IMPORT, CLIENT_MODULE)).toBeGreaterThan(0);
  });

  it('leaves a type-only import of @hushbox/docket importable in console client source', async () => {
    expect(await restrictedImportCount(ROOT_BARREL_TYPE_IMPORT, CLIENT_MODULE)).toBe(0);
  });

  it('leaves a value import of @hushbox/docket importable in the console server', async () => {
    expect(await restrictedImportCount(ROOT_BARREL_VALUE_IMPORT, SERVER_MODULE)).toBe(0);
  });

  it('leaves a value import of @hushbox/docket importable in the console CLI', async () => {
    expect(await restrictedImportCount(ROOT_BARREL_VALUE_IMPORT, CLI_MODULE)).toBe(0);
  });

  // The ordering half of the pin. Landing the root-barrel ban on the core rule
  // key after the console-field blocks keeps every assertion above green and
  // deletes this one, with `eslint .` over the whole console still exiting 0.
  it('keeps the console-field ban firing on console client source', async () => {
    expect(await restrictedImportCount(CONSOLE_FIELD_IMPORT, CLIENT_MODULE)).toBeGreaterThan(0);
  });
});
