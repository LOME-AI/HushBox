import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** One fixture: source text linted as if it lived at `path` (relative to the package root). */
interface LintCase {
  id: string;
  path: string;
  code: string;
}

/** Paths inside the trees where `Math` transcendentals and `**` are banned. */
const PORTABLE_MATH_PATHS = [
  'engine/audio/probe.ts',
  'engine/analyze/probe.ts',
  'engine/dmath/probe.ts',
  '2026-09-probe/score.ts',
];

/** A path outside those trees, where only the package-wide bans apply. */
const PACKAGE_PATH = 'engine/visual/probe.ts';

const TRANSCENDENTALS = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'cbrt',
  'hypot',
];

const EXACT_MATH = [
  'sqrt',
  'abs',
  'floor',
  'ceil',
  'round',
  'trunc',
  'min',
  'max',
  'sign',
  'fround',
  'imul',
];

/** Package-wide bans: each API, a fixture using it, and the rule that must report it. */
const PACKAGE_BANS = [
  {
    api: 'Math.random',
    rule: 'no-restricted-properties',
    code: 'export const value = Math.random();',
  },
  { api: 'Date', rule: 'no-restricted-globals', code: 'export const value = new Date(0);' },
  { api: 'Date.now', rule: 'no-restricted-properties', code: 'export const value = Date.now();' },
  {
    api: 'performance.now',
    rule: 'no-restricted-properties',
    code: 'export const value = performance.now();',
  },
  {
    api: 'setTimeout',
    rule: 'no-restricted-globals',
    code: 'export const value = setTimeout(() => undefined, 1);',
  },
  {
    api: 'setInterval',
    rule: 'no-restricted-globals',
    code: 'export const value = setInterval(() => undefined, 1);',
  },
  {
    api: 'CSS animation key',
    rule: 'no-restricted-syntax',
    code: "export const style = { animation: 'spin 1s linear' };",
  },
  {
    api: 'CSS animationName key',
    rule: 'no-restricted-syntax',
    code: "export const style = { animationName: 'spin' };",
  },
  {
    api: "CSS 'animation-duration' key",
    rule: 'no-restricted-syntax',
    code: "export const style = { 'animation-duration': '1s' };",
  },
  {
    api: 'CSS transition key',
    rule: 'no-restricted-syntax',
    code: "export const style = { transition: 'opacity 1s' };",
  },
  {
    api: 'CSS transitionDuration key',
    rule: 'no-restricted-syntax',
    code: "export const style = { transitionDuration: '1s' };",
  },
  {
    api: "CSS 'transition-property' key",
    rule: 'no-restricted-syntax',
    code: "export const style = { 'transition-property': 'opacity' };",
  },
  {
    api: "random from 'remotion'",
    rule: 'no-restricted-syntax',
    code: "import { random } from 'remotion';\nexport const value = random('seed');",
  },
];

/** Bans the base config declares, which the films config must still carry at films paths. */
const BASE_BANS = [
  {
    api: 'a POSIX-only shell-out',
    rule: 'no-restricted-syntax',
    code: "import { execSync } from 'node:child_process';\nexecSync('rm -rf out');",
  },
  {
    api: 'a cast laundered through unknown',
    rule: 'no-restricted-syntax',
    code: 'export function launder(value: number): string {\n  return value as unknown as string;\n}',
  },
  {
    api: 'requestAnimationFrame',
    rule: 'no-restricted-globals',
    code: 'export const handle = requestAnimationFrame(() => undefined);',
  },
  {
    api: 'a gsap import',
    rule: 'no-restricted-imports',
    code: "import gsap from 'gsap';\nexport const timeline = gsap.timeline();",
  },
];

const CASES: LintCase[] = [
  ...PACKAGE_BANS.map(({ api, code }) => ({ id: `package:${api}`, path: PACKAGE_PATH, code })),
  ...PACKAGE_BANS.map(({ api, code }) => ({
    id: `composition:${api}`,
    path: '2026-09-probe/composition.tsx',
    code,
  })),
  ...TRANSCENDENTALS.flatMap((name) =>
    PORTABLE_MATH_PATHS.map((filePath) => ({
      id: `${filePath}:Math.${name}`,
      path: filePath,
      code: `export const value = Math.${name}(0.5, 0.25);`,
    }))
  ),
  ...PORTABLE_MATH_PATHS.flatMap((filePath) => [
    { id: `${filePath}:**`, path: filePath, code: 'export const value = 2 ** 0.5;' },
    {
      id: `${filePath}:**=`,
      path: filePath,
      code: 'let value = 2;\nvalue **= 0.5;\nexport { value };',
    },
    {
      id: `${filePath}:exact`,
      path: filePath,
      code: EXACT_MATH.map((name) => `export const ${name}Value = Math.${name}(0.5, 0.25);`).join(
        '\n'
      ),
    },
    {
      id: `${filePath}:Math.random`,
      path: filePath,
      code: 'export const value = Math.random();',
    },
  ]),
  { id: 'outside:Math.sin', path: PACKAGE_PATH, code: 'export const value = Math.sin(0.5);' },
  { id: 'outside:**', path: PACKAGE_PATH, code: 'export const value = 2 ** 0.5;' },
  {
    id: 'test-file:Math.sin',
    path: 'engine/audio/probe.test.ts',
    code: 'export const value = Math.sin(0.5);',
  },
  {
    id: 'test-file:**',
    path: 'engine/audio/probe.test.ts',
    code: 'export const value = 2 ** 0.5;',
  },
  {
    id: 'test-file:Math.random',
    path: 'engine/audio/probe.test.ts',
    code: 'export const value = Math.random();',
  },
  ...BASE_BANS.map(({ api, code }) => ({ id: `base:${api}`, path: PACKAGE_PATH, code })),
];

