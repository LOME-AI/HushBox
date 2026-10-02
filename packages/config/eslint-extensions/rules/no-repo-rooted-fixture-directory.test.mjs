// Programmatic ESLint tests for the vendored no-repo-rooted-fixture-directory
// rule. Deliberately independent of the eslint-extensions loader (the same
// pattern the other rule suites use): the rule is applied directly to fixture
// code, so a result is valid regardless of loader behaviour.
//
// Every fixture is INLINE TEXT. A fixture TREE on disk under this directory is
// the exact defect the rule bans, and this file is a `*.test.mjs`, so the rule
// stands over its own suite.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import noRepoRootedFixtureDirectory from './no-repo-rooted-fixture-directory.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const RULE_ID = 'test-fixtures/no-repo-rooted-fixture-directory';

const TEST_FILE = 'scripts/sample.test.ts';

/** @type {import('eslint').Linter.Config[]} */
const ruleConfig = [
  {
    files: ['**/*.test.ts', '**/*.test.mjs', '**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      'test-fixtures': {
        meta: { name: 'test-fixtures', version: '1.0.0' },
        rules: { 'no-repo-rooted-fixture-directory': noRepoRootedFixtureDirectory },
      },
    },
    rules: { [RULE_ID]: 'error' },
  },
];

/**
 * @param {string} code
 * @param {string} filePath
 */
async function lintAtPath(code, filePath = TEST_FILE) {
  const linter = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: ruleConfig,
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

/** The module-directory preamble every ESM test in this repository writes. */
const HERE = `
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
`;

describe('no-repo-rooted-fixture-directory', () => {
  it('flags the shape that raced the architecture scan', async () => {
    // Verbatim in structure from the fixture root that produced the observed
    // DirectoryNotFoundError: a module-relative constant, created in a hook.
    const code = `${HERE}
const TEST_DIR = path.join(here, '__test-fixtures-typecheck__');
beforeEach(async () => { await mkdir(TEST_DIR, { recursive: true }); });
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags a module-relative path composed at the call itself', async () => {
    const code = `${HERE}
beforeAll(() => { mkdirSync(path.join(here, '__test-fixtures-x__'), { recursive: true }); });
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags the CommonJS spelling of the module directory', async () => {
    const code = `
const root = path.resolve(__dirname, '__test-fixtures-x__');
mkdirSync(root);
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags a path rooted at the working directory', async () => {
    const code = `mkdirSync(path.join(process.cwd(), '__test-fixtures-x__'));\n`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags a repository root derived by climbing out of the module directory', async () => {
    const code = `${HERE}
const repoRoot = path.resolve(here, '..', '..');
mkdirSync(path.join(repoRoot, 'apps', 'web', 'scratch'), { recursive: true });
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags a root a later assignment makes repository-rooted', async () => {
    // The binding is declared empty and filled in a hook, which is the shape a
    // scratch-directory refactor leaves behind and the one a rule reading only
    // initialisers would pass over.
    const code = `${HERE}
let root = '';
beforeEach(() => { root = path.join(here, '__test-fixtures-x__'); mkdirSync(root); });
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags the promise-namespace spelling of the same call', async () => {
    const code = `${HERE}
await fs.promises.mkdir(path.join(here, '__test-fixtures-x__'), { recursive: true });
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags a temporary directory template rooted in the repository', async () => {
    const code = `${HERE}
const root = await mkdtemp(path.join(here, 'run-'));
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('names the sanctioned helper, so the reader learns what to do instead', async () => {
    const code = `${HERE}
mkdirSync(path.join(here, '__test-fixtures-x__'));
`;
    const [message] = await lintAtPath(code);
    expect(message?.message).toContain('withScratchDirectory');
  });

  it('reports at the offending call', async () => {
    const code = `${HERE}
const TEST_DIR = path.join(here, '__test-fixtures-x__');
mkdirSync(TEST_DIR);
`;
    const [message] = await lintAtPath(code);
    // The `mkdirSync` line: four preamble lines, a blank, the constant, the call.
    expect(message?.line).toBe(7);
  });

  it('flags a path written as a template rather than composed', async () => {
    const code = `${HERE}
mkdirSync(\`\${here}/__test-fixtures-x__\`, { recursive: true });
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags a path written by concatenation', async () => {
    const code = `${HERE}
mkdirSync(here + '/__test-fixtures-x__', { recursive: true });
`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags a subdirectory of a root a hook awaited into place', async () => {
    // The awaited root is the common asynchronous spelling, and reaching the
    // call inside it is what tells a repository root from a temporary one.
    const code = `${HERE}
let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(here, 'run-')); });
it('x', () => { mkdirSync(path.join(root, 'sub'), { recursive: true }); });
`;
    expect(await lintAtPath(code)).toHaveLength(2);
  });

  it('leaves a template path alone when it writes out a hidden segment', async () => {
    const code = `${HERE}
mkdirSync(\`\${here}/.cache/fixtures\`, { recursive: true });
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('accepts a fixture tree staged under the OS temp directory', async () => {
    const code = `
const root = mkdtempSync(path.join(os.tmpdir(), 'sample-'));
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('accepts a directory nested inside an already-temporary root', async () => {
    const code = `
const root = mkdtempSync(path.join(tmpdir(), 'sample-'));
mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('accepts a directory built from a scratch directory the helper handed in', async () => {
    const code = `
it('x', () => withScratchDirectory('sample-', async (fixtureDir) => {
  await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
}));
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('leaves a module-relative path alone when nothing creates a directory at it', async () => {
    // The committed-fixture case: a tree that lives in the repository because
    // it is checked in, read by a test that creates and removes nothing.
    const code = `${HERE}
const fixture = path.join(here, '__test-fixtures-binary-strip__', 'media.ts');
const source = readFileSync(fixture, 'utf8');
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('leaves a module-relative directory alone when a test only removes it', async () => {
    const code = `${HERE}
afterEach(() => { rmSync(path.join(here, 'generated'), { recursive: true, force: true }); });
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('leaves a dot-directory alone, which no scanner glob descends into', async () => {
    const code = `mkdirSync(path.join(__dirname, '.auth'), { recursive: true });\n`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('leaves a dot-directory alone when the call reaches it through a binding', async () => {
    // The Playwright storage-state directory: persistent run output at a path
    // the setup project and the test projects must both name.
    const code = `${HERE}
const authDir = path.join(here, '.auth');
fs.mkdirSync(path.join(authDir, projectName), { recursive: true });
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('leaves an install directory alone, which every scanner excludes by name', async () => {
    const code = `${HERE}
await fs.mkdir(path.join(here, 'node_modules', '@fixture'), { recursive: true });
`;
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('stands over the whole repository, not one package tree', async () => {
    const code = `mkdirSync(path.join(__dirname, '__test-fixtures-x__'));\n`;
    expect(await lintAtPath(code, 'packages/ui/src/thing.test.ts')).toHaveLength(1);
  });

  it('stands over a rule suite written as an ES module', async () => {
    const code = `mkdirSync(path.join(__dirname, '__test-fixtures-x__'));\n`;
    expect(
      await lintAtPath(code, 'packages/config/eslint-extensions/rules/sample.test.mjs')
    ).toHaveLength(1);
  });

  it('leaves production code alone, which stages repository directories by design', async () => {
    const code = `mkdirSync(path.join(__dirname, 'generated'), { recursive: true });\n`;
    expect(await lintAtPath(code, 'scripts/generate-thing.ts')).toEqual([]);
  });
});
