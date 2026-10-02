# ESLint config-extension slot

This directory is the extension point for the shared ESLint config.
`packages/config/eslint.config.js` automatically loads every file in this
directory matching `*.config.mjs` (via `load-extensions.mjs`) and appends the
entries to the array returned by `createBaseConfig()`. Every package that lints
through `createBaseConfig` therefore picks extensions up automatically — no
consumer config changes needed.

## Contract

- **One file per topic**, named `<topic>.config.mjs`
  (e.g. `boundaries.config.mjs`). Each file owns exactly one concern; edit the
  file that owns your concern, and never edit the loader
  (`load-extensions.mjs`) — add a new topic file instead.
- Each file must **default-export an array** of flat-config entries
  (`import('eslint').Linter.Config[]`).
- Every entry **must scope itself with `files` globs**. Extensions are
  appended after the base config, so for matching files an extension's value
  for a rule key _replaces_ the base config's value — flat config replaces,
  never merges, a rule key. If you override a rule key the base config also
  sets (e.g. `no-restricted-syntax`), re-list the base selectors (see
  `../eslint-parts/`).
- `files` globs resolve against each consuming package's eslint.config.js
  base path. A glob meant for one app's tree must therefore be either
  layout-specific enough not to match other packages, or the rule must
  self-scope by ABSOLUTE filename (see the vendored rules in `rules/`).
- Files are loaded in **lexicographic filename order**, so composition is
  deterministic.
- A broken extension file **fails loudly**: a missing/non-array default export
  or an import-time error breaks every lint run. There is no silent skip — fix
  the file or delete it.
- Vendored rule implementations live in `rules/` as topic-named `.mjs` files
  with colocated `<topic>.test.mjs` suites and `__test-fixtures-<topic>__/`
  fixture trees (anything not matching `*.config.mjs` directly in this
  directory is ignored by the loader).

## Current vendored rules

Topic files are self-documenting (each opens with its rationale). These carry
data an editor must know about:

- `fee-seams` — confines the fee-application helpers (`applyMarkup*` from
  shared money, `applyFees*` from shared pricing) to the sanctioned seams.
  **The seam list is data in exactly one place**: `FEE_APPLICATION_SEAMS` in
  `fee-seams.config.mjs`, each entry carrying the reason it is a seam. Adding a
  seam is a billing-architecture decision (BILLING.md §Fee Structure), not a
  lint fix — the default remedy for a violation is to price over
  already-billable rates instead. There is no second list: the rule has no
  exemptions beyond the seams themselves and test files.
- `no-star-exports` — bans wildcard re-exports that republish a module's own
  declarations, inside the tree named by `STAR_EXPORT_SCOPE_DIR`. A star into a
  barrel that only forwards names stays legal, so most barrels need no entry at
  all. **The exemption list is data in exactly one place**:
  `STAR_EXPORT_EXEMPTIONS` in `no-star-exports.config.mjs`, each entry carrying
  the gate that stands in for enumeration. Adding one asserts that some other
  gate is at least as strong — a surface decision, not a lint fix; the default
  remedy for a violation is to re-export the names explicitly.
- `no-forged-money-input` — refuses values that reach the E2E money vocabulary
  without coming from a read. It exists because the type system **provably**
  cannot express the check: `Object.assign<T, U>` returns `T & U`, which is
  assignable to `T` whatever `T` is branded with; `any` is assignable to
  everything; and `readonly` is ignored in assignability, so a branded field can
  be aliased to a plain-typed binding and written through. It is **type-aware**,
  and asks the type rather than the callee's spelling, in three predicates: an
  argument whose type is `any` or an intersection assembled at the call site; a
  member write through a binding whose initialiser was a branded value; and a
  call into a declaration this codebase does not own that is handed a brand and
  returns one. That is what retired the list of forger names — five successive
  lists were each falsified by the next value nobody had listed. A cast is
  deliberately unpinned, greppable rather than reported. The rule is early
  warning rather than the guarantee: what a forger evades by parking the value
  one token away is refused at runtime by the vocabulary itself, which compares
  only payloads a read registered and freezes what it registers. **The
  vocabulary list is
  data in exactly one place**: `MONEY_VOCABULARY` in
  `no-forged-money-input.config.mjs`, and it is derived rather than curated — a
  colocated test walks the vocabulary's exports through the compiler's checker
  and admits every function that takes a branded value, produces one, or takes
  the context a read is made from, the reads included, since a forged request
  context makes a read mint a brand over numbers nothing served. Both halves of
  that walk are bounded, and the bounds are stated where the list is:
  brandhood is asked of a type's own properties, its union and intersection
  constituents, its type arguments and its numeric index, four levels deep;
  the context arm matches a parameter's own resolved type. Because it is
  bounded, completeness rests on **exhaustion** rather than on the derivation:
  every callable export of the two modules is either derived into
  `MONEY_VOCABULARY` or classified by group into `MONEY_NON_VOCABULARY` beside
  it, and the test fails by name on any export in neither — so a read declared
  in a shape the derivation misses must be classified in a diff instead of
  going silently unprotected. Callees are
  resolved to their imported or destructured names, so an alias does not evade
  it. The remedy for a violation is never to widen the list: a money input comes
  from a read.
- `resolvable-cross-reference` — checks that a cross-reference an author wrote
  in a comment resolves. It is **opt-in by construction, and that is the whole
  of its safety**: it checks a reference already written as `{@link symbolName}`
  or as a backticked path, and never asks whether a comment ought to have used
  either form. A rule that demanded the form would be a style mandate over every
  comment in the repo and would fire hardest on comments naming nothing at all.
  Symbols resolve **by what the file declares** — not through the type checker,
  which would make the lint gate depend on a program-wide type build for a
  comment check — so the property enforced is that a reader of this file can
  find the thing named. **A scope binding is not the whole of that**: a class
  method, an interface or type-literal member and a re-exported name are each
  written in the file the reader is holding while binding no variable, so each
  of them resolves. **The member half reaches exactly as far as an identifier
  key**: a member is read through the key its body node carries, so a member
  kind the parser gains later resolves only if it names itself that way — one
  naming itself any other way contributes nothing, and a reference to it is
  reported. **The line is drawn at declaration, never at text**: a key of an
  object literal or of a destructuring pattern does not resolve, because
  admitting it would resolve a reference against any data row that happens to
  carry the field. A member reference resolves on its leading segment, written
  with either separator (`Foo.bar`, `Foo#bar`); a bare built-in resolves; a
  `{@link}` whose target is a URL is skipped, because a URL is followable on
  its own and being bound here is the wrong question to ask of one.
  **The path form is registered** in `cross-references.config.mjs`. A
  backticked token is checked as a path when it contains a slash and its first
  segment is an entry git tracks at the repository root, or when it has no
  slash and names a file git tracks, or has tracked, at the root. A token that
  begins with a dash, or carries a glob star or an angle-bracket placeholder,
  is never a path; a trailing `:line` is stripped, so the line is never
  checked. A checked token resolves against what git tracks, never the working
  tree. A correct citation that cannot resolve, such as build or run output,
  carries an `eslint-disable-next-line` for its one line with the reason after
  `--`. Git history may not be clear or complete, as in a shallow clone, so a
  citation of a long-deleted root file can pass; that is acceptable. An
  unreadable git index or history raises: run the gate inside a git working
  tree with at least one commit.

## Why this exists

Multiple lint concerns land in the same shared config. Without an append-only
slot they would all edit `eslint.config.js` and conflict. With it, each
concern ships exactly one topic file here.