/** Rule ids reported, and any message no rule owns (a parse failure, or the file being ignored). */
interface LintOutcome {
  rules: string[];
  unattributed: string[];
}

/**
 * Each case's reported rule ids, from ESLint's own resolution of this package's
 * config at the case's path. The files are never written: `lintText` takes the
 * path as the source's location, and the project service is told to accept
 * exactly those paths, which it otherwise refuses for a file not on disk. That
 * override decides only where type information comes from; the rules, their
 * `files` and their `ignores` are the package config's own.
 *
 * Out of process because vite's SSR transform rewrites `import.meta.url` for a
 * module outside this project root, and the shared config it composes reads its
 * extension directory from that URL. A plain Node child loads the config exactly
 * as the lint gate does.
 */
async function lintCases(cases: readonly LintCase[]): Promise<Record<string, LintOutcome>> {
  const caseFiles = [...new Set(cases.map((lintCase) => lintCase.path))];
  const source = `
    const path = await import('node:path');
    const { ESLint } = await import('eslint');
    const root = ${JSON.stringify(PACKAGE_ROOT)};
    const cases = ${JSON.stringify(cases)};
    const eslint = new ESLint({
      cwd: root,
      overrideConfig: {
        languageOptions: {
          parserOptions: { projectService: { allowDefaultProject: ${JSON.stringify(caseFiles)} } },
        },
      },
    });
    const out = {};
    for (const lintCase of cases) {
      const filePath = path.join(root, ...lintCase.path.split('/'));
      const [result] = await eslint.lintText(lintCase.code, { filePath });
      out[lintCase.id] = {
        rules: result.messages.map((message) => message.ruleId).filter((id) => id !== null),
        unattributed: result.messages.filter((message) => message.ruleId === null).map((message) => message.message),
      };
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    { cwd: PACKAGE_ROOT, maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(stdout) as Record<string, LintOutcome>;
}

const outcomes = await lintCases(CASES);

function rulesFor(id: string): string[] {
  const outcome = outcomes[id];
  if (outcome === undefined) {
    throw new Error(`no lint outcome recorded for case ${id}`);
  }
  expect(outcome.unattributed).toEqual([]);
  return outcome.rules;
}

describe('package-wide determinism bans', () => {
  it.each(PACKAGE_BANS)('reports $api through $rule in engine modules', ({ api, rule }) => {
    expect(rulesFor(`package:${api}`)).toContain(rule);
  });

  it.each(PACKAGE_BANS)('reports $api through $rule in compositions', ({ api, rule }) => {
    expect(rulesFor(`composition:${api}`)).toContain(rule);
  });
});

describe('portable-maths bans', () => {
  const transcendentalCases = TRANSCENDENTALS.flatMap((name) =>
    PORTABLE_MATH_PATHS.map((filePath) => ({ name, filePath }))
  );

  it.each(transcendentalCases)('reports Math.$name in $filePath', ({ name, filePath }) => {
    expect(rulesFor(`${filePath}:Math.${name}`)).toContain('no-restricted-properties');
  });

  it.each(PORTABLE_MATH_PATHS)('reports the ** operator in %s', (filePath) => {
    expect(rulesFor(`${filePath}:**`)).toContain('no-restricted-syntax');
  });

  it.each(PORTABLE_MATH_PATHS)('reports the **= operator in %s', (filePath) => {
    expect(rulesFor(`${filePath}:**=`)).toContain('no-restricted-syntax');
  });

  it.each(PORTABLE_MATH_PATHS)('keeps the package-wide Math.random ban in %s', (filePath) => {
    expect(rulesFor(`${filePath}:Math.random`)).toContain('no-restricted-properties');
  });

  it.each(PORTABLE_MATH_PATHS)('allows the exact Math functions in %s', (filePath) => {
    expect(rulesFor(`${filePath}:exact`)).not.toContain('no-restricted-properties');
  });

  it('allows Math.sin outside the portable-maths trees', () => {
    expect(rulesFor('outside:Math.sin')).not.toContain('no-restricted-properties');
  });

  it('allows the ** operator outside the portable-maths trees', () => {
    expect(rulesFor('outside:**')).not.toContain('no-restricted-syntax');
  });

  it('allows Math.sin in a test file inside a portable-maths tree', () => {
    expect(rulesFor('test-file:Math.sin')).not.toContain('no-restricted-properties');
  });

  it('allows the ** operator in a test file inside a portable-maths tree', () => {
    expect(rulesFor('test-file:**')).not.toContain('no-restricted-syntax');
  });

  it('keeps the package-wide Math.random ban in a test file inside a portable-maths tree', () => {
    expect(rulesFor('test-file:Math.random')).toContain('no-restricted-properties');
  });
});

describe('base config bans at films paths', () => {
  it.each(BASE_BANS)('still reports $api through $rule', ({ api, rule }) => {
    expect(rulesFor(`base:${api}`)).toContain(rule);
  });
});
