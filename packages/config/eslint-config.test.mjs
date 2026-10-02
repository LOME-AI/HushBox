import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ESLint, Linter } from 'eslint';
import importPlugin from 'eslint-plugin-import';
import { parser as tseslintParser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import ownConfig, {
  createBaseConfig,
  e2eUniversalRestrictedSyntax,
  NO_CONSOLE_RULE,
  playwrightConfig,
  reactConfig,
  testConfig,
  typescriptImportGraphSettings,
} from './eslint.config.js';
import { loadEslintExtensions } from './eslint-extensions/load-extensions.mjs';
import { differingRuleKeys } from './rule-set-difference.mjs';
import { MODULE_EXTENSIONS } from './test-file-spellings.ts';
import rootConfig from '../../eslint.config.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

async function ignoresPath(relativePath) {
  const cwd = import.meta.dirname;
  const linter = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: createBaseConfig(cwd),
  });
  return linter.isPathIgnored(path.join(cwd, ...relativePath.split('/')));
}

async function rootConfigIgnores(relativePath) {
  const linter = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: rootConfig,
  });
  return linter.isPathIgnored(path.join(REPO_ROOT, ...relativePath.split('/')));
}

describe('default export', () => {
  it('provides a non-empty flat config so `eslint .` lints this package', () => {
    // Without a default export ESLint silently runs this package with an
    // empty config — the one package vendoring the custom rules would be the
    // only one outside the lint gate.
    expect(Array.isArray(ownConfig)).toBe(true);
    expect(ownConfig.length).toBeGreaterThan(0);
  });
});

describe('createBaseConfig config-file ignore', () => {
  // The ignore exempts build/tool configuration from the application rule set:
  // such a file is written against a third-party plugin API, not against our
  // conventions. What earns the exemption is the file's role, not its suffix,
  // and every package lints with `eslint .` from its own root — so a
  // base-path-relative glob says "package-root tool config" exactly, while
  // exempting by basename at any depth also swallowed the shared env registry.
  it.each(['vitest.config.ts', 'vitest.package.config.ts', 'drizzle.config.ts'])(
    'keeps the package-root tool config %s out of the lint gate',
    async (file) => {
      expect(await ignoresPath(file)).toBe(true);
    }
  );

  it('lints a src-resident module that merely ends in .config.ts', async () => {
    expect(await ignoresPath('src/env.config.ts')).toBe(false);
  });

  it('lints a src-resident config module nested below the source root', async () => {
    expect(await ignoresPath('src/lib/analytics.config.ts')).toBe(false);
  });

  it("keeps Astro's src-resident content config out of the lint gate", async () => {
    // The one tool config a framework mandates below the source root, so the
    // package-root glob cannot reach it.
    expect(await ignoresPath('src/content.config.ts')).toBe(true);
  });

  it('still ignores a dependency source tree that happens to match', async () => {
    expect(await ignoresPath('node_modules/pkg/src/a.config.ts')).toBe(true);
  });

  // No `.config.js` exemption exists: every one of them is a package-root
  // ESLint or Prettier config that satisfies the application rule set, and an
  // exemption is for a file that genuinely cannot. Their previous blanket
  // ignore is what kept this very config file outside the gate it defines.
  it.each(['eslint.config.js', 'prettier.config.js'])('lints %s', async (file) => {
    expect(await ignoresPath(file)).toBe(false);
  });

  // The repo-root config withdraws the exemption above for the root tree, and
  // that withdrawal is positional: flat-config ignores resolve in order, so its
  // un-ignore block placed before `createBaseConfig` is inert and these three
  // leave the gate with every rule still reporting clean.
  it.each(['playwright.config.ts', 'vitest.config.ts', 'vitest.projects.config.ts'])(
    'governs the repo-root tool config %s',
    async (file) => {
      expect(await rootConfigIgnores(file)).toBe(false);
    }
  );

  it('leaves a package-root tool config to the package that owns it', async () => {
    // The withdrawal reaches the root tree only; `apps/web/vite.config.ts` keeps
    // the exemption its own package grants it. The root config's subdirectory
    // ignore is what holds that line — without it the root rule set governs
    // package sources too.
    expect(await rootConfigIgnores('apps/web/vite.config.ts')).toBe(true);
  });
});

// The env registry is a table of per-mode values whose non-production entries
// are deliberately random-looking local-stack fixtures, so the entropy
// heuristic reports the file's whole reason for existing. The regex half — the
// half that recognises a real vendor credential — stays armed, because a
// production key pasted in beside the fixtures is the case worth catching.
//
// Both fixture strings below are assembled at run time rather than written as
// literals: a source literal of either shape is a finding in THIS file, which
// is scanned like any other.
const highEntropyFixture = `export const v = 'whsec_${Buffer.from('local-stack-fixture-value').toString('base64')}';\n`;
const vendorKeyFixture = `export const v = '${['sk', 'or', 'shaped-like-a-real-key'].join('-')}';\n`;

async function secretFindingsAt(code, ...pathSegments) {
  const linter = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslintParser } },
      ...createBaseConfig(REPO_ROOT),
    ],
  });
  // A real on-disk path: the type-aware parser resolves files through the
  // project service, so an invented one fails to parse instead of linting.
  const [result] = await linter.lintText(code, {
    filePath: path.join(REPO_ROOT, ...pathSegments),
  });
  return result.messages.filter((m) => m.ruleId === 'no-secrets/no-secrets');
}

const ENV_REGISTRY = ['packages', 'shared', 'src', 'env', 'env.config.ts'];
const PLAIN_SIBLING = ['packages', 'shared', 'src', 'constants.ts'];

describe('no-secrets over the shared env registry', () => {
  it('accepts a high-entropy local-stack fixture value', async () => {
    expect(await secretFindingsAt(highEntropyFixture, ...ENV_REGISTRY)).toEqual([]);
  });

  it('still reports a value shaped like a real vendor credential', async () => {
    expect(await secretFindingsAt(vendorKeyFixture, ...ENV_REGISTRY)).toHaveLength(1);
  });

  it('leaves the entropy heuristic armed for every other source file', async () => {
    expect(await secretFindingsAt(highEntropyFixture, ...PLAIN_SIBLING)).toHaveLength(1);
  });
});

// This config file states the rule set it defines as data, and the accessibility
// inline-style ban's AST selector enumerates every style property it covers —
// a long alternation the entropy heuristic reads as a secret. Nothing here is a
// credential, but the regex half stays armed so a real one pasted in still fails.
const OWN_CONFIG = ['packages', 'config', 'eslint.config.js'];
const SIBLING_CONFIG = ['packages', 'config', 'prettier.config.js'];

