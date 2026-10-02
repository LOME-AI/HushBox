// Programmatic ESLint tests for the vendored runtime-primitives rules.
// Deliberately independent of the eslint-extensions loader: the extension
// config is applied directly to fixture code, so these tests stay valid
// regardless of loader behavior.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig, { MUST_USE_RESULT_EXEMPT } from '../runtime-primitives.config.mjs';
import mustUseResult from './must-use-result.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__test-fixtures-runtime-primitives__');

// The exemption list is anchored with basePath at the repo root, so the
// assertions on it run against real repo paths; a fixture path could not
// exercise that anchoring.
const repoRoot = path.join(here, '..', '..', '..', '..');

/** @param {import('eslint').Linter.Config} config */
function mustUseResultSeverity(config) {
  const entry = config.rules?.['runtime-primitives/must-use-result'];
  if (entry === undefined) return 'unconfigured';
  return Array.isArray(entry) ? entry[0] : entry;
}

/** @param {string} relativePath */
async function configForRepoFile(relativePath) {
  const linter = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: extensionConfig,
  });
  return linter.calculateConfigForFile(path.join(repoRoot, relativePath));
}

// Fixture runs override only the rules' filename-scope options (the fixtures
// don't live under apps/api), keeping the extension's plugin wiring and
// severities intact.
function createFixtureLinter() {
  return new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      ...extensionConfig,
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixturesDir },
        },
        rules: {
          'runtime-primitives/must-use-result': [
            'error',
            { files: '__test-fixtures-runtime-primitives__' },
          ],
          'runtime-primitives/no-external-cockatiel': [
            'error',
            { allowedFiles: 'inside-resilience' },
          ],
        },
      },
    ],
  });
}

/** @param {string} file */
async function lintFixture(file) {
  const linter = createFixtureLinter();
  const [result] = await linter.lintFiles([path.join(fixturesDir, file)]);
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages;
}

describe('must-use-result', () => {
  it('flags every discarded Result and ResultAsync', async () => {
    const messages = await lintFixture('result-invalid.ts');
    const findings = messages.filter((m) => m.ruleId === 'runtime-primitives/must-use-result');
    // One per discard in invalidCases(): bare call, awaited call, dropped
    // ResultAsync, a .map() chain whose final Result is dropped, a
    // void-wrapped call (`void` is not the escape hatch — an intentionally
    // ignored Result takes an explicit assignment or .match()), a Result in
    // either position of a comma expression that itself dead-ends, and a
    // dropped union type whose Ok arm makes it must-use.
    expect(findings).toHaveLength(8);
    expect(findings.map((m) => m.line)).toEqual([35, 36, 37, 38, 39, 40, 41, 42]);
  });

  it('accepts Results that are assigned, returned, matched, or passed on', async () => {
    const messages = await lintFixture('result-valid.ts');
    expect(messages.filter((m) => m.ruleId === 'runtime-primitives/must-use-result')).toEqual([]);
  });

  it('ignores files outside its scope without needing type information', async () => {
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: extensionConfig,
    });
    const [result] = await linter.lintText('foo();\n', {
      filePath: path.join(fixturesDir, 'apps', 'web', 'src', 'lib', 'out-of-scope.ts'),
    });
    if (result === undefined) throw new Error('ESLint returned no lint result');
    expect(result.messages).toEqual([]);
  });

  it('covers the composition tree in its default scope', async () => {
    // The rule refuses to run untyped inside its own scope, so the throw is
    // what proves the path is covered — a path outside the scope returns
    // quietly, as the preceding test pins.
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: extensionConfig,
    });
    await expect(
      linter.lintText('doThing();\n', {
        filePath: path.join(fixturesDir, 'apps', 'api', 'src', 'composition', 'job-registry.ts'),
      })
    ).rejects.toThrow(/type-aware linting/);
  });

  it('covers test files inside its scope', async () => {
    // Same proof shape as the preceding test: the throw is what shows the
    // path is covered. A discarded Result in a test is a false green, so the
    // rule carries no test-file exemption of its own.
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: extensionConfig,
    });
    await expect(
      linter.lintText('doThing();\n', {
        filePath: path.join(
          fixturesDir,
          'apps',
          'api',
          'src',
          'composition',
          'job-registry.test.ts'
        ),
      })
    ).rejects.toThrow(/type-aware linting/);
  });

  it('fails loudly when an in-scope file lints without type services', async () => {
    // Espree-parsed run: parserServices has no program. A silent no-op here
    // would unguard the rule's whole scope, so it must throw instead.
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        {
          files: ['**/*.ts'],
          rules: {
            'runtime-primitives/must-use-result': ['error', { files: 'needs-types' }],
          },
        },
      ],
    });
    await expect(
      linter.lintText('doThing();\n', {
        filePath: path.join(fixturesDir, 'needs-types', 'file.ts'),
      })
    ).rejects.toThrow(/type-aware linting/);
  });

  it('treats a call with no enclosing statement as consumed', () => {
    // Defensive guard, unreachable through the ESLint API: the parser parents
    // every node up to Program, so the transparent-wrapper climb always ends
    // on a real ancestor before the chain runs out. Pin the guard by driving
    // the rule surface directly with a detached node.
    /** @type {unknown[]} */
    const reports = [];
    // Both stubs stand in for contracts they cannot satisfy: the rule reads
    // only the type checker and the node map off the source code, and a node
    // whose ancestor chain ends is one no parser produces — which is why the
    // guard is unreachable through the API in the first place.
    const context = /** @type {import('eslint').Rule.RuleContext} */ (
      /** @type {unknown} */ ({
        options: [{ files: 'detached' }],
        filename: '/virtual/detached/file.ts',
        sourceCode: {
          parserServices: {
            program: { getTypeChecker: () => ({}) },
            esTreeNodeToTSNodeMap: new Map(),
          },
        },
        report: (/** @type {unknown} */ descriptor) => reports.push(descriptor),
      })
    );
    const onCallExpression = mustUseResult.create(context).CallExpression;
    if (onCallExpression === undefined) throw new Error('the rule visits no call expression');
    const call = /** @type {Parameters<typeof onCallExpression>[0]} */ (
      /** @type {unknown} */ ({
        type: 'CallExpression',
        parent: { type: 'AwaitExpression', parent: null },
      })
    );
    onCallExpression(call);
    expect(reports).toEqual([]);
  });
});

