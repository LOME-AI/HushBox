import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveCarriers, resolveRunProjects } from './browser-matrix.js';
import {
  ALL_PROJECT_NAMES,
  BROWSER_MATRIX_PROJECTS,
  DESKTOP_PROJECTS,
  E2E_PROJECTS,
  E2E_PROJECT_NAMES,
  MOBILE_PROJECTS,
  PLANE_PROJECTS,
  PROJECT_CODE,
  setupProjectName,
} from './projects.js';

/** The three binaries Playwright installs; every one must be exercised. */
const PLAYWRIGHT_BROWSERS = ['chromium', 'firefox', 'webkit'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PLAYWRIGHT_CONFIG = path.join(REPO_ROOT, 'playwright.config.ts');

/** A property name, whether the source spells it bare or quoted. */
function propertyName(node: ts.PropertyAssignment): string | undefined {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
}

/** Every node of a source, parsed once, so a search reads as a filter rather than a walk. */
function* nodes(source: string): Generator<ts.Node> {
  const walk = function* (node: ts.Node): Generator<ts.Node> {
    yield node;
    const children: ts.Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    for (const child of children) yield* walk(child);
  };
  yield* walk(ts.createSourceFile('config.ts', source, ts.ScriptTarget.Latest, true));
}

/**
 * A read's outcome. `absent` and `unreadable` are deliberately separate states: absent
 * means the config genuinely declares nothing here and a fallback may stand in;
 * unreadable means the read stopped at a form it could not interpret, and no fallback
 * may stand in for it.
 */
type Read<T> =
  | { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' };

const found = <T>(value: T): Read<T> => ({ kind: 'found', value });
const ABSENT = { kind: 'absent' } as const;
const UNREADABLE = { kind: 'unreadable' } as const;

/**
 * The value an object literal gives `property`, absent when it gives none. Members are
 * read from the right because a later one wins, and the read stops at the first member
 * it cannot interpret — anything that is not a property assignment, or a property
 * assignment whose name is neither an identifier nor a string literal.
 *
 * One predicate rather than a case per form, deliberately: the member union is five
 * forms and every one of them can carry the key, so reasoning form by form is how a
 * form gets missed. Anything not read as a name-and-value stops the read.
 *
 * Reporting `UNREADABLE` separately from absent is load-bearing, not bookkeeping. Every
 * caller of a read sits in a fallback chain, and a chain treats absent as permission to
 * try the next level — which is narrower, not wider. Collapsing the two lets a stopped
 * read borrow a narrower root and hand back less reach than the truth, which is the one
 * direction this guard must never fail in.
 */
function propertyValue(block: ts.ObjectLiteralExpression, property: string): Read<ts.Expression> {
  for (const member of block.properties.toReversed()) {
    if (!ts.isPropertyAssignment(member)) return UNREADABLE;
    const name = propertyName(member);
    if (name === undefined) return UNREADABLE;
    if (name === property) return found(member.initializer);
  }
  return ABSENT;
}

/** The name the config gives the object that holds one settings block per project. */
const SETTINGS_DECLARATION = 'PROJECT_SETTINGS';

/** Whether a declaration sits at module scope, where a second one of its name cannot compile. */
function atModuleScope(node: ts.VariableDeclaration): boolean {
  return ts.isSourceFile(node.parent.parent.parent);
}

/**
 * What the module-scope declaration of `name` initializes, absent when there is none.
 * Module scope is the anchor, not an incidental filter: a second declaration of one name
 * cannot compile there, while a shadow inside a function can, so restricting the search to
 * module scope is what makes the answer a fact about the code rather than about the order
 * its declarations happen to appear in. Every name this file resolves goes through here.
 */
function moduleScopeInitializer(source: string, name: string): ts.Expression | undefined {
  for (const node of nodes(source)) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      atModuleScope(node)
    ) {
      return node.initializer;
    }
  }
  return undefined;
}

