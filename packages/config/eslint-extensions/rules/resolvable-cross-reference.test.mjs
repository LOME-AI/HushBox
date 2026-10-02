// Programmatic ESLint tests for the vendored resolvable-cross-reference rule.
// Deliberately independent of the eslint-extensions loader (same pattern as the
// other rule suites): the extension config is applied directly to fixture code.
//
// Fixtures are INLINE. A fixture file carrying a deliberately broken reference
// would be reported by the very rule under test on every repo-wide lint run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import extensionConfig from '../cross-references.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

/**
 * Commit identity and signing are pinned so a scratch repository commits the
 * same way whatever the machine's own git configuration says.
 *
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const pinned = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@hushbox.ai'];
  const argv = [...pinned, '-c', 'commit.gpgsign=false', ...args];
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a prerequisite of the checkout this suite lints
  return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * `entries` is a flat-config array. Passing `extensionConfig` exercises the
 * registration exactly as the repository runs it; passing a hand-built entry
 * exercises a form the registration does not currently select.
 *
 * @param {import('eslint').Linter.Config[]} entries
 * @param {string} code
 */
async function lintWith(entries, code) {
  const [result] = await new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...entries,
    ],
  }).lintText(code, { filePath: path.join(here, 'sample.ts') });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'comments/resolvable-cross-reference');
}

const registration = extensionConfig[0];
if (registration?.plugins === undefined) throw new Error('the extension registers no plugin');
/** @type {NonNullable<import('eslint').Linter.Config['plugins']>} */
const registeredPlugins = registration.plugins;

/**
 * Both forms active, so a test states which form it is pinning.
 * @param {string[]} forms
 * @returns {import('eslint').Linter.Config[]}
 */
function withForms(forms) {
  return [
    {
      files: ['**/*.ts'],
      plugins: registeredPlugins,
      rules: { 'comments/resolvable-cross-reference': ['error', { forms }] },
    },
  ];
}

/** @param {string} code */
const lint = (code) => lintWith(withForms(['symbol', 'path']), code);

describe('resolvable-cross-reference: symbol form', () => {
  it('reports a {@link} naming something bound nowhere in the file', async () => {
    expect(await lint('/** See {@link nowhereBound}. */\nexport const a = 1;\n')).toHaveLength(1);
  });

  it('resolves a bare built-in that no file declares', async () => {
    expect(await lint('/** Throws {@link TypeError}. */\nexport const a = 1;\n')).toEqual([]);
  });

  it('leaves a {@link} whose target is a URL alone', async () => {
    expect(
      await lint(
        '/** Per {@link https://example.invalid/spec | the spec}. */\nexport const a = 1;\n'
      )
    ).toEqual([]);
  });
});