describe('no-secrets over this config file', () => {
  it('accepts a high-entropy string in the rule set it declares', async () => {
    expect(await secretFindingsAt(highEntropyFixture, ...OWN_CONFIG)).toEqual([]);
  });

  it('still reports a value shaped like a real vendor credential', async () => {
    expect(await secretFindingsAt(vendorKeyFixture, ...OWN_CONFIG)).toHaveLength(1);
  });

  it('leaves the entropy heuristic armed for a sibling config in the same package', async () => {
    expect(await secretFindingsAt(highEntropyFixture, ...SIBLING_CONFIG)).toHaveLength(1);
  });
});

async function rulesFor(configs, relativePath) {
  const cwd = import.meta.dirname;
  const linter = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: configs });
  const config = await linter.calculateConfigForFile(path.join(cwd, ...relativePath.split('/')));
  return config.rules;
}

describe('the test-code relaxations reach every test module the repository declares', () => {
  it('reaches a test-setup module, not only a colocated test', async () => {
    const configs = [...createBaseConfig(import.meta.dirname), ...testConfig];

    const setup = await rulesFor(configs, 'src/thing.setup.ts');
    const colocated = await rulesFor(configs, 'src/thing.test.ts');

    expect(setup['max-nested-callbacks']).toEqual(colocated['max-nested-callbacks']);
    expect(setup['sonarjs/no-nested-functions']?.[0]).toBe(0);
  });

  it('reaches a test module written in an extension other than ts/tsx', async () => {
    const configs = [...createBaseConfig(import.meta.dirname), ...testConfig];

    const mjs = await rulesFor(configs, 'thing.test.mjs');
    const ts = await rulesFor(configs, 'thing.test.ts');

    expect(mjs['max-nested-callbacks']).toEqual(ts['max-nested-callbacks']);
    expect(mjs['sonarjs/no-nested-functions']?.[0]).toBe(0);
  });

  it('releases a test-setup module from the frontend syntax bans a colocated test is released from', async () => {
    const configs = [...createBaseConfig(import.meta.dirname), ...reactConfig];

    const setup = await rulesFor(configs, 'src/thing.setup.tsx');
    const colocated = await rulesFor(configs, 'src/thing.test.tsx');

    expect(setup['no-restricted-syntax']).toEqual(colocated['no-restricted-syntax']);
  });
});

/**
 * The two markers whose resolved rule sets this repository intends to be equal.
 *
 * Not every marker the shared declaration names: a rule scoped to the `spec`
 * marker alone ships today, so equality across all of them is not a law. It is
 * a law about the pair no config sets out to tell apart.
 */
const MARKER_LAW_PAIR = ['test', 'setup'];

/** The rule keys on which a `setup` module and its `test` sibling disagree. */
async function markerDifferences(configs, anchor, extension) {
  const [test, setup] = await Promise.all(
    MARKER_LAW_PAIR.map((marker) => rulesFor(configs, `${anchor}.${marker}.${extension}`))
  );
  return differingRuleKeys(test, setup);
}

/**
 * Where a probe is taken. A tree's rule set is not uniform across it, so one
 * anchor answers for neither place: a block scoped to the source root reaches a
 * module under `src` and not one beside the manifest, and a block scoped to the
 * package root reaches the reverse.
 */
const PROBE_ANCHORS = ['thing', 'src/thing'];

const RULE_SET_DIFFERENCE = pathToFileURL(
  path.join(import.meta.dirname, 'rule-set-difference.mjs')
).href;

/**
 * Every tree's answer to the marker question, resolved in one child process.
 *
 * A child for the reason {@link resolvedRule} records: resolving a foreign
 * tree's config in this process loads a second copy of every vendored rule
 * module through a specifier rooted outside this package, and the
 * barely-executed copy lands in this package's coverage report and drops it
 * under the gate. One child rather than one per probe because a config is
 * resolved once per tree here and once per invocation by the CLI, which is the
 * difference between seconds and minutes.
 *
 * The probe paths name no file on disk, deliberately: the claim is about how a
 * path resolves, so requiring a fixture would tie the reach of the gate to
 * which fixtures somebody remembered to create.
 *
 * Answered once and handed to every reader: the walk and the resolutions are
 * the same for all of them, and a second child costs what the first one did.
 */
let markerSymmetryAnswer;
async function markerSymmetryProbes() {
  markerSymmetryAnswer ??= resolveMarkerSymmetry();
  return markerSymmetryAnswer;
}