/** The object literal the settings declaration initializes, absent when it holds none. */
function settingsDeclaration(source: string): ts.ObjectLiteralExpression | undefined {
  const declared = moduleScopeInitializer(source, SETTINGS_DECLARATION);
  return declared !== undefined && ts.isObjectLiteralExpression(declared) ? declared : undefined;
}

/**
 * The value a project's settings block gives `property`, absent when it declares none.
 * Anchored to the settings declaration rather than searching the whole source for a
 * block named for the project: two same-named blocks in one file compile, so an
 * unanchored search would resolve them by file position, while two same-named keys
 * within one object literal do not compile. Anchoring is what makes "one settings
 * block per project" a fact about the code instead of a fact about its layout.
 * A source whose settings the anchor cannot find is unreadable rather than empty: an
 * absent settings block would let the config's own root stand in, and that root can be
 * narrower than the truth.
 */
function settingsValue(source: string, project: string, property: string): Read<ts.Expression> {
  const declaration = settingsDeclaration(source);
  if (declaration === undefined) return UNREADABLE;
  const block = propertyValue(declaration, project);
  if (block.kind !== 'found') return block;
  return ts.isObjectLiteralExpression(block.value)
    ? propertyValue(block.value, property)
    : UNREADABLE;
}

/**
 * A string literal's text. A value that is present but not a string literal is
 * unreadable, never absent — its path is unknown, not unset.
 */
function literalText(value: Read<ts.Expression>): Read<string> {
  if (value.kind !== 'found') return value;
  return ts.isStringLiteral(value.value) ? found(value.value.text) : UNREADABLE;
}

/** The `testDir` a project's settings block declares, absent when it declares none. */
function declaredTestDir(source: string, project: string): Read<string> {
  return literalText(settingsValue(source, project, 'testDir'));
}

/** The string elements of an array literal, ignoring anything else it holds. */
function stringElements(node: ts.ArrayLiteralExpression): string[] {
  return node.elements.flatMap((element) => (ts.isStringLiteral(element) ? [element.text] : []));
}

/**
 * The globs behind a `testIgnore` value, whether written inline or named as a shared
 * constant. A named constant resolves through the module-scope anchor. Every outcome
 * short of a readable array — absent, stopped, imported, computed, or declared only in
 * a nested scope — yields no globs. Exclusions are the one read whose two failure modes
 * agree: no exclusions is more reach either way, so this is the end of a chain rather
 * than a step in one.
 */
function globsOf(source: string, value: Read<ts.Expression>): readonly string[] {
  if (value.kind !== 'found') return [];
  const expression = value.value;
  if (ts.isArrayLiteralExpression(expression)) return stringElements(expression);
  if (!ts.isIdentifier(expression)) return [];
  const declared = moduleScopeInitializer(source, expression.text);
  return declared !== undefined && ts.isArrayLiteralExpression(declared)
    ? stringElements(declared)
    : [];
}

/** The globs a project's settings block excludes. */
function declaredTestIgnore(source: string, project: string): readonly string[] {
  return globsOf(source, settingsValue(source, project, 'testIgnore'));
}

/**
 * The `testDir` an expression configures, unwrapping a `defineConfig(…)`-style wrapper.
 * The wrapper is variadic and a later argument overrides an earlier one key by key, so
 * the last argument declaring `testDir` is the one that takes effect — hence the read
 * from the right. An argument this cannot read stops the read and reports `UNREADABLE`,
 * because it could be the one declaring the key. Reporting it is what makes stopping
 * work: an argument that merely lacks the key must let the loop continue leftward, so
 * the two outcomes have to stay distinguishable all the way out of this function.
 */
function configuredTestDir(expression: ts.Expression): Read<string> {
  const args = ts.isCallExpression(expression) ? expression.arguments : [expression];
  for (const argument of args.toReversed()) {
    if (!ts.isObjectLiteralExpression(argument)) return UNREADABLE;
    const declared = propertyValue(argument, 'testDir');
    if (declared.kind !== 'absent') return literalText(declared);
  }
  return ABSENT;
}

