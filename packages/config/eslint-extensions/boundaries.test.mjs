import { existsSync, readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import boundariesExtension from './boundaries.config.mjs';

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '__test-fixtures-boundaries__'
);

// Mirrors the apps/api shape: turbo runs each package's lint with the package
// dir as cwd, which is where cwd-relative element patterns break.
const PACKAGE_DIR = path.join(FIXTURES_ROOT, 'apps', 'api');

/**
 * Recreates the pnpm workspace-link shape (`node_modules/@fixture/shared` →
 * `../../../../packages/shared`) at test time: `node_modules/` is gitignored,
 * so a committed symlink would never survive a fresh checkout.
 */
async function ensureWorkspaceLink() {
  const linkDir = path.join(PACKAGE_DIR, 'node_modules', '@fixture');
  await fs.mkdir(linkDir, { recursive: true });
  try {
    await fs.symlink(
      path.join('..', '..', '..', '..', 'packages', 'shared'),
      path.join(linkDir, 'shared'),
      'dir'
    );
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error)) throw error;
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/** @param {string} cwd */
function buildEslint(cwd) {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...boundariesExtension,
    ],
  });
}

/**
 * @param {string} cwd
 * @param {string[]} patterns
 */
async function lintTree(cwd, patterns) {
  const eslint = buildEslint(cwd);
  const results = await eslint.lintFiles(patterns);
  /** @type {Map<string, import('eslint').Linter.LintMessage[]>} */
  const byFile = new Map();
  for (const result of results) {
    const relative = path.relative(cwd, result.filePath).replaceAll('\\', '/');
    byFile.set(relative, result.messages);
  }
  return byFile;
}

/** Lints the whole fixture tree once from the fixtures root; tests assert per-file. */
function lintFixtures() {
  return lintTree(FIXTURES_ROOT, ['src/**/*.ts', 'apps/api/src/**/*.ts']);
}

/**
 * Lints the fixture package the way turbo does (`eslint .` with the package
 * dir as cwd). eslint-plugin-boundaries anchors element patterns to
 * `process.cwd()` unless `boundaries/root-path` is set, so the chdir — not
 * just the ESLint `cwd` option — is what reproduces the turbo invocation.
 */
async function lintFromPackageCwd() {
  const previousCwd = process.cwd();
  process.chdir(PACKAGE_DIR);
  try {
    return await lintTree(PACKAGE_DIR, ['src/**/*.ts']);
  } finally {
    process.chdir(previousCwd);
  }
}

/** @type {Map<string, import('eslint').Linter.LintMessage[]>} */
let byFile;
/** @type {Map<string, import('eslint').Linter.LintMessage[]>} */
let byFileFromPackageCwd;

beforeAll(async () => {
  await ensureWorkspaceLink();
  byFile = await lintFixtures();
  byFileFromPackageCwd = await lintFromPackageCwd();
});

/**
 * @param {Map<string, import('eslint').Linter.LintMessage[]>} map
 * @param {string} file
 */
function messagesFrom(map, file) {
  const messages = map.get(file);
  if (messages === undefined) {
    throw new Error(`fixture file was not linted: ${file}`);
  }
  return messages;
}

/** @param {string} file */
function violations(file) {
  return messagesFrom(byFile, file);
}

/** @param {string} file */
function ruleIds(file) {
  return violations(file).map((message) => message.ruleId);
}

/** @param {string} file */
function packageCwdViolations(file) {
  return messagesFrom(byFileFromPackageCwd, file);
}

/** @param {string} file */
function packageCwdRuleIds(file) {
  return packageCwdViolations(file).map((message) => message.ruleId);
}