async function resolveMarkerSymmetry() {
  const source = `
    const { readdirSync } = await import('node:fs');
    const path = (await import('node:path')).default;
    const { pathToFileURL } = await import('node:url');
    const { ESLint } = await import('eslint');
    const { differingRuleKeys } = await import(${JSON.stringify(RULE_SET_DIFFERENCE)});

    const root = ${JSON.stringify(REPO_ROOT)};
    const markers = ${JSON.stringify(MARKER_LAW_PAIR)};
    const extensions = ${JSON.stringify(MODULE_EXTENSIONS)};
    const anchors = ${JSON.stringify(PROBE_ANCHORS)};

    const configured = (prefix, depth) => {
      const entries = readdirSync(path.join(root, prefix), { withFileTypes: true }).filter(
        (entry) => !/^(node_modules$|[.])/.test(entry.name)
      );
      const here = entries.some((entry) => entry.name === 'eslint.config.js') ? [prefix] : [];
      const below =
        depth === 0
          ? []
          : entries
              .filter((entry) => entry.isDirectory())
              .flatMap((entry) => configured(prefix + entry.name + '/', depth - 1));
      return [...here, ...below];
    };

    const trees = configured('', 2);
    const probes = [];
    for (const tree of trees) {
      const cwd = path.join(root, tree);
      const config = await import(pathToFileURL(path.join(cwd, 'eslint.config.js')).href);
      const linter = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: config.default });
      for (const anchor of anchors) {
        for (const extension of extensions) {
          const resolved = [];
          for (const marker of markers) {
            resolved.push(
              await linter.calculateConfigForFile(
                path.join(cwd, anchor + '.' + marker + '.' + extension)
              )
            );
          }
          probes.push({
            tree,
            anchor,
            extension,
            governed: resolved.map(Boolean),
            differing: resolved.every(Boolean)
              ? differingRuleKeys(resolved[0].rules, resolved[1].rules)
              : [],
          });
        }
      }
    }
    process.stdout.write(JSON.stringify({ trees, probes }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

// The spelling this package's test-code relaxation carried before it was collapsed
// onto the shared declaration: it named one marker, and not every extension a module
// can be written in. Written out rather than derived from the declaration on
// purpose — it stands for "narrower than the declaration", so a fixture that tracked
// the declaration would stop being narrower the moment the declaration moved.
const ONE_MARKER_SPELLING = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'];

describe('marker symmetry, control', () => {
  it('reports the rules a one-marker spelling of the relaxation releases', async () => {
    const narrowed = testConfig.map((block) =>
      block.files ? { ...block, files: ONE_MARKER_SPELLING } : block
    );
    const configs = [...createBaseConfig(import.meta.dirname), ...narrowed];

    expect(await markerDifferences(configs, 'src/thing', 'ts')).toContain('max-nested-callbacks');
  });
});

// The marker dimension of the shared test-module declaration, gated: a module whose
// name carries the `setup` marker resolves to the rule set its `test` sibling
// resolves to, at the same path and the same extension. A hand-spelling that
// recognises one marker and not the other withholds a release the shared declaration
// grants, and it does so silently, because a module that keeps a rule it should have
// been let off simply reports more findings than it owes.
//
// REACH, as a derivation rather than a roster, because a roster is false at the next
// package added: the trees are every directory carrying an `eslint.config.js` no more
// than two levels below the repository root, found by walking rather than by listing;
// the extensions are every extension the shared declaration names; the paths are the
// tree root and one source directory below it. A config nested deeper than the walk's
// bound is unmeasured, and widening the bound is not the repair: a config outside every
// workspace can reach this package by a relative specifier that resolves above the
// repository root, so importing it throws rather than yielding a config to probe.
//
// WHAT IT CANNOT SEE, and between them these are most of the question:
//
// - A release a rule performs on itself. Most readers of the shared declaration are
//   vendored rules that filter on the filename they are handed, and a resolved config
//   reports such a rule as on for both markers: the release happens while linting,
//   after the config this reads is settled. One of those drifting narrow passes here.
//
// - A narrowing symmetric across the markers. A spelling that drops a whole extension
//   family, or a whole path scope, drops it for both markers at once, and two equally
//   un-relaxed configs agree. What is measured is marker symmetry, never reach.
//
// - The extension dimension, which is not comparable at this seam at all: the
//   type-aware TypeScript layer gives a `.ts` module a large rule set a `.mjs` module
//   never has, for reasons that have nothing to do with the test-module question. Only
//   same-extension pairs are compared; that dimension is pinned by instance instead,
//   in `the test-code relaxations reach every test module the repository declares`.
describe('marker symmetry across every tree its walk derives', () => {
  it('resolves a setup module exactly as it resolves its test sibling', async () => {
    const { probes } = await markerSymmetryProbes();

    const released = probes
      .filter((probe) => probe.governed[0] !== probe.governed[1] || probe.differing.length > 0)
      .map(
        (probe) =>
          `${probe.tree || '<repo root>'} ${probe.anchor}.*.${probe.extension}: ` +
          (probe.governed[0] === probe.governed[1]
            ? probe.differing.join(', ')
            : 'one marker is governed and the other is ignored')
      );

    expect(released).toEqual([]);
  });

  // Without this, `resolves a setup module exactly as it resolves its test sibling` is
  // satisfiable by a walk that finds no tree and a probe set every entry of which is
  // ignored on both sides, and the law would read as held while nothing measured it.
  it('measures every tree its walk derived', async () => {
    const { trees, probes } = await markerSymmetryProbes();
    const measured = new Set(
      probes.filter((probe) => probe.governed.every(Boolean)).map((probe) => probe.tree)
    );

    expect(trees.length).toBeGreaterThan(0);
    expect(trees.filter((tree) => !measured.has(tree))).toEqual([]);
  });
});

describe('createBaseConfig extension slot', () => {
  it('appends every eslint-extensions entry at the end of the config', async () => {
    const extensions = await loadEslintExtensions(new URL('eslint-extensions/', import.meta.url));
    const config = createBaseConfig(import.meta.dirname);

    expect(extensions.length).toBeGreaterThan(0);
    // Module-cache identity: the same entry objects must be present, in order,
    // as the tail of the composed config so extension rules win flat-config
    // rule-key replacement for the files they scope.
    expect(config.slice(-extensions.length)).toEqual(extensions);
  });
});

const ESLINT_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve('eslint/package.json')),
  'bin',
  'eslint.js'
);

/**
 * Resolve the whole effective config for one path out of the eslint config
 * shipped by `tree`, by running the real ESLint CLI in that directory.
 *
 * Out of process on purpose, and not for speed: resolving that config in-process
 * loads a second copy of every vendored `eslint-extensions/rules/*.mjs` through a
 * specifier rooted outside this package, and the barely-executed copy lands in this
 * package's own coverage report and drops it under the gate. A child process also
 * happens to be the most faithful reading available — it is the binary the lint gate
 * itself runs, against the config file as shipped rather than a copy re-declared here.
 */
async function printedConfig(tree, relativePath) {
  const treeDir = path.join(REPO_ROOT, ...tree.split('/'));
  // `--print-config` answers for a path that does not exist just as readily as for
  // one that does, so without this a renamed fixture leaves the assertions below
  // green while measuring a file that is gone.
  expect(
    existsSync(path.join(treeDir, relativePath)),
    `fixture ${tree}/${relativePath} does not exist`
  ).toBe(true);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [ESLINT_BIN, '--print-config', relativePath],
    { cwd: treeDir }
  );
  return JSON.parse(stdout);
}

async function resolvedRule(tree, relativePath, ruleId) {
  const { rules } = await printedConfig(tree, relativePath);
  return rules[ruleId];
}

async function noConsoleRule(tree, relativePath) {
  return resolvedRule(tree, relativePath, 'no-console');
}

// The base policy's own options object, not a copy of it: this asserts that a
// withdrawing tree lands back on the repo-wide console policy, which a re-typed
// literal here would stop saying the moment that policy changed. Only the severity
// is restated, because `--print-config` reports it numerically.
const GOVERNED = [2, NO_CONSOLE_RULE[1]];

const CONSOLE_TREES = ['scripts', 'ops', 'apps/sandbox'];

/**
 * The entry-point exemptions each tree hands back after withdrawing
 * scriptsConfig's blanket one: every `files` entry of every `no-console: 'off'`
 * block that follows the tree's own withdrawal.
 *
 * Loaded in a child process for the reason {@link noConsoleRule} gives — a
 * second copy of the vendored rule modules reached through a foreign specifier
 * lands in this package's coverage report and drops it under the gate.
 */