/**
 * The expression the module default-exports, absent when there is none.
 * This is the third anchor and the same idea as the module-scope one, on the uniqueness
 * the compiler enforces here: a module cannot have two default exports, whereas two
 * `defineConfig(…)` calls in one file compile, so searching for the call would let a
 * decoy above the real one decide the answer. Anchoring on the export rather than on the
 * callee's name also drops the assumption that the wrapper is imported unaliased, and
 * reads a config exported as a bare object as readily as a wrapped one.
 */
function defaultExport(source: string): ts.Expression | undefined {
  for (const node of nodes(source)) {
    if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
      return node.expression;
    }
  }
  return undefined;
}

/**
 * The `testDir` the config hands to every project whose own settings declare none.
 * The three device projects declare none, so this decides their reach.
 */
function configTestDir(source: string): Read<string> {
  const exported = defaultExport(source);
  return exported === undefined ? UNREADABLE : configuredTestDir(exported);
}

/**
 * The directory a project draws specs from. Playwright falls back to the config's own
 * directory when neither the project nor the config names one — the widest root there
 * is, so an unparsed config reports more reach rather than less.
 *
 * This is the seam the two reads compose at, and the order matters: only an *absent*
 * project `testDir` may fall through to the config's, because only absence means
 * Playwright would do the same. A read that stopped short-circuits to the widest root
 * instead — falling through would let a narrower config root pose as the answer and
 * report less reach than the truth.
 */
function testRoot(source: string, project: string): string {
  const declared = declaredTestDir(source, project);
  if (declared.kind === 'unreadable') return REPO_ROOT;
  if (declared.kind === 'found') return path.resolve(REPO_ROOT, declared.value);
  const configured = configTestDir(source);
  return configured.kind === 'found' ? path.resolve(REPO_ROOT, configured.value) : REPO_ROOT;
}

/**
 * Whether a project would run the spec at `file`: its root reaches the file and no
 * exclusion matches. Globs are matched against the absolute path and against the
 * path relative to the root, the two forms Playwright accepts.
 *
 * The absolute arm is inert wherever the checkout path holds a dot segment, which
 * it does here: Node's matcher is dot-strict where Playwright's is not, so only the
 * relative arm ever matches. Node being the less permissive of the two can only lose
 * an exclusion, and a lost exclusion reads as more reach and reddens this guard —
 * so making the matcher more permissive to "fix" that would silently weaken it.
 */
function runsSpec(source: string, project: string, file: string): boolean {
  const root = testRoot(source, project);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return false;
  const relative = path.relative(root, file);
  return !declaredTestIgnore(source, project).some(
    (glob) => path.matchesGlob(file, glob) || path.matchesGlob(relative, glob)
  );
}

/** Whether a declared `testDir` resolves inside the directory named for the project. */
function insideOwnDirectory(project: string, testDir: Read<string>): boolean {
  if (testDir.kind !== 'found') return false;
  const own = path.join(REPO_ROOT, 'e2e', project);
  const resolved = path.resolve(REPO_ROOT, testDir.value);
  return resolved === own || resolved.startsWith(`${own}${path.sep}`);
}

