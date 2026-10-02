import { ts } from 'ts-morph';
import { moduleReferences } from '../lib/module-references.js';
import { isLocalSpecifier, isTestFile } from '../lib/paths.js';
import { WEB_SOURCE_TREE } from '../lib/source-scope.js';
import type { ModuleReferenceForm } from '../lib/module-references.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Pins the interactive product demo out of the production main chunk. The demo
 * boots the real app with a faked logged-in session and a global network shim
 * (`demo/seed-session`, `demo/mock-backend/fetch-shim`); it is isolated only by
 * `main.tsx`'s `isDemoPath`-gated DYNAMIC `import()`, which code-splits the
 * whole `demo/**` tree into a lazy chunk that never loads for real users.
 * Nothing structural stops a future refactor from linking that tree into
 * production code by some other spelling and silently bundling the fake-auth
 * bypass into the main chunk. This rule makes every such link an error.
 *
 * WHAT IS REFUSED IS DERIVED RATHER THAN LISTED: every form the shared walk
 * (`packages/config/arch/lib/module-references.ts`) reads as LINKING a module,
 * less the one form the module system DEFERS. `import(…)` hands back a promise
 * for a chunk of its own, and that deferral is the mechanism this rule exists to
 * protect, so it is the single exclusion; every other form the walk names binds
 * its target into this module and is refused whatever spelling it arrives in.
 * Iterating the two declaration getters instead — which this rule did while its
 * subject was declarations alone — read neither `import d = require('…/demo/…')`
 * nor a bare `require('…/demo/…')`, each invisible for the reason any pattern
 * list is one emission behind the language.
 *
 * A form the walk names with NO specifier is passed over. A module loader that
 * escaped into a value names no module for this rule to resolve, and it bundles
 * none either: `require` links nothing at build time in a browser bundle, which
 * is where this rule's subject lives.
 *
 * `import.meta.glob` is read HERE rather than by the walk, which owns the module
 * system's forms and says so. A glob binds no module; Vite EXPANDS it at build
 * time into edges of its own, which makes it a bundler form and this rule's own
 * subject. What is read is bounded by what Vite expands — the callee written
 * exactly {@link GLOB_CALLEE}, whose pattern argument is a literal or an array of
 * them — every other spelling being refused at build as `Invalid glob import
 * syntax` and at runtime as a name that was not statically replaced. So a
 * spelling this misses is a spelling that does not build. Both the eager and the
 * lazy glob are refused: a lazy one still names the demo tree from production
 * code with no `isDemoPath` gate ahead of it, and which of the two a call is can
 * be written in an options object no syntax reads.
 *
 * A GLOB REACHES the demo tree when it writes the directory's name outright — a
 * whole `demo` path segment, the reading a module specifier gets — or when a
 * wildcard of its stands where that directory stands, which only anchoring the
 * pattern where the bundler anchors it answers. The second reading is why
 * `import.meta.glob('@/**')` is refused and `import.meta.glob('./routes/*')` is
 * not, and its residue is fail-closed and worth naming: a wildcard landing on
 * the demo directory's own segment is refused even where the pattern would
 * enumerate files beside that directory rather than descend into it.
 *
 * Scope (production web code) excludes:
 *   - demo-internal files (`apps/web/src/demo/**`) — a demo file linking another
 *     demo file is the intended shape, already inside the lazy chunk.
 *   - test files — they import demo internals to test them in isolation.
 *   - everything outside `apps/web/src/`.
 * The `is-demo-path` helper (`apps/web/src/lib/platform/is-demo-path.ts`) is NOT the demo
 * directory: a specifier targets the demo tree only when a whole path segment is
 * exactly `demo`, so `@/lib/platform/is-demo-path` (segment `is-demo-path`) never matches.
 */

/**
 * This rule watches the web tree; WHERE that tree is comes from the scope
 * layer, so the root cannot be narrowed here by retyping it.
 */
const WEB_SRC = WEB_SOURCE_TREE;
const DEMO_DIR = `${WEB_SOURCE_TREE}demo/`;

/**
 * The form `import(…)` is reported under: the one form the module system defers
 * to a chunk of its own, and so the one this rule passes over.
 */
const DEFERRED_FORM: ModuleReferenceForm = 'dynamic-import';

/**
 * The callee Vite expands, written as Vite reads it. Its own reading is textual
 * — a regular expression over the source, in `parseImportGlob`'s caller — so
 * comparing the callee's text is that same test rather than a second one, and a
 * spelling it declines is a spelling the build declines.
 */
const GLOB_CALLEE = 'import.meta.glob';

/** A glob segment matching any number of path segments, the demo tree included. */
const DEEP_WILDCARD = '**';

/**
 * Glob constructs beyond `*` and `?`: brace lists, extglob groups, character
 * classes. A segment writing one is taken as matching, so a construct this
 * matcher does not read closes the gate rather than opening it.
 */
const UNREAD_GLOB_CONSTRUCT = /[{}()[\]+@]/;

const MESSAGE =
  'Production code must not link the demo tree (apps/web/src/demo/**) into the ' +
  "production bundle — it loads only via main.tsx's dynamic import() so the " +
  'fake-session bypass stays out of the production bundle.';

/** Production web code: inside apps/web/src, not a demo-internal or test file. */
function isProductionWebFile(filePath: string): boolean {
  return filePath.includes(WEB_SRC) && !filePath.includes(DEMO_DIR) && !isTestFile(filePath);
}