async function entryPointExemptions() {
  const source = `
    const { pathToFileURL } = await import('node:url');
    const root = pathToFileURL(${JSON.stringify(REPO_ROOT)} + '/');
    const out = {};
    for (const tree of ${JSON.stringify(CONSOLE_TREES)}) {
      const url = new URL(tree + '/eslint.config.js', root);
      const blocks = (await import(url.href)).default;
      const withdrawn = blocks.findLastIndex((b) => Array.isArray(b?.rules?.['no-console']));
      out[tree] = blocks
        .slice(withdrawn + 1)
        .filter((b) => b?.rules?.['no-console'] === 'off')
        .flatMap((b) => b.files ?? []);
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    { cwd: REPO_ROOT }
  );
  return JSON.parse(stdout);
}

/**
 * Every workspace `package.json`, found by walk rather than by listing the workspace
 * globs, so a new one is searched without this file being edited. Two levels reaches
 * `ops/package.json` and every `apps/<name>/package.json` alike, and stops above the
 * fixture trees that carry a `package.json` of their own.
 */
function packageJsonPaths(prefix, depth) {
  const entries = readdirSync(path.join(REPO_ROOT, prefix), { withFileTypes: true }).filter(
    (entry) => !/^(node_modules$|\.)/.test(entry.name)
  );
  const here = entries
    .filter((entry) => entry.name === 'package.json')
    .map((entry) => prefix + entry.name);
  const below =
    depth === 0
      ? []
      : entries
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) => packageJsonPaths(`${prefix}${entry.name}/`, depth - 1));
  return [...here, ...below];
}

/**
 * Every checked-in line that can name a file as something to run: package.json
 * script bodies, workflow run steps, husky hook lines, playwright's reporter list,
 * and the ops dispatch manifest.
 *
 * Comment lines are dropped, and that is the whole difficulty rather than tidiness:
 * both `playwright.config.ts` and `ci.yml` name a `scripts/lib/` helper in prose to
 * explain themselves, so a plain substring search over these files would certify a
 * genuine helper as a program.
 */
function executionSiteLines() {
  const workflowDir = '.github/workflows';
  const files = [
    ...packageJsonPaths('', 2),
    ...readdirSync(path.join(REPO_ROOT, workflowDir)).map((name) => `${workflowDir}/${name}`),
    ...readdirSync(path.join(REPO_ROOT, '.husky'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `.husky/${entry.name}`),
    'playwright.config.ts',
    'ops/manifest.yml',
  ];

  return files.flatMap((file) =>
    readFileSync(path.join(REPO_ROOT, ...file.split('/')), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line))
      .map((line) => ({ file, line }))
  );
}

const EXECUTION_SITE_LINES = executionSiteLines();

/** A path spelled as a whole trailing run of segments, so `../../scripts/seed.ts` counts. */
function namedOn(lines, relativePath) {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9._/-])(?:[A-Za-z0-9._-]+/)*${relativePath.replaceAll(
      /[$()*+.?[\\\]^{|}]/g,
      String.raw`\$&`
    )}(?![A-Za-z0-9._-])`
  );
  return lines.some(({ line }) => pattern.test(line));
}

// A file carrying this guard declares itself something to run. That it carries one is
// all this matches — whether the file's only print sits inside it is a separate and
// stronger property, which not every guarded file exempted below has; each exemption
// block's own comment is where that distinction is recorded.
const MAIN_MODULE_GUARD = /isMainModule\(import\.meta\.url\)/;

/**
 * Whether `tree/relativePath` is a program a human runs rather than a helper another
 * file imports — the question the exemption lists answer file by file, on either of
 * the two kinds of evidence they accept: a checked-in caller that executes the file,
 * or a top-level main-module guard by which it declares itself one.
 *
 * A tree's own `package.json` and dispatch manifest spell their targets relative to
 * the tree (`tsx src/build.ts`), so the tree-relative spelling counts only there.
 */
function isProgram(tree, relativePath) {
  if (namedOn(EXECUTION_SITE_LINES, `${tree}/${relativePath}`)) return true;
  const ownSites = EXECUTION_SITE_LINES.filter(
    ({ file }) => file === `${tree}/package.json` || file === `${tree}/manifest.yml`
  );
  if (namedOn(ownSites, relativePath)) return true;
  return MAIN_MODULE_GUARD.test(
    readFileSync(path.join(REPO_ROOT, ...tree.split('/'), ...relativePath.split('/')), 'utf8')
  );
}

// Two ways a hand-written exemption list stops meaning what it says, neither of
// which any assertion above would notice: an entry outlives the file it names,
// and an entry grows a wildcard that quietly re-exempts files nobody classified.
describe('no-console entry-point exemptions', () => {
  it('name existing files, by exact path in every tree', async () => {
    const exemptions = await entryPointExemptions();
    expect(Object.keys(exemptions)).toEqual(CONSOLE_TREES);
    for (const [tree, paths] of Object.entries(exemptions)) {
      expect(paths.length, `${tree} hands back no entry point`).toBeGreaterThan(0);
      for (const relativePath of paths) {
        expect(relativePath, `${tree} exempts a pattern, not a path`).not.toMatch(/[*?[\]]/);
        expect(
          existsSync(path.join(REPO_ROOT, ...tree.split('/'), relativePath)),
          `${tree}/${relativePath} is exempted but does not exist`
        ).toBe(true);
      }
    }
  });

  it('rest on evidence that the exempted file is a program, in every tree', async () => {
    const exemptions = await entryPointExemptions();
    for (const [tree, paths] of Object.entries(exemptions)) {
      for (const relativePath of paths) {
        expect(
          isProgram(tree, relativePath),
          `${tree}/${relativePath} is exempted as an entry point, but no checked-in ` +
            `caller executes it and it carries no main-module guard`
        ).toBe(true);
      }
    }
  });

  // Without this the check above is satisfiable by a predicate that answers yes to
  // everything, and the premise would read as pinned while nothing held it.
  it('reject a helper nothing executes, added by exact path', () => {
    expect(isProgram('scripts', 'lib/cli/is-main.ts')).toBe(false);
  });
});

// CODE-RULES allows `log`/`info`/`debug` only in CLI entry points. The three trees
// below compose `scriptsConfig`, which hands the exemption to every `.ts` file they
// hold; each withdraws it and names its entry points back one exact path at a time.
// No directory tells the two roles apart in any of them — `scripts/lib/` holds
// helpers while `ops/lib/` holds entry points — which is why the exemption is a path
// list rather than a glob. Every fixture below names a file that really exists, so a
// rename surfaces as a failure rather than as a check that quietly measures nothing.
//
// Each tree is pinned in both directions, deliberately: a narrowing that swallowed
// the entry points too would satisfy the helper case on its own, and one that stopped
// short of the helpers would satisfy the entry-point case on its own.
describe('no-console over the scripts tree', () => {
  it('governs a helper under scripts/lib, warn and error still allowed', async () => {
    expect(await noConsoleRule('scripts', 'lib/mobile/mobile-image.ts')).toEqual(GOVERNED);
  });

  it('governs a helper at the scripts root', async () => {
    expect(await noConsoleRule('scripts', 'storage-state-init-script.ts')).toEqual(GOVERNED);
  });

  it('leaves a CLI entry point exempt', async () => {
    const entryPointRule = await noConsoleRule('scripts', 'seed.ts');
    expect(entryPointRule[0]).toBe(0);
  });

  it('governs a helper under scripts/readme, warn and error still allowed', async () => {
    expect(await noConsoleRule('scripts', 'readme/cache.ts')).toEqual(GOVERNED);
  });

  it('leaves a readme CLI entry point exempt', async () => {
    const entryPointRule = await noConsoleRule('scripts', 'readme/generate-readme.ts');
    expect(entryPointRule[0]).toBe(0);
  });

  it('governs a helper under scripts/linear, warn and error still allowed', async () => {
    expect(await noConsoleRule('scripts', 'linear/validate.ts')).toEqual(GOVERNED);
  });

  it('leaves a linear CLI entry point exempt', async () => {
    const entryPointRule = await noConsoleRule('scripts', 'linear/board.ts');
    expect(entryPointRule[0]).toBe(0);
  });

  // The governed fixture under `scripts/skills` is a test rather than a helper because
  // the generator there has no helper beside it to name.
  it('governs the skills generator test, warn and error still allowed', async () => {
    expect(await noConsoleRule('scripts', 'skills/generate-skills.test.ts')).toEqual(GOVERNED);
  });

  it('leaves a skills CLI entry point exempt', async () => {
    const entryPointRule = await noConsoleRule('scripts', 'skills/generate-skills.ts');
    expect(entryPointRule[0]).toBe(0);
  });
});