describe('the must-use-result exemption list', () => {
  it('turns the rule off for each exempted file', async () => {
    for (const file of MUST_USE_RESULT_EXEMPT) {
      expect(mustUseResultSeverity(await configForRepoFile(file)), file).toBe(0);
    }
  });

  // ESLint does not complain when a `files` entry matches nothing, and it does
  // not complain when it matches a file with nothing left to exempt, so the
  // list rots invisibly: an entry outlives the violation that justified it and
  // silently keeps the rule off for whatever is written there next. Linting the
  // listed files with the exemption stripped makes each entry prove its own
  // necessity — the entry disappears from the list the moment its file starts
  // consuming every Result it drops, and a deleted or renamed file fails here
  // rather than lingering.
  it('keeps only entries whose file still violates the rule', async () => {
    const linter = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig.filter(
          (entry) => entry.rules?.['runtime-primitives/must-use-result'] !== 'off'
        ),
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { projectService: true, tsconfigRootDir: repoRoot },
          },
        },
      ],
    });
    const results = await linter.lintFiles(
      MUST_USE_RESULT_EXEMPT.map((file) => path.join(repoRoot, file))
    );

    expect(results).toHaveLength(MUST_USE_RESULT_EXEMPT.length);
    for (const result of results) {
      const violations = result.messages.filter(
        (m) => m.ruleId === 'runtime-primitives/must-use-result'
      );
      expect(violations.length, path.relative(repoRoot, result.filePath)).toBeGreaterThan(0);
    }
  });

  it('leaves the rule on for API test files outside the list', async () => {
    for (const file of [
      'apps/api/src/slices/conversations/domain/forks.test.ts',
      'apps/api/src/lib/rate-limit/consume.integration.test.ts',
      'apps/api/src/composition/dispatcher-job-registry.integration.test.ts',
    ]) {
      expect(mustUseResultSeverity(await configForRepoFile(file)), file).toBe(2);
    }
  });
});

describe('no-external-cockatiel', () => {
  it('flags every cockatiel import form outside the factory', async () => {
    // Static import, dynamic import, named re-export, and star re-export.
    const messages = await lintFixture('cockatiel-outside.ts');
    const findings = messages.filter(
      (m) => m.ruleId === 'runtime-primitives/no-external-cockatiel'
    );
    expect(findings).toHaveLength(4);
  });

  it('flags a subpath specifier in every position the bare specifier is flagged in', async () => {
    const messages = await lintFixture('cockatiel-subpath-outside.ts');
    const findings = messages.filter(
      (m) => m.ruleId === 'runtime-primitives/no-external-cockatiel'
    );
    expect(findings.map((m) => m.line)).toEqual([5, 7, 9, 12]);
  });

  it('allows cockatiel inside the policy factory', async () => {
    const messages = await lintFixture('inside-resilience/cockatiel-inside.ts');
    expect(messages).toEqual([]);
  });

  it('allows a subpath specifier inside the policy factory', async () => {
    const messages = await lintFixture('inside-resilience/cockatiel-subpath-inside.ts');
    expect(messages).toEqual([]);
  });

  it('ignores a package whose name merely begins with the library name', async () => {
    const messages = await lintFixture('cockatiel-near-miss-outside.ts');
    expect(messages.filter((m) => m.ruleId === 'runtime-primitives/no-external-cockatiel')).toEqual(
      []
    );
  });

  it('defaults its allowed path to apps/api/src/lib/resilience', async () => {
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        // must-use-result needs type services for in-scope files; this test
        // exercises only the cockatiel rule's default filename scoping.
        { files: ['**/*.ts'], rules: { 'runtime-primitives/must-use-result': 'off' } },
      ],
    });
    const code = "import { retry } from 'cockatiel';\nexport const x = retry;\n";
    const outside = path.join(fixturesDir, 'apps', 'api', 'src', 'slices', 'chat', 'turn.ts');
    const inside = path.join(fixturesDir, 'apps', 'api', 'src', 'lib', 'resilience', 'policies.ts');

    const [outsideResult] = await linter.lintText(code, { filePath: outside });
    const [insideResult] = await linter.lintText(code, { filePath: inside });
    if (outsideResult === undefined || insideResult === undefined) {
      throw new Error('ESLint returned no lint result');
    }

    expect(
      outsideResult.messages.filter((m) => m.ruleId === 'runtime-primitives/no-external-cockatiel')
    ).toHaveLength(1);
    expect(insideResult.messages).toEqual([]);
  });
});
