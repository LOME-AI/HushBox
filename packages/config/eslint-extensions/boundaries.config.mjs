// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import boundaries from 'eslint-plugin-boundaries';
import { apiLibraryDirectoriesGlobGroup } from '../eslint-parts/api-library-directories.mjs';
import { TEST_FILE_GLOB } from '../test-file-spellings.ts';

/**
 * Architectural boundaries for the whole product Worker source tree.
 *
 * Every governed file under `apps/api/src` resolves to exactly one of six
 * elements: `slices` (sub-layered into routes, domain, ports, adapters,
 * `public/`, the barrel, and a catch-all for every other module sitting
 * directly at the slice root), `lib`, `middleware`, `composition`, `dev` and
 * `test-support`. Governed means selected by the `files` glob below and not
 * dropped by `ignores`, so the claim is about the governed files and not about
 * every file on disk. Both trees `ignores` names are still CLASSIFIED, and what
 * separates them is which element they land in. A slice-template module
 * classifies as the layer it sits in — one under the template's `domain/`
 * reports as `slice-domain` of slice `_template` — so it is reached, or
 * refused, on exactly the terms that layer meets anywhere else. A test-file
 * spelling classifies as `test-file`.
 *
 * Two rules hold that perimeter, one per direction. `boundaries/dependencies`
 * under `default: 'disallow'` refuses an import whose TARGET matches no
 * descriptor, so nothing governed can reach an unnamed tree.
 * `boundaries/no-unknown-files` refuses a governed FILE that matches no
 * descriptor, so a new top-level directory — or a new directory under `lib/`,
 * whose element is an enumerated registry rather than a tree glob — cannot sit
 * there ungoverned either. The first rule alone leaves such a directory
 * unreachable but unclassified, and leaves `ignores` and the descriptor set
 * agreeing only because they happen to spell the same files.
 *
 * Each `boundaries/dependencies` rule below is described by the `//` comment
 * directly above it, in the doctrine sentence it reads as.
 * Their order is load-bearing: the LAST matching rule wins, which is why the
 * broad allows come first and the targeted disallows come last, so every
 * later rule's "only" is about our own trees.
 *
 * What the mechanism cannot see is a symbol: an element matches by path, so a
 * module re-exported from a slice barrel is the barrel as far as these rules
 * go. It also cannot see outside the trees named below — an import that leaves
 * them fails as an unknown local.
 */

// eslint-plugin-boundaries anchors element patterns to process.cwd() unless
// `boundaries/root-path` is set, and `**` never crosses the repo root from a
// package cwd — so under turbo (which lints each package with the package dir
// as cwd) a workspace-package import resolving to ../../packages/*/src would
// classify as an unknown local. Anchor matching to the repo root, derived from
// this file's own location (packages/config/eslint-extensions/) so the value
// is machine-independent.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Module patterns for the infra clients. Which layers they are kept out of is
 * stated by the disallow that names this constant.
 */
const INFRA_MODULES = [
  '@neondatabase/*',
  '@upstash/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'ioredis',
  'redis',
  'postgres',
  'pg',
  'aws4fetch',
  'resend',
];

const LIB_GLOB = `**/src/lib/${apiLibraryDirectoriesGlobGroup}/**/*`;

/**
 * Element layers. Order matters: the first matching descriptor wins, so the
 * specific file-level types (routes, barrels) precede the directory catch-alls
 * and `slice-other` stays last among slice patterns.
 */