describe('no-console over the ops tree', () => {
  it('governs a helper under ops/lib, warn and error still allowed', async () => {
    expect(await noConsoleRule('ops', 'lib/run-cli.ts')).toEqual(GOVERNED);
  });

  it('leaves a CLI entry point exempt', async () => {
    const entryPointRule = await noConsoleRule('ops', 'lib/generate-dispatch-options.ts');
    expect(entryPointRule[0]).toBe(0);
  });
});

describe('no-console over the sandbox tree', () => {
  // The renderer bootstrap is the one governed fixture that also ships: it is built
  // into the public origin's bundle, where a stray print is a disclosure surface
  // rather than noise.
  it('governs the shipped renderer bootstrap, warn and error still allowed', async () => {
    expect(await noConsoleRule('apps/sandbox', 'src/render/bootstrap.ts')).toEqual(GOVERNED);
  });

  it('leaves a build entry point exempt', async () => {
    const entryPointRule = await noConsoleRule('apps/sandbox', 'src/build.ts');
    expect(entryPointRule[0]).toBe(0);
  });
});

// `explicit-function-return-type` is turned on once for the whole repo and stood
// down in exactly two places. Widen the path-scoped override and it silently
// un-governs real files; move the language-scoped block above the block that
// turns the rule on and the disable resolves to nothing, re-governing every
// JavaScript file in the repo. So both are pinned in both directions: where the
// stand-down applies, and on a neighbour it must not reach.
//
// The whole rule entry is pinned, never severity alone. Flat config keeps the
// options object from the block that turned the rule on even where a later block
// restates severity by itself, so every fixture below resolves to `[0, {…}]` or
// `[2, {…}]` — and an `allowedNames` list added to the enabling block resolves at
// all of them without moving a single severity. That option is the escape hatch
// this override exists instead of: a name list exempts any future function whose
// name happens to match, where a path list exempts the files someone chose.
const RETURN_TYPE_RULE = '@typescript-eslint/explicit-function-return-type';

// Written out here rather than read back from the config: an expected value
// derived from the block under test cannot contradict it, and the claim is that
// the option set is these three and nothing else.
const RETURN_TYPE_OPTIONS = {
  allowExpressions: true,
  allowTypedFunctionExpressions: true,
  allowHigherOrderFunctions: true,
};
const RETURN_TYPE_OFF = [0, RETURN_TYPE_OPTIONS];
const RETURN_TYPE_ON = [2, RETURN_TYPE_OPTIONS];

async function returnTypeRule(tree, relativePath) {
  return resolvedRule(tree, relativePath, RETURN_TYPE_RULE);
}

async function returnTypeRules(tree, relativePaths) {
  const readings = await Promise.all(
    relativePaths.map(async (relativePath) => [
      relativePath,
      await returnTypeRule(tree, relativePath),
    ])
  );
  return Object.fromEntries(readings);
}

function allResolvingTo(relativePaths, entry) {
  return Object.fromEntries(relativePaths.map((relativePath) => [relativePath, entry]));
}

// Every path the override names, so deleting one of them reddens here instead of
// quietly re-governing the file it was written for. The one glob entry is stood
// for by a single slice's route manifest; the other four are exact paths.
const INFERRED_RETURN_TYPE_FILES = [
  'src/slices/account/routes.ts',
  'src/app.ts',
  'src/whole-app/app.test.ts',
  'src/middleware/edge-middleware.integration.test.ts',
  'src/slices/account/adapters/stores.ts',
];

// For every entry the override names, a file it does not reach that sits in the
// same directory, shares its name prefix, or both — plus `src/index.ts`, which
// only a widening taking the whole `src` tree reaches. A slice-tree widening is
// the case worth naming, because it reaches nothing at `src/` root: the two
// `slices/account` fixtures are all that stands between it and a green suite.
// What this arm cannot do is exhaust the widenings — a glob reaching none of
// these files passes green, measured with `apps/api/src/lib/**`.
const OUTSIDE_RETURN_TYPE_OVERRIDE = [
  'src/index.ts',
  'src/whole-app/app-mount.integration.test.ts',
  'src/middleware/csrf.ts',
  'src/slices/account/routes.test.ts',
  'src/slices/account/adapters/stores.integration.test.ts',
];

// The scope is the file extension and nothing else. Three blocks in the config
// name this rule: the repo-wide one that turns it on, this one, and the
// `inferred-return-types` override, which reaches only `apps/api` — so what the
// two arms below differ in is this block and nothing else. It also names
// `**/*.cjs`, which no file in the repo carries, so that third extension is
// unmeasured here.
const JAVASCRIPT_RETURN_TYPE_FILES = ['eslint.config.js', 'behaviour-ledger.mjs'];

describe('explicit-function-return-type over the apps/api override', () => {
  it('is off on every path the override names', async () => {
    const entries = await returnTypeRules('apps/api', INFERRED_RETURN_TYPE_FILES);
    expect(entries).toEqual(allResolvingTo(INFERRED_RETURN_TYPE_FILES, RETURN_TYPE_OFF));
  });

  it('stays on for the sibling modules the override does not name', async () => {
    const entries = await returnTypeRules('apps/api', OUTSIDE_RETURN_TYPE_OVERRIDE);
    expect(entries).toEqual(allResolvingTo(OUTSIDE_RETURN_TYPE_OVERRIDE, RETURN_TYPE_ON));
  });
});

describe('explicit-function-return-type over JavaScript files', () => {
  it('is off for a JavaScript module of each extension the repo carries', async () => {
    const entries = await returnTypeRules('packages/config', JAVASCRIPT_RETURN_TYPE_FILES);
    expect(entries).toEqual(allResolvingTo(JAVASCRIPT_RETURN_TYPE_FILES, RETURN_TYPE_OFF));
  });

  it('stays on for a TypeScript sibling in the same package', async () => {
    expect(await returnTypeRule('packages/config', 'arch/lib/paths.ts')).toEqual(RETURN_TYPE_ON);
  });
});