describe('cross-slice boundaries', () => {
  it('fails a cross-slice import of another slice internal', () => {
    expect(ruleIds('src/slices/beta/domain/cross-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails a cross-slice internal import written with a .js suffix', () => {
    expect(ruleIds('src/slices/beta/domain/cross-slice-internal-js.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('passes a cross-slice import of another slice barrel', () => {
    expect(violations('src/slices/beta/domain/cross-slice-barrel.ts')).toEqual([]);
  });
});

// The declaration these globs are built from names three suffixes; a config
// that ignored only `.test.` would hold test scaffolding to production import
// rules that the layer next to it already exempts, and the disagreement
// surfaces as a surprise for whoever next writes a rule aimed at scaffolding.
describe('test-file spellings', () => {
  it.each(['setup', 'spec'])('ignores a .%s. file the way it ignores a .test. file', (suffix) => {
    expect(violations(`src/slices/beta/domain/cross-slice-internal.${suffix}.ts`)).toEqual([]);
  });

  // The other half of that exemption, and the half a suffix-keyed ignore list
  // cannot state on its own: a module the perimeter stops holding to the import
  // rules must also stop being something the governed code may import. Without
  // this, renaming a file into a test spelling is a unilateral opt-out —
  // production keeps importing it while it is free to hold anything.
  it('fails production slice code importing a test-spelled module', () => {
    expect(ruleIds('src/slices/beta/domain/imports-test-setup.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  // Type-only counts, as it does for the infra disallow next door: an erased
  // import still says a governed layer's contract is written in a test module's
  // shapes, and the element matches a path rather than a binding, so nothing
  // about the import's kind reaches the decision. Pinned because the sibling
  // disallow pins it and because an enumeration that silently stopped at value
  // imports is exactly what this element exists to make impossible.
  it('fails production slice code importing a test-spelled module type-only', () => {
    expect(ruleIds('src/slices/beta/domain/imports-test-setup-type-only.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  // The extension half of the same question. `panel.setup.tsx` carries an
  // existence assertion because its absence would fail in the SAME DIRECTION as
  // a pass: an unresolved local reports `boundaries/dependencies` too, so the
  // `.tsx` refusal would go on reading as held over a file that is not there.
  // `panel.tsx` is asserted beside it and discriminates nothing — its absence
  // reddens the control test loudly. The test is the failure direction, never
  // whether a fixture happens to go unlinted.
  it.each(['panel.setup.tsx', 'panel.tsx'])('resolves the %s fixture on disk', (file) => {
    expect(existsSync(path.join(FIXTURES_ROOT, 'src/slices/beta/domain', file))).toBe(true);
  });

  it('fails production slice code importing a test-spelled module outside .ts', () => {
    expect(ruleIds('src/slices/beta/domain/imports-tsx-test-setup.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  // The control for that `.tsx` refusal: the same specifier shape against a
  // production sibling in the same extension passes, so what the refusal reads
  // is the test spelling rather than the extension.
  it('passes production slice code importing a production sibling outside .ts', () => {
    expect(violations('src/slices/beta/domain/imports-tsx-sibling.ts')).toEqual([]);
  });
});

describe('public entry modules', () => {
  it('passes domain importing another slice public entry module', () => {
    expect(violations('src/slices/beta/domain/cross-slice-public.ts')).toEqual([]);
  });

  it('passes a public entry module importing its own slice domain', () => {
    expect(violations('src/slices/alpha/public/greeting.ts')).toEqual([]);
  });

  it('fails a public entry module importing another slice barrel', () => {
    expect(ruleIds('src/slices/alpha/public/imports-foreign-barrel.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails a public entry module importing another slice public entry module', () => {
    expect(ruleIds('src/slices/alpha/public/imports-foreign-public.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails a public entry module importing an infra library', () => {
    expect(ruleIds('src/slices/alpha/public/imports-infra.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails routes importing another slice public entry module', () => {
    expect(ruleIds('src/slices/beta/routes.ts')).toContain('boundaries/dependencies');
  });

  it('fails a slice barrel importing another slice public entry module', () => {
    expect(ruleIds('src/slices/zeta/index.ts')).toContain('boundaries/dependencies');
  });

  // The barrel reaches its own door through the same-slice allowance, not through
  // the door grant, which names no barrel. Nothing in the backend exercises this
  // today, so narrowing that allowance would otherwise fail first for whoever
  // next writes the published-surface pattern the slice template documents.
  it('passes a slice barrel re-exporting its own slice public entry module', () => {
    expect(violations('src/slices/eta/index.ts')).toEqual([]);
  });
});

describe('intra-slice layers', () => {
  it('fails domain importing its own slice adapters', () => {
    expect(ruleIds('src/slices/alpha/domain/imports-own-adapter.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails domain importing an infra library', () => {
    expect(ruleIds('src/slices/alpha/domain/imports-infra.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails routes importing domain internals', () => {
    expect(ruleIds('src/slices/gamma/routes.ts')).toContain('boundaries/dependencies');
  });

  it('passes routes importing the domain barrel and middleware', () => {
    expect(violations('src/slices/alpha/routes.ts')).toEqual([]);
  });

  it('passes domain importing its own ports', () => {
    expect(violations('src/slices/alpha/domain/service.ts')).toEqual([]);
  });

  it('passes domain importing a non-infra external library', () => {
    expect(violations('src/slices/alpha/domain/imports-zod.ts')).toEqual([]);
  });

  it('passes adapters importing an infra library', () => {
    expect(violations('src/slices/alpha/adapters/imports-infra.ts')).toEqual([]);
  });

  // The slice root is a layer of the perimeter, not a gap in it: a module
  // sitting directly under a slice, outside the named layers, is held to the
  // same infra ban as the layers below it.
  it('fails a module at the slice root importing an infra library', () => {
    expect(ruleIds('src/slices/alpha/imports-infra.ts')).toContain('boundaries/dependencies');
  });

  // Type-only counts, on both sides of the seam. The ban asks whether a layer's
  // contract is written in a vendor's shapes, which an erased import does just
  // as loudly as a live one — and the layers below the slice root already
  // answer it that way, so answering it differently here would leave the
  // stricter layer the laxer one.
  it('fails a module at the slice root importing an infra library type-only', () => {
    expect(ruleIds('src/slices/alpha/imports-infra-type-only.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails domain importing an infra library type-only', () => {
    expect(ruleIds('src/slices/alpha/domain/imports-infra-type-only.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('passes adapters importing an infra library type-only', () => {
    expect(violations('src/slices/alpha/adapters/imports-infra-type-only.ts')).toEqual([]);
  });

  // What the slice root loses is the infra list, not the external allow it
  // shares with every other backend tree.
  it('passes a module at the slice root importing a non-infra external library', () => {
    expect(violations('src/slices/alpha/imports-zod.ts')).toEqual([]);
  });

  it('passes the slice barrel re-exporting its own internals', () => {
    expect(violations('src/slices/alpha/index.ts')).toEqual([]);
  });

  // The barrel is the slice's published door, so an infra client reaching it
  // there is worse than one leaking into an internal layer: every consumer of
  // the slice can then hold the vendor's shape without importing the vendor.
  // Re-export is a barrel's whole job, so each of the three spellings that
  // launder a module through one is pinned on its own.
  it('fails a slice barrel importing an infra library', () => {
    expect(ruleIds('src/slices/theta/index.ts')).toContain('boundaries/dependencies');
  });

  it('fails a slice barrel re-exporting an infra library value', () => {
    expect(ruleIds('src/slices/iota/index.ts')).toContain('boundaries/dependencies');
  });

  it('fails a slice barrel re-exporting an infra library type', () => {
    expect(ruleIds('src/slices/kappa/index.ts')).toContain('boundaries/dependencies');
  });
});

describe('out-of-tree isolation', () => {
  it('fails domain importing a file outside the backend trees', () => {
    expect(ruleIds('src/slices/alpha/domain/imports-out-of-tree.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('passes domain importing a lib module', () => {
    expect(violations('src/slices/alpha/domain/imports-lib.ts')).toEqual([]);
  });

  it('fails a lib module importing a slice', () => {
    expect(ruleIds('src/lib/result/imports-slice.ts')).toContain('boundaries/dependencies');
  });

  it('passes a lib module importing another lib module', () => {
    expect(violations('src/lib/errors/uses-result.ts')).toEqual([]);
  });

  it('passes a middleware module with no foreign imports', () => {
    expect(violations('src/middleware/pipeline-example.ts')).toEqual([]);
  });

  it('fails middleware importing a slice internal', () => {
    expect(ruleIds('src/middleware/imports-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });
});

describe('composition root', () => {
  it('passes wiring slices through barrels and public doors, plus lib and middleware', () => {
    expect(violations('apps/api/src/composition/wires.ts')).toEqual([]);
  });

  it('passes a root entry file importing the composition tree and the dev manifest', () => {
    expect(violations('apps/api/src/app.ts')).toEqual([]);
  });

  it('fails composition importing a slice domain module', () => {
    expect(ruleIds('apps/api/src/composition/imports-slice-domain.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails composition importing test scaffolding', () => {
    expect(ruleIds('apps/api/src/composition/imports-test-support.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails composition importing a file in a top-level directory no descriptor names', () => {
    expect(ruleIds('apps/api/src/composition/imports-unknown-tree.ts')).toContain(
      'boundaries/dependencies'
    );
  });
});

// `no-unknown-files` is the source-direction half of the perimeter: the
// dependency rules refuse an import whose TARGET matches no descriptor, and this
// one refuses a governed FILE that matches no descriptor. Together they are what
// lets the header claim classification is closed rather than merely measured
// closed on the day someone last counted.
describe('classification perimeter', () => {
  // This fixture is meant to stay unclassified forever — it is the target the
  // unknown-tree import test refuses. Asserting its report is how that stays
  // true: widening a descriptor to swallow it, or silencing the rule on it,
  // would destroy the only unclassified file the suite has.
  it('reports a file in a top-level directory no descriptor names', () => {
    expect(ruleIds('apps/api/src/services/thing.ts')).toContain('boundaries/no-unknown-files');
  });

  it('reports nothing for a file a descriptor names', () => {
    expect(ruleIds('apps/api/src/composition/wires.ts')).not.toContain(
      'boundaries/no-unknown-files'
    );
  });

  // A slice that invents its own directory layout is refused by the same
  // source-direction rule that refuses an unnamed top-level directory: the
  // slice catch-all reaches the slice root only, so nothing deeper than the
  // named layers is classified.
  it('reports a file in a slice subdirectory no descriptor names', () => {
    expect(ruleIds('src/slices/alpha/helpers/unnamed-subdirectory.ts')).toContain(
      'boundaries/no-unknown-files'
    );
  });

  // The other half of that narrowing: the catch-all still has to hold the
  // modules that sit at a slice root, which is where the backend's seam
  // modules live. Without this, narrowing the pattern to match nothing would
  // pass every other assertion in the suite.
  it('reports nothing for a module at a slice root outside the named layers', () => {
    expect(violations('src/slices/alpha/manifest.ts')).toEqual([]);
  });
});

describe('dev and test scaffolding', () => {
  it('passes dev tooling reaching slice internals and the composition tree', () => {
    expect(violations('apps/api/src/dev/routes.ts')).toEqual([]);
  });

  it('passes test scaffolding reaching slice internals and the composition tree', () => {
    expect(violations('apps/api/src/test-support/harness.ts')).toEqual([]);
  });

  // The reach-everything grant is what makes these two trees able to compose
  // the tree, and a test-spelled module is the one thing it stops short of:
  // `dev` ships behind an env gate, so anything it names is production-reachable,
  // and a module that needs `test-support` to import it is not test-only.
  it.each(['dev', 'test-support'])('fails %s importing a test-spelled module', (tree) => {
    expect(ruleIds(`apps/api/src/${tree}/imports-test-setup.ts`)).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails production slice code importing dev tooling', () => {
    expect(ruleIds('apps/api/src/slices/epsilon/domain/imports-dev.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails production slice code importing test scaffolding', () => {
    expect(ruleIds('apps/api/src/slices/epsilon/domain/imports-test-support.ts')).toContain(
      'boundaries/dependencies'
    );
  });
});

describe('workspace package imports', () => {
  it('passes a ports file importing a workspace package from the fixtures root', () => {
    expect(violations('apps/api/src/slices/delta/ports/imports-workspace-package.ts')).toEqual([]);
  });

  // The allow above is written over the `internal-package` element, and
  // `test-file` precedes it in the descriptor list — so a workspace-package
  // module carrying a test spelling is claimed as a test file and this allow
  // never reaches it. Reordering those two descriptors is silent everywhere
  // else in this fixture tree, measured rather than assumed, so this case is
  // the only thing holding the precedence. The assertion names the target
  // element the refusal reports, because an unresolved specifier reports the
  // same rule id and would otherwise read as a pass of this test. The subpath
  // is spelled without the marker the file on disk carries, which is what
  // makes the refusal read the resolved path rather than the specifier.
  it('fails a slice importing a test-spelled module from a workspace package', () => {
    expect(violations('apps/api/src/slices/delta/ports/imports-workspace-test-module.ts')).toEqual([
      expect.objectContaining({
        ruleId: 'boundaries/dependencies',
        message: expect.stringContaining('to elements of type "test-file"'),
      }),
    ]);
  });

  // The control for the case above: the same subpath shape against a
  // production-spelled sibling in the same package resolves and passes, so
  // what the refusal reads is the spelling rather than the subpath.
  it('passes a slice importing a production sibling through a workspace-package subpath', () => {
    expect(violations('apps/api/src/slices/delta/ports/imports-workspace-subpath.ts')).toEqual([]);
  });

  it('fails a cross-slice internal import from the fixtures root', () => {
    expect(ruleIds('apps/api/src/slices/epsilon/domain/cross-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('passes a ports file importing a workspace package from the package cwd', () => {
    expect(packageCwdViolations('src/slices/delta/ports/imports-workspace-package.ts')).toEqual([]);
  });

  it('passes a lib file importing a workspace package from the package cwd', () => {
    expect(packageCwdViolations('src/lib/context/imports-workspace-package.ts')).toEqual([]);
  });

  it('fails a cross-slice internal import from the package cwd', () => {
    expect(packageCwdRuleIds('src/slices/epsilon/domain/cross-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  // The perimeter's `files` glob names `apps/api`, and ESLint resolves that
  // glob against the config's base path — which is the package dir under the
  // invocation turbo actually makes. Selecting the tree by name only works
  // while the base path is pinned to the repo root, and a config that lost
  // the pin would go green everywhere rather than reporting anything.
  it('governs the composition tree from the package cwd', () => {
    expect(packageCwdRuleIds('src/composition/imports-slice-domain.ts')).toContain(
      'boundaries/dependencies'
    );
  });
});

// Comments do not survive into the resolved config, so what the head docblock
// claims about each rule's comment is observable only from this file's source.
// `packages/config/rule-named-paths.mjs` also reads that source — reaching it by
// walking `eslint-extensions` whole rather than by naming it — but parses it and
// consumes only string, template and regex literals, so comments are outside its
// reach. The `rule descriptions` cases read the source.
const CONFIG_SOURCE = readFileSync(new URL('boundaries.config.mjs', import.meta.url), 'utf8');

/** The dependencies rules the resolved config holds, whichever entry carries them. */
const resolvedDependencyRules = boundariesExtension.flatMap(
  (entry) => entry.rules?.['boundaries/dependencies']?.[1]?.rules ?? []
);

/** @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Where the dependencies rule objects sit in the config's own source: the array
 * opens on the `rules: [` line, each element sits one indentation level inside
 * it, and it closes at the next line back at the opening line's indentation.
 * `starts` are 1-based so a failure names the line an editor shows; `close` is
 * the line a new rule would be written above.
 *
 * @param {string} source
 */
function locateDependencyRules(source) {
  const lines = source.split('\n');
  const open = lines.findIndex((line) => line.trim() === 'rules: [');
  const openLine = lines[open];
  if (openLine === undefined) {
    throw new Error('boundaries.config.mjs holds no `rules: [` line to walk');
  }
  const arrayIndent = indentOf(openLine);
  /** @type {number[]} */
  const starts = [];
  let close = lines.length;
  for (const [index, line] of lines.entries()) {
    if (index <= open || line.trim() === '') {
      continue;
    }
    if (indentOf(line) === arrayIndent) {
      close = index + 1;
      break;
    }
    if (indentOf(line) === arrayIndent + 2 && line.trimStart().startsWith('{')) {
      starts.push(index + 1);
    }
  }
  return { starts, close };
}

/**
 * The dependencies rules with no `//` comment on the line directly above them.
 * @param {string} source
 */
function undescribedRules(source) {
  const lines = source.split('\n');
  return locateDependencyRules(source).starts.filter(
    (start) => !lines[start - 2]?.trimStart().startsWith('//')
  );
}

/**
 * The config's own source with one more rule appended where a new one goes,
 * carrying no comment — the shape this gate exists to catch, so the catch is
 * driven against the real file rather than a synthetic one.
 *
 * @param {string} source
 */
function withUndescribedRuleAppended(source) {
  const { close } = locateDependencyRules(source);
  const lines = source.split('\n');
  const closingLine = lines[close - 1];
  if (closingLine === undefined) throw new Error('the rules array has no closing line');
  const indent = ' '.repeat(indentOf(closingLine) + 2);
  lines.splice(close - 1, 0, `${indent}{ from: { type: 'lib' }, allow: { to: { type: 'lib' } } },`);
  return lines.join('\n');
}

describe('rule descriptions', () => {
  // The control that keeps the gate below from passing over rules it never
  // found: the text walk and the resolved config must agree on how many rules
  // there are, so neither a missed rule nor a miscounted nested object leaves
  // the gate quietly narrower than the file.
  it('locates every dependencies rule the resolved config holds', () => {
    expect(locateDependencyRules(CONFIG_SOURCE).starts).toHaveLength(
      resolvedDependencyRules.length
    );
  });

  it('has a comment directly above every dependencies rule', () => {
    expect(undescribedRules(CONFIG_SOURCE)).toEqual([]);
  });

  // The failing arm of the case above, kept rather than driven once: without
  // it, a walk that reported nothing would satisfy that case forever.
  it('reports a rule appended with no comment above it', () => {
    const { close } = locateDependencyRules(CONFIG_SOURCE);
    expect(undescribedRules(withUndescribedRuleAppended(CONFIG_SOURCE))).toEqual([close]);
  });
});

// Slice-layer modules in `apps/api` state the infra-client ban one layer at a
// time, in prose, citing this config as where the layer set is stated. Nothing
// in the plugin can read a comment, so each sentence is true only while the
// disallow's `from` alternation still says what it says — and it says it for
// every layer at once, so a widening turns all of them false together.
//
// IN SCOPE, by phrasing rather than by a file list: a slice module whose
// comments introduce the citation with `Which layers … is stated in
// <this config's path>`, and which carries a claim on one of two arms —
// "this `<layer>/` layer is refused …" (the layer IS in the alternation) or
// "`<layer>/` is where a slice's infra clients live" (it is NOT). A module
// citing the config for anything else — which imports a route may name, say —
// makes no membership claim and is not in scope. A site added tomorrow in the
// scoped phrasing is covered without editing this file; one that invents a
// third phrasing is not reachable by any regex, which is the standing limit
// here and the reason {@link unparsedCitations} reds on a citation it cannot
// parse rather than passing over it.
const API_SLICES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'apps',
  'api',
  'src',
  'slices'
);

const DOCTRINE_CITATION =
  /Which layers [^`]*is stated in `packages\/config\/eslint-extensions\/boundaries\.config\.mjs`/;
const REFUSED_CLAIM = /this `([a-z-]+)\/` layer is refused/g;
const PERMITTED_CLAIM = /`([a-z-]+)\/` is where a slice's infra clients live/g;
const REFUSED_PHRASE = 'this `$1/` layer is refused';
const PERMITTED_PHRASE = "`$1/` is where a slice's infra clients live";

/**
 * The dependencies rules scoped to a module list — the infra-client ban the
 * slice-layer sentences describe. Selected by that shape rather than by
 * position, and asserted unique below, so a second module-scoped rule reds
 * instead of leaving this gate reading whichever one came first.
 */
const infraDisallowRules = resolvedDependencyRules.filter(
  (rule) => rule.disallow?.dependency?.module !== undefined
);

/**
 * The element types a rule's `from.type` alternation names.
 * @param {(typeof resolvedDependencyRules)[number]} rule
 */
function fromTypesOf(rule) {
  return rule.from.type.replaceAll(/^\(|\)$/g, '').split('|');
}

/**
 * Slice layer directory → the element type the config gives it, read off the
 * element descriptors patterning a whole slice subdirectory. A layer the config
 * describes by a single filename instead (a barrel, `routes.ts`) is absent, so
 * {@link membershipMismatches} reds on such a file rather than mis-deriving it.
 */
const sliceLayerTypes = new Map(
  boundariesExtension
    .flatMap((entry) => entry.settings?.['boundaries/elements'] ?? [])
    .flatMap((element) =>
      (element.pattern ?? []).map(
        (pattern) => /** @type {[string, string]} */ ([pattern, element.type])
      )
    )
    .flatMap(([pattern, type]) => {
      const layer = /^\*\*\/src\/slices\/\(\*\)\/([a-z-]+)\/\*\*\/\*$/.exec(pattern);
      const name = layer?.[1];
      return name === undefined ? [] : [/** @type {[string, string]} */ ([name, type])];
    })
);

/**
 * Comment markers stripped and whitespace collapsed, so a wrapped sentence reads as one.
 * @param {string} source
 */
function normalizeComments(source) {
  return source.replaceAll(/^[ \t]*(\/\*\*|\*\/|\*|\/\/)[ \t]?/gm, '').replaceAll(/\s+/g, ' ');
}

/** Every `apps/api` slice module as `{ file, text }`, paths relative to the slices root. */
function sliceModules() {
  return readdirSync(API_SLICES_ROOT, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({
      file,
      text: normalizeComments(readFileSync(path.join(API_SLICES_ROOT, file), 'utf8')),
    }));
}

const SLICE_MODULES = sliceModules();

/** @typedef {{ file: string, text: string }} SliceModule */

/**
 * The modules citing the config in the doctrine phrasing.
 * @param {SliceModule[]} modules
 */
function citingModules(modules) {
  return modules.filter((module) => DOCTRINE_CITATION.test(module.text));
}

/**
 * The membership claims one module's comments make, both arms.
 * @param {string} text
 * @returns {{ layer: string | undefined, refused: boolean }[]}
 */
function claimsIn(text) {
  return [
    ...[...text.matchAll(REFUSED_CLAIM)].map(([, layer]) => ({ layer, refused: true })),
    ...[...text.matchAll(PERMITTED_CLAIM)].map(([, layer]) => ({ layer, refused: false })),
  ];
}

/**
 * The layer a module sits in, and the element type the config gives that layer.
 * @param {string} file
 */
function elementTypeOf(file) {
  const [, layerDirectory] = file.split('/');
  const layer = layerDirectory === undefined ? undefined : sliceLayerTypes.get(layerDirectory);
  if (layer === undefined) {
    throw new Error(`${file} sits in no slice layer this config patterns as a whole directory`);
  }
  return layer;
}

/**
 * The citing modules whose claimed membership the config contradicts.
 * @param {SliceModule[]} modules
 * @param {string[]} refusedTypes
 */
function membershipMismatches(modules, refusedTypes) {
  return citingModules(modules).flatMap(({ file, text }) =>
    claimsIn(text).flatMap((claim) => {
      if (claim.layer !== file.split('/')[1]) {
        throw new Error(`${file} states a consequence for \`${claim.layer}/\`, not its own layer`);
      }
      return claim.refused === refusedTypes.includes(elementTypeOf(file)) ? [] : [file];
    })
  );
}

/**
 * The citing modules holding no claim this gate can read.
 * @param {SliceModule[]} modules
 */
function unparsedCitations(modules) {
  return citingModules(modules)
    .filter(({ text }) => claimsIn(text).length === 0)
    .map(({ file }) => file);
}

/**
 * The first citing module claiming the given arm — the subject of a control below.
 * @param {boolean} refused
 */
function siteOnArm(refused) {
  const site = citingModules(SLICE_MODULES).find(({ text }) =>
    claimsIn(text).some((claim) => claim.refused === refused)
  );
  if (site === undefined) {
    throw new Error(`no citing slice module claims refused=${refused}`);
  }
  return site;
}

/**
 * The real modules with one module's sentence rewritten in memory — never on disk.
 * @param {SliceModule} site
 * @param {RegExp} pattern
 * @param {string} phrase
 */
function withRewritten(site, pattern, phrase) {
  return SLICE_MODULES.map((module) =>
    module === site ? { ...module, text: module.text.replace(pattern, phrase) } : module
  );
}

describe('slice-layer boundary comments', () => {
  const refusedTypes = () => {
    const [moduleScoped] = infraDisallowRules;
    if (moduleScoped === undefined) throw new Error('the config holds no module-scoped rule');
    return fromTypesOf(moduleScoped);
  };

  // Without this the selector could silently pick one of several module-scoped
  // rules and every case below would be about whichever came first.
  it('finds exactly one module-scoped dependencies rule to read the ban off', () => {
    expect(infraDisallowRules).toHaveLength(1);
  });

  it('states the membership the config gives its own layer at every citing site', () => {
    expect(membershipMismatches(SLICE_MODULES, refusedTypes())).toEqual([]);
  });

  it('parses a claim out of every module citing the config', () => {
    expect(unparsedCitations(SLICE_MODULES)).toEqual([]);
  });

  // The permitted arm has one site today, so a deletion would leave the case
  // above green over refusals alone and the arm proving nothing.
  it('carries a citing site on each arm of the membership', () => {
    const arms = citingModules(SLICE_MODULES).flatMap(({ text }) =>
      claimsIn(text).map((claim) => claim.refused)
    );
    expect([...new Set(arms)].toSorted()).toEqual([false, true]);
  });

  it('reports a refused-arm site rewritten to claim its layer is permitted', () => {
    const site = siteOnArm(true);
    expect(
      membershipMismatches(withRewritten(site, REFUSED_CLAIM, PERMITTED_PHRASE), refusedTypes())
    ).toEqual([site.file]);
  });

  it('reports a permitted-arm site rewritten to claim its layer is refused', () => {
    const site = siteOnArm(false);
    expect(
      membershipMismatches(withRewritten(site, PERMITTED_CLAIM, REFUSED_PHRASE), refusedTypes())
    ).toEqual([site.file]);
  });

  it('reports every refused-arm site whose layer the alternation stops naming', () => {
    const struck = elementTypeOf(siteOnArm(true).file);
    const named = citingModules(SLICE_MODULES)
      .filter(({ file }) => elementTypeOf(file) === struck)
      .map(({ file }) => file);
    expect(
      membershipMismatches(
        SLICE_MODULES,
        refusedTypes().filter((type) => type !== struck)
      )
    ).toEqual(named);
  });

  it('reports a permitted-arm site whose layer the alternation starts naming', () => {
    const site = siteOnArm(false);
    expect(
      membershipMismatches(SLICE_MODULES, [...refusedTypes(), elementTypeOf(site.file)])
    ).toEqual([site.file]);
  });

  it('reports a citing module whose claim sentence has gone', () => {
    const site = siteOnArm(true);
    expect(unparsedCitations(withRewritten(site, REFUSED_CLAIM, 'this layer is refused'))).toEqual([
      site.file,
    ]);
  });
});