const elements = [
  // A test-spelled module is classified as one wherever it sits — ahead of
  // every other descriptor because each of them would otherwise classify it as
  // the layer it happens to sit in, and a module the `ignores` entry below
  // releases from the import rules would go on being an ordinary target for the
  // code those rules still bind. What may reach it is settled by the rules
  // below, in the disallow that names `test-file` as a target.
  { type: 'test-file', mode: 'full', pattern: [TEST_FILE_GLOB] },
  {
    type: 'slice-routes',
    mode: 'full',
    pattern: ['**/src/slices/(*)/routes.ts', '**/src/slices/(*)/routes/**/*.ts'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-domain-barrel',
    mode: 'full',
    pattern: ['**/src/slices/(*)/domain/index.ts'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-domain',
    mode: 'full',
    pattern: ['**/src/slices/(*)/domain/**/*'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-ports',
    mode: 'full',
    pattern: ['**/src/slices/(*)/ports/**/*'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-adapters',
    mode: 'full',
    pattern: ['**/src/slices/(*)/adapters/**/*'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-barrel',
    mode: 'full',
    pattern: ['**/src/slices/(*)/index.ts'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-public',
    mode: 'full',
    pattern: ['**/src/slices/(*)/public/**/*'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-other',
    mode: 'full',
    pattern: ['**/src/slices/(*)/*'],
    capture: ['base', 'slice'],
  },
  { type: 'lib', mode: 'full', pattern: [LIB_GLOB] },
  { type: 'middleware', mode: 'full', pattern: ['**/src/middleware/**/*'] },
  // The rest of the API tree. These patterns name `apps/api` rather than a
  // bare `src/` because they are directory names other packages also use
  // (`workers-validation` exists under two of them), and a descriptor that
  // reached into a workspace package would classify it as backend
  // composition. Everything below is a pure pattern — none of them capture,
  // so none of them can express a same-tree equality.
  {
    type: 'composition',
    mode: 'full',
    pattern: ['**/apps/api/src/composition/**/*', '**/apps/api/src/{app,entry,index,scheduled}.ts'],
  },
  { type: 'dev', mode: 'full', pattern: ['**/apps/api/src/dev/**/*'] },
  // `workers-validation/` holds only test files today; naming it keeps a
  // future non-test file there classified instead of unknown.
  {
    type: 'test-support',
    mode: 'full',
    pattern: ['**/apps/api/src/{test-support,smoke,workers-validation}/**/*'],
  },
  // Workspace packages (@hushbox/*) resolve into packages/*/src; classify them
  // so cross-package imports stay allowed instead of failing as unknown locals.
  {
    type: 'internal-package',
    mode: 'full',
    pattern: ['**/packages/(*)/src/**/*'],
    capture: ['base', 'pkg'],
  },
];

const SAME_SLICE = { slice: '{{ from.captured.slice }}' };

/**
 * The element types backend code is written in, slice layers included.
 * Named once so the broad external/workspace-package allows below stay one
 * list rather than a list plus a copy that drifts from it.
 */
const BACKEND_TYPES = '(slice-*|lib|middleware|composition|dev|test-support)';

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    // `files` patterns resolve against the base path, and every package lints
    // itself with `eslint .` from its own root — so a pattern naming
    // `apps/api` matches nothing under the invocation turbo actually makes.
    // Pinning the base path to the repo root is what lets the whole API tree
    // be selected by name; without it the glob would have to be a set of
    // directory names, and `src/index.ts` alone would drag every workspace
    // package's barrel into the perimeter.
    basePath: REPO_ROOT,
    files: [
      '**/apps/api/src/**/*.ts',
      '**/src/slices/**/*.ts',
      `${LIB_GLOB}.ts`,
      '**/src/middleware/**/*.ts',
    ],
    // A test file here is named by the declaration the arch layer's
    // `isTestFile` reads, so the two gates release the same files. Spelling the
    // exemption for itself is how they drifted before: scaffolding governed by
    // one gate and exempt from the other reads as an arbitrary result to
    // whoever meets it. It is also the glob the `test-file` element carries,
    // which is what keeps every file released here refused as a target — the
    // two halves of one exemption cannot name different files.
    ignores: [TEST_FILE_GLOB, '**/src/slices/_template/**'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': REPO_ROOT,
      'boundaries/elements': elements,
      'boundaries/dependency-nodes': ['import', 'export', 'dynamic-import'],
      'import/resolver': { typescript: {} },
    },
    rules: {
      // Classification is enforced, not measured: a governed file that no
      // descriptor names is a hole in the perimeter and fails here. This is the
      // source direction of the property `boundaries/dependencies` enforces on
      // targets, and it is what stops `ignores` and the descriptor set from
      // drifting apart unnoticed.
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkAllOrigins: true,
          checkUnknownLocals: true,
          rules: [
            // Boundaries govern our own trees, not the npm and node surface —
            // apart from `INFRA_MODULES`, whose exception is the disallow that
            // names that constant...
            {
              from: { type: BACKEND_TYPES },
              allow: { to: { origin: '(external|core)' } },
            },
            // ...and a workspace package is shared code, open to every backend
            // tree. What it does not open is a workspace-package module carrying
            // a test spelling: `test-file` precedes `internal-package` in the
            // element list, so such a module classifies as the former and this
            // grant never names it.
            {
              from: { type: BACKEND_TYPES },
              allow: { to: { type: 'internal-package' } },
            },
            // A barrel publishes its own slice, and nothing else.
            {
              from: { type: 'slice-barrel' },
              allow: { to: { type: 'slice-*', captured: SAME_SLICE } },
            },
            // Routes hold no business logic: the domain barrel and the pipeline are
            // the whole of what they see, plus the rest of their own slice's
            // routes — a slice whose routes are a directory of group modules
            // mounted by one manifest registers each group beside the helpers it
            // shares, which is the unit the route-proof arch rules read.
            {
              from: { type: 'slice-routes' },
              allow: {
                to: [
                  { type: 'slice-domain-barrel', captured: SAME_SLICE },
                  { type: 'slice-routes', captured: SAME_SLICE },
                  { type: 'middleware' },
                ],
              },
            },
            // Domain reaches other slices only through what they publish.
            {
              from: { type: '(slice-domain|slice-domain-barrel)' },
              allow: {
                to: [
                  {
                    type: '(slice-domain|slice-domain-barrel|slice-ports)',
                    captured: SAME_SLICE,
                  },
                  { type: 'slice-barrel' },
                  { type: 'lib' },
                ],
              },
            },
            // A port is an interface, so it depends on nothing it could be an
            // implementation of.
            {
              from: { type: 'slice-ports' },
              allow: {
                to: [{ type: 'slice-ports', captured: SAME_SLICE }, { type: 'lib' }],
              },
            },
            // Adapters implement their own slice's ports. The infra clients they
            // hold arrive through the broad external allow; which layers those
            // clients are kept out of is stated by the disallow that names
            // `INFRA_MODULES`.
            {
              from: { type: 'slice-adapters' },
              allow: {
                to: [
                  { type: '(slice-ports|slice-adapters)', captured: SAME_SLICE },
                  { type: 'lib' },
                ],
              },
            },
            // A slice module at the slice root, outside the named layers, sees
            // all of its own slice, and other slices only through published
            // doors: this rule allows the barrel, and the `slice-public` grant
            // allows the narrow door.
            {
              from: { type: 'slice-other' },
              allow: {
                to: [
                  { type: 'slice-*', captured: SAME_SLICE },
                  { type: 'slice-barrel' },
                  { type: 'lib' },
                  { type: 'middleware' },
                ],
              },
            },
            // A slice publishes two doors, not one: the barrel (everything the
            // slice offers, in one module) and `public/` entry modules (one
            // capability each). The `from` list is derived, not chosen — it is
            // exactly the element types whose own rule allows an unqualified
            // `slice-barrel` by naming it, so the narrow door is reachable
            // from nowhere the wide one is not; `dev` and `test-support`
            // reach both doors through their own reach-everything rule
            // instead. The permission is stated over
            // element types, never over which slice may reach which, so no
            // pair holds a privilege another lacks. A slice barrel is
            // deliberately absent: it reaches only its own slice, which
            // already includes its own `public/`, and re-exporting a foreign
            // capability would advertise one slice's surface as another's — a
            // laundering that forms no cycle, so no cycle gate catches it.
            {
              from: {
                type: '(slice-domain|slice-domain-barrel|slice-other|middleware|composition)',
              },
              allow: { to: { type: 'slice-public' } },
            },
            // What makes the narrow door narrow: a `public/` module reaches its
            // own slice's insides and lib, so importing one never drags a foreign
            // slice in behind it. That set excludes its own `routes.ts` and its
            // own barrel; reaching the barrel would make the fine entry point
            // aggregate exactly what the barrel does.
            {
              from: { type: 'slice-public' },
              allow: {
                to: [
                  {
                    type: '(slice-domain|slice-domain-barrel|slice-ports|slice-adapters|slice-other|slice-public)',
                    captured: SAME_SLICE,
                  },
                  { type: 'lib' },
                ],
              },
            },
            // lib is the floor the trees stand on, so it stands only on itself.
            { from: { type: 'lib' }, allow: { to: { type: 'lib' } } },
            // Middleware reaches slices only through published doors: this rule
            // allows the barrel, and the `slice-public` grant allows the narrow
            // door.
            {
              from: { type: 'middleware' },
              allow: {
                to: [{ type: 'lib' }, { type: 'middleware' }, { type: 'slice-barrel' }],
              },
            },
            // The composition root wires slices only through their published
            // doors — the barrel named here, a `public/` module through the
            // door grant that names the same element type. Slice `domain/`,
            // `ports/` and `adapters/` stay out of reach, so "cross-slice work
            // goes through a published API" holds for the wiring tree too.
            {
              from: { type: 'composition' },
              allow: {
                to: [
                  { type: 'slice-barrel' },
                  { type: 'lib' },
                  { type: 'middleware' },
                  { type: 'composition' },
                ],
              },
            },
            // Composition mounts the dev manifest unconditionally; the
            // barrier is the `dev-only` route class, which answers 404 in
            // production, not an env gate on the mount. This is the one
            // production element that may name `dev` at all.
            {
              from: { type: 'composition' },
              allow: { to: { type: 'dev' } },
            },
            // Dev tooling and test scaffolding compose the tree by design, so
            // they reach all of it bar one element, which the override after
            // this rule names. What makes them unreachable in return is that
            // no production rule names them as a target, bar the allow that
            // names `dev` — the exclusion is the absence of a rule under
            // `default: 'disallow'`, not an exception list someone has to
            // maintain.
            //
            // Paths are all this mechanism can see. A dev fixture published
            // on a slice barrel is, to the plugin, the same file as the rest
            // of that barrel, so nothing here keeps production code from
            // importing a dev-only symbol through a slice's published door;
            // that is enforced in the arch layer, which resolves re-exports
            // back to their declaring file.
            {
              from: { type: '(dev|test-support)' },
              allow: { to: { type: '*' } },
            },
            // Targeted override (later wins): a test-spelled module is the one
            // element the wildcard above must not carry. `dev` is
            // production-reachable through the composition → dev edge, so
            // anything it names ships; and a module `test-support` has to
            // import is one whose consumers are not only tests, which is the
            // claim the name makes. No other element needs saying, because
            // every element the perimeter refuses it refuses by naming no rule
            // at all — a wildcard is the one grant that cannot be narrowed
            // that way.
            {
              from: { type: '(dev|test-support)' },
              disallow: { to: { type: 'test-file' } },
            },
            // Targeted override (last wins): an infra client never appears in a
            // slice layer other than `adapters/`, the one layer the doctrine
            // opens to it. `import type` is not spelled as an exception here
            // because the ban is about whose shapes a layer's contract is
            // written in, which an erased import settles the same way a live
            // one does; the plugin can express the distinction
            // (`dependency: { kind }`), so its absence is the answer, not an
            // oversight.
            {
              from: {
                type: '(slice-routes|slice-domain|slice-domain-barrel|slice-ports|slice-barrel|slice-public|slice-other)',
              },
              disallow: { to: { origin: 'external' }, dependency: { module: INFRA_MODULES } },
            },
          ],
        },
      ],
    },
  },
];