// Tests the shared e2e selector array directly (the same list spread into both
// the helper-scoped and spec-scoped `no-restricted-syntax` blocks) so the rule
// is exercised without dragging the type-aware playwright plugins into the
// fixture lint.
async function idempotencyKeyFindings(code, filePath = 'e2e/helpers/sample.ts') {
  const linter = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        rules: { 'no-restricted-syntax': ['error', ...e2eUniversalRestrictedSyntax] },
      },
    ],
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(import.meta.dirname, filePath),
  });
  return result.messages.filter(
    (m) => m.ruleId === 'no-restricted-syntax' && /Idempotency-Key/.test(m.message)
  );
}

describe('e2e hand-rolled Idempotency-Key ban', () => {
  // The single sanctioned way to attach an Idempotency-Key to a mutating e2e
  // request is the idempotent-request helper; hand-rolling a fresh key at a call
  // site is how the billing-token test drifted (a sibling call omitted it and
  // 400'd). This rule pins the class so the header discipline stays in one place.
  const handRolled =
    "async function f(request) { await request.post('/x', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: {} }); }";

  it('flags a hand-rolled crypto.randomUUID Idempotency-Key in a helper', async () => {
    expect(await idempotencyKeyFindings(handRolled)).toHaveLength(1);
  });

  it('flags a hand-rolled crypto.randomUUID Idempotency-Key in a spec', async () => {
    expect(await idempotencyKeyFindings(handRolled, 'e2e/x.spec.ts')).toHaveLength(1);
  });

  it('allows an intentional fixed-string Idempotency-Key (idempotent-replay tests)', async () => {
    const fixedKey =
      "async function f(request) { await request.post('/x', { headers: { 'Idempotency-Key': 'replay-key' }, data: {} }); }";
    expect(await idempotencyKeyFindings(fixedKey)).toHaveLength(0);
  });

  it('allows the idempotent-request wrapper call', async () => {
    const viaWrapper =
      "async function f(request) { await idempotentPost(request, '/x', { data: {} }); }";
    expect(await idempotencyKeyFindings(viaWrapper)).toHaveLength(0);
  });
});

async function headerBagMessages(code, filePath = 'e2e/helpers/sample.ts') {
  const linter = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        rules: { 'no-restricted-syntax': ['error', ...e2eUniversalRestrictedSyntax] },
      },
    ],
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(import.meta.dirname, filePath),
  });
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax' && /extraHTTPHeaders/.test(m.message))
    .map((m) => m.message);
}

describe('e2e own-header-bag ban', () => {
  // Playwright copies a project's extraHTTPHeaders into newContext options only
  // when the key is absent, so a context passing any bag of its own replaces the
  // project's whole bag and silently drops the per-project caller identity —
  // the context still works and the suite still passes.
  const ownBag =
    "async function f(request) { await request.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '1.2.3.4' } }); }";

  it('flags a context built with its own literal header bag', async () => {
    expect(await headerBagMessages(ownBag)).toHaveLength(1);
  });

  it('flags a context built with its own header bag in a spec', async () => {
    expect(await headerBagMessages(ownBag, 'e2e/x.spec.ts')).toHaveLength(1);
  });

  it('flags a header bag laundered through a variable', async () => {
    const laundered =
      'async function f(request, bag) { await request.newContext({ extraHTTPHeaders: bag }); }';
    expect(await headerBagMessages(laundered)).toHaveLength(1);
  });

  it('allows a bag merged over the project bag by the shared helper', async () => {
    const merged =
      'async function f(request, header, token) { await request.newContext({ extraHTTPHeaders: withProjectHeaders({ [header]: token }) }); }';
    expect(await headerBagMessages(merged)).toHaveLength(0);
  });

  // The shared helper reads the project bag rather than declaring one, so it
  // needs no exemption: the ban has no allowlist to drift.
  it('allows the shared helper reading the running project bag', async () => {
    const helper =
      'function withProjectHeaders(headers) { return { ...test.info().project.use.extraHTTPHeaders, ...headers }; }';
    expect(await headerBagMessages(helper)).toHaveLength(0);
  });

  it('names the merge helper a developer should use instead', async () => {
    const [message] = await headerBagMessages(ownBag);
    expect(message).toContain('withProjectHeaders');
  });

  // The two below pin consequences of the matcher, not promises of the ban. The
  // sanctioned value is recognised by CALLEE NAME, which decides both: an alias
  // is refused though it merges correctly, and a same-named local function is
  // accepted though it merges nothing. Swapping the name match for import
  // resolution reverses both — with these here that swap turns a test red and its
  // author chooses deliberately; without them it lands silently.
  it('refuses the wrapper imported under an alias, because the match is on the name', async () => {
    const aliased =
      "import { withProjectHeaders as merge } from './project-headers';\nconst c = { extraHTTPHeaders: merge({ 'x-h': '1' }) };";
    expect(await headerBagMessages(aliased)).toHaveLength(1);
  });

  it('accepts a local function that merely shares the wrapper name', async () => {
    const shadowed =
      "function withProjectHeaders(headers) { return headers; }\nconst c = { extraHTTPHeaders: withProjectHeaders({ 'x-h': '1' }) };";
    expect(await headerBagMessages(shadowed)).toHaveLength(0);
  });

  // A context's bag is an object or an identifier naming one, never a function,
  // so a function-valued property is only ever a `test.extend` declaration
  // overriding the OPTION — the mechanism that supplies the identity to every
  // context a test builds. Matching it would fire on the one declaration the ban
  // exists to protect.
  it('accepts the fixture declaration that overrides the extraHTTPHeaders option', async () => {
    const fixtureDeclaration =
      'const test = base.extend({ extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => { await use(extraHTTPHeaders); } });';
    expect(await headerBagMessages(fixtureDeclaration)).toHaveLength(0);
  });
});

async function pageContextPathMessages(code, filePath = 'e2e/helpers/sample.ts') {
  const linter = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        rules: { 'no-restricted-syntax': ['error', ...e2eUniversalRestrictedSyntax] },
      },
    ],
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(import.meta.dirname, filePath),
  });
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax' && /API-scoped/.test(m.message))
    .map((m) => m.message);
}