describe('E2E_PROJECTS invariants', () => {
  it('exercises every Playwright browser binary', () => {
    const browsers = new Set<string>(E2E_PROJECTS.map((project) => project.browser));
    for (const browser of PLAYWRIGHT_BROWSERS) {
      expect(browsers).toContain(browser);
    }
  });

  it('declares at least one desktop project', () => {
    expect(DESKTOP_PROJECTS.length).toBeGreaterThan(0);
  });

  it('declares at least one mobile project', () => {
    expect(MOBILE_PROJECTS.length).toBeGreaterThan(0);
  });

  it('gives every project a unique name', () => {
    const names = E2E_PROJECTS.map((project) => project.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every seeded project a unique persona code', () => {
    const codes = Object.values(PROJECT_CODE);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('keeps every persona code at two characters', () => {
    for (const code of Object.values(PROJECT_CODE)) {
      expect(code).toHaveLength(2);
    }
  });

  it('nominates exactly one webhook lane', () => {
    const lanes = E2E_PROJECTS.filter((project) => 'webhookLane' in project);
    expect(lanes.map((project) => project.name)).toEqual(['chromium']);
  });

  /**
   * The lane nomination and the desktop carrier order are each pinned on their own;
   * this is the only statement that they must agree. A `@webhook` spec declaring
   * `engine-any` desktop is reachable in exactly one job — every job outside the lane
   * greps `@webhook` away, and every project but the desktop carrier greps the
   * engine-any routing tag away — so moving the lane, or reordering the desktop
   * projects, leaves the spec running in no job at all, with nothing else red to say
   * so. Red here means the duplicate-deposit guard has lost its only end-to-end
   * proof: the registry is what to fix, not this expectation.
   */
  it('nominates the webhook lane on the project the desktop carrier election resolves', () => {
    const run = E2E_PROJECTS.map((project) => project.name);
    const { desktop: carrier } = resolveCarriers(run);
    const lane = E2E_PROJECTS.find((project) => 'webhookLane' in project)?.name;

    expect(carrier).toEqual(expect.any(String));
    expect(lane).toBe(carrier);
  });
});

describe('derived project lists', () => {
  it('splits the engine projects by form factor, in carrier-preference order', () => {
    expect(DESKTOP_PROJECTS).toEqual(['chromium', 'firefox', 'webkit']);
    expect(MOBILE_PROJECTS).toEqual(['iphone-15', 'pixel-7', 'ipad-pro']);
  });

  it('lists the browser matrix as desktop then mobile', () => {
    expect(BROWSER_MATRIX_PROJECTS).toEqual([...DESKTOP_PROJECTS, ...MOBILE_PROJECTS]);
  });

  it('lists the projects that are planes rather than engines', () => {
    expect(PLANE_PROJECTS).toEqual(['admin']);
  });

  it('seeds personas for every project that has a persona code', () => {
    expect(E2E_PROJECT_NAMES).toEqual([
      'chromium',
      'firefox',
      'webkit',
      'iphone-15',
      'pixel-7',
      'ipad-pro',
    ]);
  });

  it('maps each seeded project to its username suffix', () => {
    expect(PROJECT_CODE).toEqual({
      chromium: 'cr',
      firefox: 'ff',
      webkit: 'wk',
      'iphone-15': 'ih',
      'pixel-7': 'px',
      'ipad-pro': 'ip',
    });
  });

  it('names one setup project per seeded project', () => {
    expect(setupProjectName('chromium')).toBe('setup-chromium');
    for (const project of E2E_PROJECT_NAMES) {
      expect(ALL_PROJECT_NAMES).toContain(setupProjectName(project));
    }
  });

  it('names one setup project per plane', () => {
    for (const plane of PLANE_PROJECTS) {
      expect(ALL_PROJECT_NAMES).toContain(setupProjectName(plane));
    }
  });

  it('accepts the admin plane’s setup project as a project of a run', () => {
    const run = resolveRunProjects({
      argv: ['--project=admin', `--project=${setupProjectName('admin')}`],
      runSet: undefined,
      knownProjects: ALL_PROJECT_NAMES,
      isCI: false,
    });

    expect(run).toEqual(['admin', 'setup-admin']);
  });

  it('lists every project name the config defines, setups first', () => {
    expect(ALL_PROJECT_NAMES).toEqual([
      'setup-chromium',
      'setup-firefox',
      'setup-webkit',
      'setup-iphone-15',
      'setup-pixel-7',
      'setup-ipad-pro',
      'setup-admin',
      'admin',
      'chromium',
      'firefox',
      'webkit',
      'iphone-15',
      'pixel-7',
      'ipad-pro',
    ]);
  });

  it('leaves no registry project out of the config name list', () => {
    for (const project of E2E_PROJECTS) {
      expect(ALL_PROJECT_NAMES).toContain(project.name);
    }
  });
});

/**
 * A plane is routed across neither axis: `computeProjectGrepInvert` returns no
 * pattern for it, so every spec its `testDir` reaches runs there unrouted, and
 * the specs under a plane's directory carry no matrix declaration for the same
 * reason. Its `testDir` is therefore the only thing deciding what a plane runs.
 * A testDir reaching past its own directory hands the plane specs the matrix
 * already routes, running them once more outside the carrier election that
 * makes engine-any work singular — which nothing else would report.
 */
describe('plane testDir', () => {
  it('confines every plane to the directory named for it', () => {
    const source = readFileSync(PLAYWRIGHT_CONFIG, 'utf8');
    for (const plane of PLANE_PROJECTS) {
      expect(insideOwnDirectory(plane, declaredTestDir(source, plane)), plane).toBe(true);
    }
  });

  it('refuses a testDir that escapes the directory named for the plane', () => {
    const escaped = declaredTestDir(
      "const PROJECT_SETTINGS = { sample: { testDir: './e2e' } };",
      'sample'
    );
    expect(insideOwnDirectory('sample', escaped)).toBe(false);
  });

  it('refuses a plane that declares no testDir at all', () => {
    const absent = declaredTestDir(
      "const PROJECT_SETTINGS = { sample: { storageState: 'x' } };",
      'sample'
    );
    expect(insideOwnDirectory('sample', absent)).toBe(false);
  });
});

/**
 * The other half of the property the guard above starts. That one keeps a plane's
 * specs inside the directory named for it; this one keeps that directory out of the
 * engine matrix. Both are needed: a spec the matrix routes AND a plane runs executes
 * twice — once under the carrier election, once outside it — and nothing else notices,
 * because running a spec more often than intended fails no gate.
 *
 * Derived from the registry rather than listed: every plane entry demands the
 * exclusion of the directory named for it, so declaring a plane over a directory the
 * matrix already runs fails here without an expectation being edited.
 */
describe('plane directories against the browser matrix', () => {
  /** A direct child and a nested one, so a glob reaching only one depth is caught. */
  const specsUnder = (directory: string): string[] => [
    path.join(directory, 'sample.spec.ts'),
    path.join(directory, 'nested', 'sample.spec.ts'),
  ];

  it('keeps every plane directory out of every project the matrix runs', () => {
    const source = readFileSync(PLAYWRIGHT_CONFIG, 'utf8');
    for (const plane of PLANE_PROJECTS) {
      for (const spec of specsUnder(path.join(REPO_ROOT, 'e2e', plane))) {
        for (const project of BROWSER_MATRIX_PROJECTS) {
          const where = `${project} runs ${path.relative(REPO_ROOT, spec)}`;
          expect(runsSpec(source, project, spec), where).toBe(false);
        }
      }
    }
  });

  it('counts a project that excludes nothing as running the directory', () => {
    const source = "const PROJECT_SETTINGS = { sample: { testDir: './e2e' } };";
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('counts a project whose root falls back to the config as running the directory', () => {
    const source =
      "export default defineConfig({ testDir: './e2e' }); const PROJECT_SETTINGS = { sample: {} };";
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('counts a project with no root anywhere as running the directory', () => {
    const source = 'const PROJECT_SETTINGS = { sample: {} };';
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('reads an exclusion written inline', () => {
    const source =
      "const PROJECT_SETTINGS = { sample: { testDir: './e2e', testIgnore: ['**/admin/**'] } };";
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('reads an exclusion the settings block names as a shared constant', () => {
    const source = [
      "const SHARED = ['**/admin/**'];",
      "const PROJECT_SETTINGS = { sample: { testDir: './e2e', testIgnore: SHARED } };",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('clears a project whose root cannot reach the directory', () => {
    const source = "const PROJECT_SETTINGS = { sample: { testDir: './e2e/chat' } };";
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('reads the settings declaration rather than a same-named block elsewhere', () => {
    const source = [
      "const DECOY = { sample: { testDir: './e2e' } };",
      "const PROJECT_SETTINGS = { sample: { testDir: './e2e/chat' } };",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('yields no root when a spread could replace the testDir it read', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: {} };',
      "export default defineConfig({ testDir: './e2e/chat', ...BASE });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('counts a project whose exclusions a spread could replace as running the directory', () => {
    const source =
      "const PROJECT_SETTINGS = { sample: { testDir: './e2e', testIgnore: ['**/admin/**'], ...BASE } };";
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a spread obscures a later argument', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: {} };',
      "export default defineConfig({ testDir: './e2e/chat' }, { ...BASE });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a spread obscures a project testDir', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: { ...BASE } };',
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a project testDir is not a literal', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: { testDir: ROOT } };',
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a getter supplies the testDir', () => {
    const source = [
      "const PROJECT_SETTINGS = { sample: { get testDir() { return './e2e'; } } };",
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a shorthand supplies the testDir', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: { testDir } };',
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a key is computed rather than written', () => {
    const source = [
      "const PROJECT_SETTINGS = { sample: { ['test' + 'Dir']: './e2e' } };",
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a computed key hides a whole settings block', () => {
    const source = [
      "const PROJECT_SETTINGS = { ['sam' + 'ple']: { testDir: './e2e' } };",
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields the widest root when a settings block is not an object literal', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: BASE };',
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('reads a property declared after every spread', () => {
    const source = "const PROJECT_SETTINGS = { sample: { ...BASE, testDir: './e2e/chat' } };";
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('merges a later argument over an earlier one, which is what the reader assumes', () => {
    expect(defineConfig({ testDir: 'a' }, { testDir: 'b' }).testDir).toBe('b');
  });

  it('takes the last argument that declares testDir, as the wrapper itself does', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: {} };',
      "export default defineConfig({ testDir: './e2e/chat' }, { testDir: './e2e' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields no root when a later argument it cannot read might declare testDir', () => {
    const source = [
      'const PROJECT_SETTINGS = { sample: {} };',
      "export default defineConfig({ testDir: './e2e/chat' }, BASE);",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('yields no root when the only readable argument declares no testDir', () => {
    const source = [
      "const BASE = { testDir: './e2e/chat' };",
      'const PROJECT_SETTINGS = { sample: {} };',
      'export default defineConfig(BASE, { workers: 3 });',
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });

  it('reads the config the module default-exports rather than the first defineConfig call', () => {
    const source = [
      "const DECOY = defineConfig({ testDir: './e2e' });",
      'const PROJECT_SETTINGS = { sample: {} };',
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('reads the module-scope glob constant rather than a shadow inside a function', () => {
    const source = [
      "function decoy() { const SHARED = ['**/mobile/**']; return SHARED; }",
      "const SHARED = ['**/admin/**'];",
      "const PROJECT_SETTINGS = { sample: { testDir: './e2e', testIgnore: SHARED } };",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('reads the module-scope settings declaration rather than a shadow inside a function', () => {
    const source = [
      "function decoy() { const PROJECT_SETTINGS = { sample: { testDir: './e2e' } }; return PROJECT_SETTINGS; }",
      "const PROJECT_SETTINGS = { sample: { testDir: './e2e/chat' } };",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(false);
  });

  it('counts a project as running the directory when no settings declaration is found', () => {
    const source = [
      "const other = { sample: { testDir: './e2e/chat', testIgnore: ['**/admin/**'] } };",
      "export default defineConfig({ testDir: './e2e/chat' });",
    ].join('\n');
    expect(runsSpec(source, 'sample', path.join(REPO_ROOT, 'e2e/admin/x.spec.ts'))).toBe(true);
  });
});