describe('resolvable-cross-reference: path form', () => {
  it('reports a backticked path that exists nowhere in the repository', async () => {
    expect(
      await lint('// Rationale: `packages/config/no-such-file.mjs`.\nexport const a = 1;\n')
    ).toHaveLength(1);
  });

  it('resolves a backticked path naming a real file', async () => {
    expect(
      await lint('// Rationale: `packages/config/eslint.config.js`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  it('resolves a backticked path naming a real directory', async () => {
    expect(
      await lint('// Rationale: `packages/config/eslint-extensions`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  it('resolves a directory cited with a trailing slash', async () => {
    expect(
      await lint('// Rationale: `packages/config/eslint-extensions/`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  // The directory is gitignored and present wherever this suite can run, since
  // the suite's own dependencies are installed into it. The precondition keeps
  // the assertion from passing on a machine where the path is simply absent.
  it('reports a path that exists on disk but that git does not track', async () => {
    expect(existsSync(path.join(here, '..', '..', 'node_modules'))).toBe(true);
    expect(
      await lint('// Installed at `packages/config/node_modules`.\nexport const a = 1;\n')
    ).toHaveLength(1);
  });

  // A reader holding the path on disk must be told why it does not count.
  it('names git tracking as the question when it reports a path', async () => {
    const [message] = await lint(
      '// Installed at `packages/config/node_modules`.\nexport const a = 1;\n'
    );
    expect(message?.message).toContain('git tracks nothing there');
  });

  it('ignores a backticked token carrying no forward slash that names no root file', async () => {
    expect(await lint('// Pass `noSuchSymbol` here.\nexport const a = 1;\n')).toEqual([]);
  });

  it('ignores a backticked token beginning with a dash', async () => {
    expect(await lint('// Pass `--reporter=x/y` here.\nexport const a = 1;\n')).toEqual([]);
  });
});

describe('resolvable-cross-reference: what the path form declines to read as a path', () => {
  it('ignores a token whose first segment names nothing at the repository root', async () => {
    expect(await lint('// Imported from `@hushbox/shared`.\nexport const a = 1;\n')).toEqual([]);
  });

  it('ignores a token with an empty first segment, which is how a route path reads', async () => {
    expect(await lint('// Served at `/api/chat`.\nexport const a = 1;\n')).toEqual([]);
  });

  it('ignores a token carrying a glob star', async () => {
    expect(await lint('// Matches `packages/no-such/**`.\nexport const a = 1;\n')).toEqual([]);
  });

  it('ignores a token carrying an angle-bracket placeholder', async () => {
    expect(
      await lint('// Written at `packages/<pkg>/no-such-file.ts`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  it('ignores a specifier relative to the citing file', async () => {
    expect(await lint('// Paired with `./no-such-neighbour`.\nexport const a = 1;\n')).toEqual([]);
  });

  it('ignores a specifier reaching above the citing file', async () => {
    expect(await lint('// Paired with `../no-such/neighbour.ts`.\nexport const a = 1;\n')).toEqual(
      []
    );
  });

  it('ignores a token rooted at a repository entry git does not track', async () => {
    expect(
      await lint('// Installed at `node_modules/@fixture/no-such-package`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  it('still reports a path whose first segment is a real repository entry', async () => {
    expect(
      await lint('// See `packages/config/no-such-file.mjs`.\nexport const a = 1;\n')
    ).toHaveLength(1);
  });
});

/**
 * The path form alone, registered from a given instance of the rule module.
 *
 * @param {import('eslint').Rule.RuleModule} rule
 * @returns {import('eslint').Linter.Config[]}
 */
function freshRuleEntries(rule) {
  return [
    {
      files: ['**/*.ts'],
      plugins: {
        comments: {
          meta: { name: 'comments', version: '1.0.0' },
          rules: { 'resolvable-cross-reference': rule },
        },
      },
      rules: { 'comments/resolvable-cross-reference': ['error', { forms: ['path'] }] },
    },
  ];
}

/**
 * A fresh module instance of the rule, so the git reads happen again under the
 * environment a test sets rather than reusing the answer the rest of the suite
 * already took through the shared instance.
 *
 * @param {string} code
 */
async function lintWithFreshRule(code) {
  vi.resetModules();
  /** @type {{ default: import('eslint').Rule.RuleModule }} */
  const { default: fresh } = await import('./resolvable-cross-reference.mjs');
  return lintWith(freshRuleEntries(fresh), code);
}

describe('resolvable-cross-reference: an unreadable repository', () => {
  const citation = '// See `packages/config/no-such-file.mjs`.\nexport const a = 1;\n';

  it('raises rather than falling silent when the tracked entries cannot be read', async () => {
    vi.stubEnv('GIT_DIR', path.join(here, 'no-such-git-directory'));
    try {
      await expect(lintWithFreshRule(citation)).rejects.toThrow(/git-tracked entries/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // No index file is not an empty repository: git lists nothing and exits
  // cleanly, so this is the unreadable case that a failed command does not catch.
  it('raises rather than falling silent when git lists no tracked entry at all', async () => {
    vi.stubEnv('GIT_INDEX_FILE', path.join(here, 'no-such-index'));
    try {
      await expect(lintWithFreshRule(citation)).rejects.toThrow(/git-tracked entries/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // The control for the assertions above: the same harness, the same fixture and
  // a readable repository yield a report rather than a raise, so the raise is
  // evidence about the unreadable repository and not about the harness.
  it('reports through that same fresh instance when the repository is readable', async () => {
    expect(await lintWithFreshRule(citation)).toHaveLength(1);
  });
});

describe('resolvable-cross-reference: a bare filename at the repository root', () => {
  /** @type {string} */
  let repo;

  /** @param {string[]} args */
  const inScratch = (args) => git(repo, args);

  /**
   * A repository whose history holds the cases the admission test separates:
   * a root file still tracked, one deleted, one renamed out of the root, and a
   * file that was only ever tracked below the root.
   */
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'resolvable-cross-reference-history-'));
    mkdirSync(path.join(repo, 'docs'));
    for (const file of ['kept.md', 'gone.md', 'moved.md', path.join('docs', 'nested.md')]) {
      writeFileSync(path.join(repo, file), 'fixture\n');
    }
    inScratch(['init', '-q']);
    inScratch(['add', '-A']);
    inScratch(['commit', '-q', '-m', 'fixture']);
    inScratch(['rm', '-q', 'gone.md']);
    inScratch(['mv', 'moved.md', 'docs/moved.md']);
    inScratch(['commit', '-q', '-m', 'fixture']);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** @param {string} code */
  const lintInScratch = async (code) => {
    vi.stubEnv('GIT_DIR', path.join(repo, '.git'));
    vi.stubEnv('GIT_WORK_TREE', repo);
    try {
      return await lintWithFreshRule(code);
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it('resolves a bare filename git tracks at the root today', async () => {
    expect(await lintInScratch('// See `kept.md`.\nexport const a = 1;\n')).toEqual([]);
  });

  it('reports a bare filename whose root file was deleted', async () => {
    expect(await lintInScratch('// See `gone.md`.\nexport const a = 1;\n')).toHaveLength(1);
  });

  it('reports a bare filename whose root file was renamed away from the root', async () => {
    expect(await lintInScratch('// See `moved.md`.\nexport const a = 1;\n')).toHaveLength(1);
  });

  it('reports a deleted root file cited with a line suffix', async () => {
    expect(await lintInScratch('// See `gone.md:12`.\nexport const a = 1;\n')).toHaveLength(1);
  });

  // The name is tracked, below the root, so silence here shows the root
  // restriction rather than a name that exists nowhere.
  it('ignores a bare filename git has tracked only below the root', async () => {
    expect(await lintInScratch('// See `nested.md`.\nexport const a = 1;\n')).toEqual([]);
  });

  // Both preconditions are git's own answer, so the silence is about the root
  // restriction and not about a name this repository happens to lack.
  it('ignores a bare filename this repository has only ever tracked below its root', async () => {
    expect(git(repoRoot, ['ls-files', '--', ':(glob)**/index.ts'])).not.toBe('');
    expect(git(repoRoot, ['log', 'HEAD', '--format=%h', '--', ':(top)index.ts'])).toBe('');
    expect(await lint('// Exported from `index.ts`.\nexport const a = 1;\n')).toEqual([]);
  });

  it('raises rather than falling silent when the history cannot be read', async () => {
    const unborn = mkdtempSync(path.join(tmpdir(), 'resolvable-cross-reference-unborn-'));
    try {
      writeFileSync(path.join(unborn, 'staged.md'), 'fixture\n');
      git(unborn, ['init', '-q']);
      git(unborn, ['add', 'staged.md']);
      vi.stubEnv('GIT_DIR', path.join(unborn, '.git'));
      vi.stubEnv('GIT_WORK_TREE', unborn);
      await expect(lintWithFreshRule('// See `staged.md`.\nexport const a = 1;\n')).rejects.toThrow(
        /history/
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(unborn, { recursive: true, force: true });
    }
  });
});

describe('resolvable-cross-reference: how often git is read', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('reads the history once for a lint process, however many files it lints', async () => {
    /** @type {unknown[]} */
    const argvs = [];
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => {
      /** @type {typeof import('node:child_process')} */
      const actual = await importOriginal();
      return {
        ...actual,
        execFileSync: new Proxy(actual.execFileSync, {
          apply(target, thisArgument, argumentArray) {
            argvs.push(argumentArray[1]);
            return Reflect.apply(target, thisArgument, argumentArray);
          },
        }),
      };
    });
    /** @type {{ default: import('eslint').Rule.RuleModule }} */
    const { default: fresh } = await import('./resolvable-cross-reference.mjs');
    const eslint = new ESLint({
      cwd: here,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        ...freshRuleEntries(fresh),
      ],
    });
    for (const name of ['first.ts', 'second.ts', 'third.ts']) {
      await eslint.lintText('// See `playwright.config.ts`.\nexport const a = 1;\n', {
        filePath: path.join(here, name),
      });
    }
    expect(argvs.filter((argv) => Array.isArray(argv) && argv.includes('log'))).toHaveLength(1);
  });
});

describe('resolvable-cross-reference: line suffixes and module-specifier spellings', () => {
  it('resolves a real file cited with a line suffix', async () => {
    expect(
      await lint('// See `packages/config/eslint.config.js:12`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  it('resolves a real file cited with a line-range suffix', async () => {
    expect(
      await lint('// See `packages/config/eslint.config.js:12-20`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  it('reports a missing file even when it is cited with a line suffix', async () => {
    expect(
      await lint('// See `packages/config/no-such-file.mjs:12`.\nexport const a = 1;\n')
    ).toHaveLength(1);
  });

  it('resolves a .js module specifier against the .ts file it names', async () => {
    expect(await lint('// Re-exported from `scripts/seed.js`.\nexport const a = 1;\n')).toEqual([]);
  });

  it('reports a .js specifier that names no TypeScript file either', async () => {
    expect(
      await lint('// Re-exported from `scripts/no-such-module.js`.\nexport const a = 1;\n')
    ).toHaveLength(1);
  });

  it('leaves a non-numeric colon suffix attached, so a dead file:symbol is reported', async () => {
    expect(
      await lint(
        '// The guard is `packages/config/no-such.ts:requireThing`.\nexport const a = 1;\n'
      )
    ).toHaveLength(1);
  });
});

describe('resolvable-cross-reference: what the rule refuses to do', () => {
  it('leaves a comment carrying no reference in either form alone', async () => {
    expect(
      await lint(
        '// Ordering matters here because the wallet row is locked first.\nexport const a = 1;\n'
      )
    ).toEqual([]);
  });

  it('leaves prose that mentions another file in ordinary words alone', async () => {
    expect(
      await lint(
        '// The rationale for this lives with the settlement transaction in the\n' +
          '// billing slice, which spells the lock order out in full.\n' +
          'export const a = 1;\n'
      )
    ).toEqual([]);
  });
});

describe('resolvable-cross-reference: symbol resolution', () => {
  it('resolves a name this file declares', async () => {
    expect(
      await lint('const target = 1;\n/** See {@link target}. */\nexport const a = target;\n')
    ).toEqual([]);
  });

  it('resolves a name this file imports', async () => {
    expect(
      await lint(
        "import { join } from 'node:path';\n/** See {@link join}. */\nexport const a = join;\n"
      )
    ).toEqual([]);
  });

  it('resolves a type this file declares', async () => {
    expect(
      await lint(
        'interface Shape {\n  a: number;\n}\n/** See {@link Shape}. */\nexport type B = Shape;\n'
      )
    ).toEqual([]);
  });

  it('resolves a name bound only in a nested scope', async () => {
    expect(
      await lint(
        'export function outer(): number {\n  const inner = 1;\n  /** See {@link inner}. */\n  return inner;\n}\n'
      )
    ).toEqual([]);
  });

  it('resolves a dotted reference on its leading segment', async () => {
    expect(
      await lint('const Shape = { a: 1 };\n/** See {@link Shape.a}. */\nexport const a = Shape;\n')
    ).toEqual([]);
  });

  it('resolves a member reference written with the hash separator on its leading segment', async () => {
    expect(
      await lint(
        'class Shape {\n  a = 1;\n}\n/** See {@link Shape#a}. */\nexport const a = Shape;\n'
      )
    ).toEqual([]);
  });

  it('reports a dotted reference whose leading segment is bound nowhere', async () => {
    expect(await lint('/** See {@link Absent.a}. */\nexport const a = 1;\n')).toHaveLength(1);
  });

  it('reports a reference written in a line comment, not only a block comment', async () => {
    expect(await lint('// See {@link nowhereBound}.\nexport const a = 1;\n')).toHaveLength(1);
  });

  it('reports every unresolved reference in a comment, not only the first', async () => {
    expect(
      await lint('/** {@link oneAbsent} and {@link twoAbsent}. */\nexport const a = 1;\n')
    ).toHaveLength(2);
  });

  it('reports at the position of the reference', async () => {
    const [message] = await lint(
      'const a = 1;\n/** See {@link nowhereBound}. */\nexport default a;\n'
    );
    expect(message?.line).toBe(2);
    expect(message?.column).toBe(9);
  });
});

describe('resolvable-cross-reference: form selection', () => {
  const bothBroken =
    '// See `packages/config/no-such-file.mjs` and {@link nowhereBound}.\nexport const a = 1;\n';

  it('checks only the symbol form when only the symbol form is selected', async () => {
    const reports = await lintWith(withForms(['symbol']), bothBroken);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('nowhereBound');
  });

  it('checks only the path form when only the path form is selected', async () => {
    const reports = await lintWith(withForms(['path']), bothBroken);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('no-such-file.mjs');
  });

  /** @type {import('eslint').Linter.Config[]} */
  const bare = [
    {
      files: ['**/*.ts'],
      plugins: registeredPlugins,
      rules: { 'comments/resolvable-cross-reference': 'error' },
    },
  ];

  it('checks only the symbol form when the registration passes no options at all', async () => {
    const reports = await lintWith(bare, bothBroken);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('nowhereBound');
  });

  it('cannot report a path when the registration omits the option', async () => {
    expect(
      await lintWith(bare, '// See `packages/config/no-such-file.mjs`.\nexport const a = 1;\n')
    ).toEqual([]);
  });

  it('registers both the symbol form and the path form', async () => {
    const reports = await lintWith(extensionConfig, bothBroken);
    const messages = reports.map((report) => report.message);
    expect(messages).toHaveLength(2);
    expect(messages.join('\n')).toContain('nowhereBound');
    expect(messages.join('\n')).toContain('no-such-file.mjs');
  });
});

describe('resolvable-cross-reference: declarations that bind no scope variable', () => {
  it('resolves a bare reference to a method the file declares on a class', async () => {
    expect(
      await lint(
        'export class Store {\n' +
          '  /** Paired with {@link readBytes}. */\n' +
          '  readUrl(): string {\n' +
          '    return this.readBytes();\n' +
          '  }\n' +
          '  readBytes(): string {\n' +
          "    return '';\n" +
          '  }\n' +
          '}\n'
      )
    ).toEqual([]);
  });

  it('reports a bare reference to a member no declaration in the file makes', async () => {
    expect(
      await lint(
        'export class Store {\n' +
          '  /** Paired with {@link readBytes}. */\n' +
          '  readUrl(): string {\n' +
          "    return '';\n" +
          '  }\n' +
          '}\n'
      )
    ).toHaveLength(1);
  });

  it('resolves a bare reference to a member the file declares on an interface', async () => {
    expect(
      await lint(
        'export interface Store {\n  readBytes(): string;\n}\n' +
          '/** See {@link readBytes}. */\nexport const a = 1;\n'
      )
    ).toEqual([]);
  });

  it('resolves a bare reference to a member the file declares on a type literal', async () => {
    expect(
      await lint(
        'export type Store = { readBytes: () => string };\n' +
          '/** See {@link readBytes}. */\nexport const a = 1;\n'
      )
    ).toEqual([]);
  });

  it('resolves a bare reference to an enum member, which the scope manager binds already', async () => {
    expect(
      await lint(
        'export enum Mode {\n  Replay,\n}\n/** See {@link Replay}. */\nexport const a = 1;\n'
      )
    ).toEqual([]);
  });

  it('resolves a name the file re-exports from another module', async () => {
    expect(
      await lint(
        "export { readBytes } from './reader';\n/** See {@link readBytes}. */\nexport const a = 1;\n"
      )
    ).toEqual([]);
  });

  it('resolves the local name of an aliased re-export', async () => {
    expect(
      await lint(
        "export { readBytes as read } from './reader';\n" +
          '/** See {@link readBytes}. */\nexport const a = 1;\n'
      )
    ).toEqual([]);
  });

  it('resolves the namespace name of a whole-module re-export', async () => {
    expect(
      await lint(
        "export * as reader from './reader';\n/** See {@link reader}. */\nexport const a = 1;\n"
      )
    ).toEqual([]);
  });

  it('reports a reference naming only a key of an object literal', async () => {
    expect(
      await lint('const row = { status: 1 };\n/** See {@link status}. */\nexport const a = row;\n')
    ).toHaveLength(1);
  });

  it('reports a reference naming only a key of a destructuring pattern', async () => {
    expect(
      await lint(
        'declare const row: Record<string, number>;\n' +
          'const { status: code } = row;\n' +
          '/** See {@link status}. */\nexport const a = code;\n'
      )
    ).toHaveLength(1);
  });
});
