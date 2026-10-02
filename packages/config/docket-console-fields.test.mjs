// Programmatic ESLint test for the docket console-field ban: `Input` and
// `Textarea` reached straight from `@hushbox/ui` read at 14px above 768px, so
// docket source must go through the `console-fields` wrapper that overrides the
// size. The ban is configuration — `docketConsoleFieldConfig`, exported here and
// composed by apps/docket — so the rule and its pin live in one package.
//
// The blocks under test come from the exported config itself, never from a copy
// here, and are replayed in the order apps/docket composes them (base config,
// reactConfig, then the console-field blocks) so a later block replaces an
// earlier one exactly as ESLint does in the app. Each block is reduced to that
// one rule because the whole config is type-aware — fixture text has no file on
// disk for the TypeScript project service to resolve, and the resulting parse
// error would suppress every rule.
//
// The inherited-ban assertions exist because flat config replaces (never
// merges) a rule key: a console-field block that stops spreading the shared
// frontend options silently un-bans gsap and the client SDKs for the files it
// scopes, with no failure anywhere else.
import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { createBaseConfig, docketConsoleFieldConfig, reactConfig } from './eslint.config.js';

// The console-field blocks scope by relative `src` globs, which resolve against
// the root the composing package lints from — here, this package's own root.
const lintRoot = import.meta.dirname;

const restrictedImportBlocks = [
  ...createBaseConfig(lintRoot),
  ...reactConfig,
  ...docketConsoleFieldConfig,
]
  .filter((entry) => entry?.rules?.['no-restricted-imports'] !== undefined)
  .map((entry) => ({
    // A global block carries no `files`; an empty `files` array is invalid.
    ...(entry.files ? { files: entry.files } : {}),
    rules: { 'no-restricted-imports': entry.rules['no-restricted-imports'] },
  }));

const linter = new ESLint({
  cwd: lintRoot,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    },
    ...restrictedImportBlocks,
  ],
});

const CONSOLE_COMPONENT = path.join('src', 'components', 'fixture.tsx');
const FIELD_WRAPPER = path.join('src', 'components', 'console-fields.tsx');

async function restrictedImportCount(code, relativePath) {
  const [result] = await linter.lintText(code, {
    filePath: path.join(lintRoot, relativePath),
  });
  return result.messages.filter((message) => message.ruleId === 'no-restricted-imports').length;
}

describe('docket console-field primitive ban', () => {
  it('flags an Input import from @hushbox/ui in console source', async () => {
    expect(
      await restrictedImportCount("import { Input } from '@hushbox/ui';\n", CONSOLE_COMPONENT)
    ).toBeGreaterThan(0);
  });

  it('flags a Textarea import from @hushbox/ui in console source', async () => {
    expect(
      await restrictedImportCount("import { Textarea } from '@hushbox/ui';\n", CONSOLE_COMPONENT)
    ).toBeGreaterThan(0);
  });

  it('leaves every other @hushbox/ui export importable', async () => {
    expect(
      await restrictedImportCount("import { Button } from '@hushbox/ui';\n", CONSOLE_COMPONENT)
    ).toBe(0);
  });

  it('exempts the console-fields wrapper', async () => {
    expect(
      await restrictedImportCount("import { Input } from '@hushbox/ui';\n", FIELD_WRAPPER)
    ).toBe(0);
  });

  it('keeps the inherited animation-library ban in console source', async () => {
    expect(
      await restrictedImportCount("import gsap from 'gsap';\n", CONSOLE_COMPONENT)
    ).toBeGreaterThan(0);
  });

  it('keeps the inherited client-SDK ban in console source', async () => {
    expect(
      await restrictedImportCount("import posthog from 'posthog-js';\n", CONSOLE_COMPONENT)
    ).toBeGreaterThan(0);
  });

  it('keeps the inherited animation-library ban in the exempted wrapper', async () => {
    expect(
      await restrictedImportCount("import gsap from 'gsap';\n", FIELD_WRAPPER)
    ).toBeGreaterThan(0);
  });

  // The animation ban rides `paths` and the client-SDK ban rides `patterns`, so
  // an exemption narrowed to `paths` alone keeps the assertion above green while
  // dropping a doctrine ban (capture is backend-only — `docs/ARCHITECTURE.md`
  // §Observability) for this one file. Only this assertion sees that.
  it('keeps the inherited client-SDK ban in the exempted wrapper', async () => {
    expect(
      await restrictedImportCount("import posthog from 'posthog-js';\n", FIELD_WRAPPER)
    ).toBeGreaterThan(0);
  });
});