describe('e2e page-derived context with a relative API path', () => {
  // A page-derived context inherits the page's baseURL — the preview server,
  // which answers an unknown path with the SPA's index.html and a 200 — so a
  // leading-slash path on one never reaches the API and every assertion behind
  // it reads HTML. The retry ban beside it does not cover this: wrapping in
  // withRequestRetry satisfies retry and leaves the base URL wrong, which is
  // exactly how two such call sites passed review.
  const wrappedRelative =
    "async function f(page) { await withRequestRetry(page.request).get('/conversations'); }";

  it('flags a wrapped page context taking a leading-slash string path', async () => {
    expect(await pageContextPathMessages(wrappedRelative)).toHaveLength(1);
  });

  it('flags a wrapped page context taking a leading-slash template path', async () => {
    const code =
      'async function f(testDavePage, id) { await withRequestRetry(testDavePage.request).get(`/conversations/${id}/forks`); }';
    expect(await pageContextPathMessages(code)).toHaveLength(1);
  });

  it('flags a raw page context taking a leading-slash path', async () => {
    const code = "async function f(page) { await page.request.get('/conversations'); }";
    expect(await pageContextPathMessages(code)).toHaveLength(1);
  });

  it('flags a wrapped page context in a spec as well as a helper', async () => {
    expect(await pageContextPathMessages(wrappedRelative, 'e2e/x.spec.ts')).toHaveLength(1);
  });

  // The same defect reaches the wire through the idempotent-request helpers,
  // where the context is an argument rather than the callee's object. Both
  // shapes below are what the two fixed call sites looked like before the fix.
  it('flags a wrapped page context handed to an idempotent helper with a leading-slash path', async () => {
    const code =
      "async function f(page, data) { await idempotentPost(withRequestRetry(page.request), '/conversations/abc/shares', { data }); }";
    expect(await pageContextPathMessages(code)).toHaveLength(1);
  });

  it('flags a raw page context handed to an idempotent helper with a leading-slash path', async () => {
    const code =
      "async function f(page, data) { await idempotentPost(page.request, '/conversations/abc/shares', { data }); }";
    expect(await pageContextPathMessages(code)).toHaveLength(1);
  });

  it('flags a wrapped page context handed to an idempotent helper with a leading-slash template path', async () => {
    const code =
      'async function f(testDavePage, id, data) { await idempotentPost(withRequestRetry(testDavePage.request), `/conversations/${id}/shares`, { data }); }';
    expect(await pageContextPathMessages(code)).toHaveLength(1);
  });

  it('allows a wrapped page context taking an absolute API URL', async () => {
    const code =
      'async function f(page) { await withRequestRetry(page.request).get(`${apiUrl}/conversations`); }';
    expect(await pageContextPathMessages(code)).toHaveLength(0);
  });

  it('allows a page context passed to a helper that builds the URL', async () => {
    const code =
      'async function f(page, chargeBody) { await idempotentPost(page.request, `${apiUrl}/billing/payments`, { data: chargeBody }); }';
    expect(await pageContextPathMessages(code)).toHaveLength(0);
  });

  it('allows an API-scoped fixture handed to an idempotent helper with a relative path', async () => {
    const code =
      'async function f(authenticatedRequest, id, data) { await idempotentPost(authenticatedRequest, `/conversations/${id}/forks`, { data }); }';
    expect(await pageContextPathMessages(code)).toHaveLength(0);
  });

  it('allows a page context handed to a helper constructor', async () => {
    const code = 'function f(page) { return new BudgetHelper(page.request); }';
    expect(await pageContextPathMessages(code)).toHaveLength(0);
  });

  it('allows an API-scoped fixture taking a relative path', async () => {
    const code = "async function f(request) { await request.get('/conversations'); }";
    expect(await pageContextPathMessages(code)).toHaveLength(0);
  });

  it('allows a context scoped to the API base and wrapped in place', async () => {
    const code =
      "async function f(request) { await withRequestRetry(await request.newContext({ baseURL: apiUrl })).get('/dev/admin-token'); }";
    expect(await pageContextPathMessages(code)).toHaveLength(0);
  });

  it('names the API-scoped context a developer should build instead', async () => {
    const [message] = await pageContextPathMessages(wrappedRelative);
    expect(message).toContain('newContext');
    expect(message).toContain('e2e/helpers/banner.ts');
  });
});

async function serialDescribeMessages(code) {
  const linter = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        rules: { 'no-restricted-syntax': ['error', ...e2eUniversalRestrictedSyntax] },
      },
    ],
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(import.meta.dirname, 'e2e/x.spec.ts'),
  });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

describe('serial-describe ban message', () => {
  // The only way to serialize a suite is a per-site eslint-disable comment
  // carrying a shared-state justification. A message naming any other mechanism
  // sends the author looking for something that does not exist.
  it.each(["test.describe.configure({ mode: 'serial' });", 'describe.serial("x", () => {});'])(
    'names the suppression-comment mechanism for %s',
    async (code) => {
      const [message] = await serialDescribeMessages(code);
      expect(message).toContain('eslint-disable-next-line no-restricted-syntax');
    }
  );
});

describe('e2e serial-suite ban', () => {
  // Playwright spells a serial suite `test.describe.serial(...)`, a member
  // expression whose object is the member expression `test.describe` — never a
  // bare `describe` identifier, which its type surface does not declare.
  it.each(['test.describe.serial("g", () => {});', "test.describe.configure({ mode: 'serial' });"])(
    'catches %s',
    async (code) => {
      expect(await serialDescribeMessages(code)).toHaveLength(1);
    }
  );

  it('leaves a parallel suite alone', async () => {
    expect(await serialDescribeMessages('test.describe("g", () => {});')).toHaveLength(0);
  });
});

/**
 * The shipped E2E config entries that carry one rule, with every other rule
 * dropped: `playwrightConfig` also turns on type-aware rules, and a fixture
 * linted from text has no TypeScript program for those to read.
 */
const shippedE2eRule = (ruleId) =>
  playwrightConfig.flatMap((entry) =>
    entry.rules?.[ruleId] === undefined
      ? []
      : [{ ...entry, rules: { [ruleId]: entry.rules[ruleId] } }]
  );

async function specMessages(ruleId, code) {
  const linter = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: shippedE2eRule(ruleId),
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(import.meta.dirname, 'e2e/x.spec.ts'),
  });
  return result.messages.filter((m) => m.ruleId === ruleId).map((m) => m.message);
}

describe('e2e spec cleanup-hook ban', () => {
  // Playwright declares the cleanup hooks as methods on its `test` object, so
  // the spelling a spec can actually write is `test.afterEach(...)`.
  it.each([
    'test.afterEach(async () => {});',
    'test.afterAll(async () => {});',
    'afterEach(() => {});',
  ])('catches %s in a spec', async (code) => {
    expect(await specMessages('no-restricted-syntax', code)).toEqual([
      expect.stringContaining('fixture teardown'),
    ]);
  });

  it('leaves a setup hook alone', async () => {
    expect(await specMessages('no-restricted-syntax', 'test.beforeEach(async () => {});')).toEqual(
      []
    );
  });
});

describe('e2e assertion-helper patterns', () => {
  // The two guard helpers register an allowed-error pattern on the page and
  // assert nothing, so a body whose only call is one of them establishes
  // nothing about the application.
  it.each(['expectApiErrors(page, []);', 'expectConsoleErrors(page, []);'])(
    'refuses a test body whose only call is %s',
    async (call) => {
      const code = `test('x', async ({ page }) => { ${call} });`;
      expect(await specMessages('playwright/expect-expect', code)).toHaveLength(1);
    }
  );

  it('accepts a test body calling an assertion helper', async () => {
    const code = "test('x', async ({ page }) => { await expectSharedConversationLoaded(page); });";
    expect(await specMessages('playwright/expect-expect', code)).toEqual([]);
  });
});

