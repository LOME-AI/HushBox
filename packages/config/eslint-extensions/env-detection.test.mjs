// Wiring tests for the env-detection extension over `.astro` templates.
//
// A branch asks `envUtils` (from `createEnvUtilities()`) which mode it is in;
// `NODE_ENV`, `CI` and `E2E` are read inside that classifier and nowhere else
// (`docs/CODE-RULES.md` §Environment Detection). A template is application
// source like any other, so the doctrine has to reach it.
//
// Separate from the rule's own suite, which drives the rule directly against
// TypeScript fixtures: what is under test here is the composed extension — the
// armed rule plus the file set it is armed over — because an Astro branch is
// only guarded if BOTH the glob matches and the rule's shape detection survives
// astro-eslint-parser's AST.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { astroConfig } from '../eslint.config.js';
import envDetectionConfig from './env-detection.config.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE_ID = 'env-detection/no-direct-env-branch';

// Application source, so the rule's own path self-scoping admits the fixture.
const ASTRO_FILE = 'apps/marketing/src/components/fixture.astro';

// Type-aware parsing is irrelevant to this purely syntactic rule, and turning it
// off keeps the fixtures tsconfig-free (the same treatment the a11y suite gives
// this config).
const tsconfigFreeAstroConfig = astroConfig.map((entry) =>
  entry.languageOptions?.['parserOptions']
    ? {
        ...entry,
        languageOptions: {
          ...entry.languageOptions,
          parserOptions: {
            ...entry.languageOptions['parserOptions'],
            project: false,
            projectService: false,
          },
        },
      }
    : entry
);

const astroLinter = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: true,
  overrideConfig: [...tsconfigFreeAstroConfig, ...envDetectionConfig],
});

/** @param {string} frontmatter */
async function envBranchMessages(frontmatter) {
  const [result] = await astroLinter.lintText(`---\n${frontmatter}---\n<div>{gate}</div>\n`, {
    filePath: path.join(REPO_ROOT, ...ASTRO_FILE.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

describe('env-detection over .astro templates', () => {
  // The shape an Astro dev-only island gate is written in: both operands are
  // classifying reads, so both are branches.
  it('flags a build-mode read used as a logical operand', async () => {
    const messages = await envBranchMessages(
      'const gate = import.meta.env.DEV && !import.meta.env.VITE_E2E;\n'
    );
    expect(messages.map((message) => message.ruleId)).toEqual([RULE_ID, RULE_ID]);
  });

  it('flags a value comparison in frontmatter', async () => {
    expect(
      await envBranchMessages("const gate = import.meta.env.MODE === 'production';\n")
    ).toHaveLength(1);
  });

  it('accepts branching on envUtils', async () => {
    expect(await envBranchMessages('const gate = env.isDevServer;\n')).toEqual([]);
  });

  it('accepts supplying a raw value to an EnvContext', async () => {
    expect(
      await envBranchMessages('const e = createEnvUtilities({ NODE_ENV: import.meta.env.MODE });\n')
    ).toEqual([]);
  });
});