/** Path segments with the empty, `.` and `..` ones resolved away. */
function normalize(segments: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved;
}

const WEB_SRC_SEGMENTS = normalize(WEB_SRC.split('/'));
const DEMO_SEGMENTS = normalize(DEMO_DIR.split('/'));

/**
 * Where Vite anchors a root-absolute glob: the project root, which for this app
 * is the package directory its Vite config sits in — the parent of the source
 * tree the scope layer discovered, so it is derived from that root rather than
 * retyped beside it.
 */
const PROJECT_ROOT_SEGMENTS = WEB_SRC_SEGMENTS.slice(0, -1);

/**
 * A relative (`.`) or `@/`-alias specifier whose path resolves into the demo
 * directory — identified by a whole `demo` path segment, so `is-demo-path`
 * (segment `is-demo-path`) is excluded.
 *
 * Undefined stands for a form that names no module — `export { x }`, or a loader
 * that escaped into a value — which links nothing and so bundles nothing.
 */
function targetsDemoDirectory(specifier: string | undefined): boolean {
  return (
    specifier !== undefined && isLocalSpecifier(specifier) && specifier.split('/').includes('demo')
  );
}

/** The scanned file's own directory, written from the web workspace down. */
function directoryOf(filePath: string): string[] {
  return normalize(filePath.slice(filePath.indexOf(WEB_SRC)).split('/').slice(0, -1));
}

/**
 * A pattern anchored where the bundler anchors it: the alias at the web source
 * root, a root-absolute pattern at the project root, a relative one at the
 * directory of the file that writes it. Any other rooting names a package rather
 * than a path in this tree, and is anchored nowhere.
 */
function anchoredPattern(pattern: string, from: readonly string[]): string[] | undefined {
  if (pattern.startsWith('@/')) {
    return normalize([...WEB_SRC_SEGMENTS, ...pattern.slice(2).split('/')]);
  }
  if (pattern.startsWith('/')) return normalize([...PROJECT_ROOT_SEGMENTS, ...pattern.split('/')]);
  if (pattern.startsWith('.')) return normalize([...from, ...pattern.split('/')]);
  return undefined;
}

/** Whether one glob segment can expand to the directory name it stands against. */
function segmentMatches(segment: string, name: string): boolean {
  if (UNREAD_GLOB_CONSTRUCT.test(segment)) return true;
  const source = segment
    .replaceAll(/[.^$|\\]/g, String.raw`\$&`)
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]');
  return new RegExp(`^${source}$`).test(name);
}

/**
 * Whether an anchored pattern can name a path inside the demo directory: every
 * segment standing against one of that directory's own expands to it, and a
 * {@link DEEP_WILDCARD} reaching that far absorbs the rest and descends. A
 * pattern shallower than the directory itself reaches nothing below it.
 */
function reachesDemoDirectory(anchored: readonly string[]): boolean {
  for (const [index, name] of DEMO_SEGMENTS.entries()) {
    const segment = anchored[index];
    if (segment === undefined) return false;
    if (segment === DEEP_WILDCARD) return true;
    if (!segmentMatches(segment, name)) return false;
  }
  return true;
}

/**
 * Whether one glob pattern enumerates the demo tree. A `!`-prefixed pattern
 * excludes what it matches, so it enumerates nothing.
 */
function globReachesDemoDirectory(pattern: string, from: readonly string[]): boolean {
  if (pattern.startsWith('!')) return false;
  if (targetsDemoDirectory(pattern)) return true;
  const anchored = anchoredPattern(pattern, from);
  return anchored !== undefined && reachesDemoDirectory(anchored);
}

/**
 * The patterns one call enumerates at build time, empty for a call Vite does not
 * expand into module edges.
 */
function globPatterns(node: ts.CallExpression, file: ts.SourceFile): readonly string[] {
  if (node.expression.getText(file) !== GLOB_CALLEE) return [];
  const [first] = node.arguments;
  if (first === undefined) return [];
  const written: readonly ts.Expression[] = ts.isArrayLiteralExpression(first)
    ? first.elements
    : [first];
  return written
    .filter((element): element is ts.StringLiteralLike => ts.isStringLiteralLike(element))
    .map(({ text }) => text);
}

/** Every glob in one file that enumerates the demo tree, one violation per call. */
function globViolations(file: ts.SourceFile, filePath: string): ArchViolation[] {
  const from = directoryOf(filePath);
  const violations: ArchViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      globPatterns(node, file).some((pattern) => globReachesDemoDirectory(pattern, from))
    ) {
      violations.push({
        file: filePath,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        message: MESSAGE,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return violations;
}

function demoBundlingViolations(sourceFile: SourceFile): ArchViolation[] {
  const filePath = sourceFile.getFilePath();
  const linked = moduleReferences(sourceFile.compilerNode)
    .filter(({ form, specifier }) => form !== DEFERRED_FORM && targetsDemoDirectory(specifier))
    .map(({ line }) => ({ file: filePath, line, message: MESSAGE }));
  return [...linked, ...globViolations(sourceFile.compilerNode, filePath)];
}

const rule: ArchRule = {
  name: 'demo-isolation',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isProductionWebFile(sourceFile.getFilePath())) continue;
      violations.push(...demoBundlingViolations(sourceFile));
    }
    return violations;
  },
};

export default rule;