describe('import/no-cycle module-graph settings', () => {
  const fixtures = path.join(import.meta.dirname, '__test-fixtures-import-cycle__');

  /** Resolves this codebase's `.js`-suffixed ESM relative imports onto `.ts` sources. */
  const resolverSetting = {
    'import/resolver': { typescript: { alwaysTryTypes: true, project: import.meta.dirname } },
  };

  async function cyclesReportedIn(settings) {
    const linter = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslintParser },
          plugins: { import: importPlugin },
          settings,
          rules: { 'import/no-cycle': ['error', { maxDepth: Number.POSITIVE_INFINITY }] },
        },
      ],
    });
    const results = await linter.lintFiles([fixtures]);
    return results
      .filter((r) => r.messages.some((m) => m.ruleId === 'import/no-cycle'))
      .map((r) => path.basename(r.filePath))
      .toSorted();
  }

  it('reports a two-file cycle when TypeScript extensions are declared', async () => {
    const reported = await cyclesReportedIn({
      ...resolverSetting,
      ...typescriptImportGraphSettings,
    });
    expect(reported).toEqual(['cycle-a.ts', 'cycle-b.ts']);
  });

  it('leaves an acyclic import in the same run unreported', async () => {
    // A gate that fired on every import would pass the test above while
    // proving nothing, so the discrimination is asserted, not assumed.
    const reported = await cyclesReportedIn({
      ...resolverSetting,
      ...typescriptImportGraphSettings,
    });
    expect(reported).not.toContain('acyclic-root.ts');
    expect(reported).not.toContain('acyclic-leaf.ts');
  });

  it('is armed by createBaseConfig alone, with no per-package opt-in', async () => {
    // Every tree composes createBaseConfig and nothing else supplies these
    // settings, so this is what makes the gate real repo-wide rather than in
    // whichever packages remembered to spread them.
    const baseSettings = Object.assign(
      {},
      ...createBaseConfig(import.meta.dirname).map((entry) => entry.settings ?? {})
    );

    expect(await cyclesReportedIn(baseSettings)).toEqual(['cycle-a.ts', 'cycle-b.ts']);
  });

  it('reports nothing without them, which is how the rule died silently', async () => {
    // The extension set gates whether the rule parses a resolved file at all,
    // and defaults to ['.js', '.mjs', '.cjs']. On a TypeScript tree that made
    // every module map null: resolution succeeded, traversal never began, and
    // the rule reported clean on a real cycle. Deleting the settings brings
    // that silence straight back, so this is the regression guard.
    expect(await cyclesReportedIn(resolverSetting)).toEqual([]);
  });
});

/**
 * ESLint exits zero on warnings, so a rule a plugin ships at warn severity
 * reports without failing anything wherever the linter runs without
 * `--max-warnings=0` — a package's own `eslint .` and the editor among them.
 * Promotion makes every invocation path resolve the same rules at the same
 * severities over the files that run reads, which equalizes rule set and
 * severity but never coverage; the flag the lint scripts pass is the backstop
 * for a warn-level rule a plugin upgrade introduces, which severity promotion
 * alone gives up.
 *
 * `--print-config` reports severity numerically.
 */
const BUILD_FAILING = 2;

const PROMOTED_PROMISE_RULES = [
  'promise/no-callback-in-promise',
  'promise/no-promise-in-callback',
  'promise/no-return-in-finally',
  'promise/valid-params',
];

const PROMOTED_REACT_HOOKS_RULES = [
  'react-hooks/exhaustive-deps',
  'react-hooks/incompatible-library',
  'react-hooks/unsupported-syntax',
];

/** One React tree and one without, so a promotion scoped to either is caught. */
const PROMOTION_FIXTURES = [
  ['apps/api', 'src/app.ts'],
  ['apps/web', 'src/main.tsx'],
];

describe('rules their plugins ship at warn severity', () => {
  it.each(PROMOTED_PROMISE_RULES)('resolves %s to a build failure', async (rule) => {
    const resolved = await Promise.all(
      PROMOTION_FIXTURES.map(([tree, file]) => resolvedRule(tree, file, rule))
    );
    expect(resolved).toEqual(PROMOTION_FIXTURES.map(() => [BUILD_FAILING]));
  });

  it.each(PROMOTED_REACT_HOOKS_RULES)(
    'resolves %s to a build failure where the plugin is registered',
    async (rule) => {
      expect(await resolvedRule('apps/web', 'src/main.tsx', rule)).toEqual([BUILD_FAILING]);
    }
  );

  it.each(PROMOTION_FIXTURES)('fails %s/%s on an unused disable directive', async (tree, file) => {
    const { linterOptions } = await printedConfig(tree, file);
    expect(linterOptions.reportUnusedDisableDirectives).toBe(BUILD_FAILING);
  });
});

/**
 * A source module and a test module, read out of one tree so the cap's reach is
 * a property of the resolution rather than of which package was sampled.
 */
const CAP_SOURCE_FIXTURE = ['apps/api', 'src/app.ts'];
const CAP_TEST_FIXTURE = ['apps/api', 'src/whole-app/app.test.ts'];

const OFF = 0;

/** A module of `count` lines, each of which the cap counts. */
function countedLines(count) {
  return Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`);
}

/**
 * Whether the cap reports a module, measured with the options the resolution
 * carries rather than with a second copy of them written here.
 */
function capReports(lines, options) {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    lines.join('\n'),
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslintParser },
      rules: { 'max-lines': [BUILD_FAILING, options] },
    },
    'module.ts'
  );
  return messages.map((message) => message.ruleId);
}

describe('the module size cap', () => {
  it('holds a source module to a fixed number of lines', async () => {
    expect(await resolvedRule(...CAP_SOURCE_FIXTURE, 'max-lines')).toEqual([
      BUILD_FAILING,
      { max: 800, skipBlankLines: true, skipComments: true },
    ]);
  });

  it('leaves a test module uncapped', async () => {
    // Severity alone: flat config carries the options forward from the entry a
    // severity-only setting overrides, so the whole entry still states them.
    const [severity] = await resolvedRule(...CAP_TEST_FIXTURE, 'max-lines');

    expect(severity).toBe(OFF);
  });

  it('counts a module by its code lines, neither blank nor comment', async () => {
    const [, options] = await resolvedRule(...CAP_SOURCE_FIXTURE, 'max-lines');

    const atCap = [
      ...countedLines(options.max),
      ...Array.from({ length: 200 }, () => ''),
      '// a line comment',
      '/* a block comment',
      ' * whose every line is comment',
      ' */',
    ];
    expect(capReports(atCap, options)).toEqual([]);
    expect(capReports(countedLines(options.max + 1), options)).toEqual(['max-lines']);
  });
});
