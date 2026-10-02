# Testing

How tests are written and run in this repo. The binding rules — test-first, 95% per-file
coverage, integration-first, no mocks for internal slices — are in `docs/CODE-RULES.md`
§Testing and `docs/AGENT-RULES.md` §Test-Driven Development; this doc carries the
mechanics those rules assume. Playwright E2E rules live in `e2e/CLAUDE.md`.

## Running tests

`pnpm test` runs everything and the coverage gate: a per-file coverage shortfall fails
the run. Cache-missed packages execute as one consolidated vitest batch sharing a global
worker pool; the scheduling mechanism is `docs/TASK-ORCHESTRATION.md`.

- `pnpm test:<package>` — `api`, `web`, `admin`, `shared`, `db`, `crypto`, `ui`,
  `realtime`, `config`, `scripts`, `docket` — filters the batch to that package.
  `pnpm test:pkg <name>` does the same for any package name. Whether a package runs
  inside the batch or scoped on its own is the coordinator's answer, never the
  caller's: the package's `test` script registers with the coordinator, which holds
  an expected registrant for the batch's verdict and tells any other registrant to
  run itself scoped. The solo path is the package's own `test` script with no batch
  in flight — `cd <pkg> && pnpm run test` (§Scripts self-wrap in the env loader).
- `pnpm test:watch <test-file>` and `pnpm test:file <test-file> [<test-file>...]` are
  the red-green cycle's commands; `docs/DEVELOPMENT.md` §Commands states them and the
  lower-bound reading of a narrowed coverage figure. Both take the test file's path —
  a bare argument must exist on disk; a substring goes behind `pnpm test:watch`'s
  `--path-filter`. `pnpm test:file` measures the module that sits beside each named
  test file under the name the test extends (`payments.ts` for
  `payments.integration.test.ts`); a test file with no such sibling — one driving a
  script, for example — is refused before anything runs, and `--source <path>` names
  the module to measure instead.
- Outside `pnpm test:file`, coverage scope is the package's whole source set however
  few test files run, so a coverage run narrowed by hand reports 0% for every source
  file the selected tests never load. A package's `test` script refuses test files
  named on its command line: vitest unions a named file with the package filter the
  script passes, so the request would silently widen to the whole package, and the
  script cannot narrow instead — its per-file thresholds would fail every source the
  subset leaves unexercised. Name the file to `pnpm test:watch` or `pnpm test:file`.
- A `*.workers.test.ts` file runs under workerd through the package's `test:workers`
  script, which the package `test` script launches beside the node suite and whose
  failure fails the task — so `pnpm test` and `pnpm test:<package>` gate it. It exists
  to pin what only workerd can observe; logic belongs in the node project, which
  carries the coverage gate. The node vitest config excludes those files and the
  red-green commands read only that config, so neither `pnpm test:watch` nor
  `pnpm test:file` runs one: run `pnpm test:workers` from the package for the cycle.
- A **pole** — a single test file over 50% of its package's test-work and at least
  15 seconds — fails the run. Test-work is the file's span in the vitest JSON
  report: its first test's start to its last test's end, so everything between
  counts — a nested suite's `beforeAll` included — and nothing before the first
  test does: imports, a top-level `beforeAll` (`scripts/lib/test-run/test-report.ts`).
  The sum of a file's per-test durations reads lower, so judge a pole by the span,
  never by adding up its tests. Split the file into smaller test files.
- Browser-mode vitest tests launch a real Playwright browser. Run `pnpm e2e:browsers`
  once per machine, and again after a Playwright upgrade; browser binaries are not
  something `pnpm install` delivers. A `browserType.launch: Executable doesn't
exist` failure is that missing install, or a run outside the pnpm scripts: a raw
  `pnpm exec turbo test` fails this way with the browsers installed. CI installs
  Chromium and Firefox only, so a
  vitest file launching WebKit passes locally and fails in CI until the workflow's
  install step names it.

Two packages share the word docket: `@hushbox/docket` is the finding-format library
(`packages/docket`); the console app is `@hushbox/docket-console` (`apps/docket`). A
`:pkg` script aimed at the wrong one runs green without touching the code you meant.

### Scripts self-wrap in the env loader

Every package `test` script wraps itself in `scripts/with-env.ts`, which resolves the
repo root from its own file path and starts the local stack on demand — the first
command of a session may start Docker containers. `cd <pkg> && pnpm run test` therefore
works from any cwd. The `pnpm test*` commands in `docs/DEVELOPMENT.md` §Commands are
workspace-root scripts and exist only at the root: run from inside a package, pnpm
reports the script as not found. A raw `npx vitest` gets no env and fails with `No test files found`
or a `DATABASE_URL` error, both of which read like a broken package; run the package
script instead.

A command that claims a run or starts the stack listens on a unix socket under the
temporary directory it inherits, and a socket address must fit the platform's
socket-path limit — about a hundred bytes, of which the temporary directory is most.
A deep `TMPDIR` (a per-session scratch directory, for example) is therefore refused
before anything starts, with a message naming the directory; point the temporary
directory at a shallow root. `scripts/lib/spawn/long-lived.ts` states the limit.

## Writing tests

- Integration tests run against the real local Postgres, Redis and MinIO. Mocks exist
  only at true external seams (model gateway, payments, email, push), never for an
  internal slice.
- AI calls ride record-on-miss cassettes: an unchanged request replays from the cache; a
  changed request makes one real call on the spend-restricted key and records it for the
  next run. Mechanism: `docs/CI-CASSETTES.md`.
- Tests are independent of execution order.
- A real-browser test in `apps/web` starts its Vite server through `startFixtureServer`
  (`apps/web/src/test-utils/fixture-server.ts`), which gives it a private dependency cache:
  a Vite server on a shared cache deletes another running server's pre-bundled
  dependencies, the dev server's included. Any other Vite server a test or a probe starts
  takes an absolute `cacheDir` outside the repository; a relative one resolves against the
  server's `root` and writes into the tree. The arch rule
  `test-vite-servers-name-their-cache` refuses a test's `createServer` that names no
  `cacheDir`.
- Every instant a test needs comes from the shared test-time module
  (`packages/shared/src/testing/test-time.ts`), with the clock mocked to it. The privacy
  gate draws the line by predicate (`scripts/lib/privacy/instants.ts`): a literal date on
  a UTC day boundary discloses no time of day and is admitted; anything finer is flagged.
  The gate reads committed bytes, so a disclosing value assembled from fragments joined
  at run time passes it unread; fragmenting a value to keep a source green is the
  violation, not a workaround — an instant is obtained from the test-time module, never
  spelled and never fragmented. The gate's own fixtures are the one exception: a match
  has to exist for the detector to read, so those sources assemble it at run time, and
  they are the only sources anything that runs holds to it (`OWNED_TEST_SOURCES` in
  `scripts/lib/privacy/allowlist.test.ts`); everywhere else this is a rule review applies.
- Component tests render into happy-dom with `@testing-library/jest-dom`, and no
  stylesheet reaches that DOM: vitest's `css` option stays at its default (off) and no
  setup file imports one. A matcher that reads computed style — `toBeVisible()` —
  therefore cannot see a Tailwind class: `hidden`, `sr-only` and `opacity-0` have no
  observable effect, so `toBeVisible()` passes on an element they hide and
  `.not.toBeVisible()` fails on it, with the class or without. Assert a visibility
  class as a class, and attribute-backed state
  (`toBeDisabled`, `toBeChecked`, `toHaveAttribute`) through the attribute. A test that
  needs a real cascade injects its own stylesheet into `document.head`, as the
  accessibility style tests in `packages/ui` do.
- Test behaviour, not implementation.
- A test that runs and cannot fail is the defect `docs/CODE-RULES.md` §Testing names for
  a test that cannot run, wearing a green tick. A negative assertion
  ("the output contains no X") moves with the change that makes X unwriteable, and the
  test then shows it still bites — a fixture that would emit X reddens it. An assertion
  an empty page satisfies — a zero count, an absent element — follows, in the same test,
  one that proves the page drew what the denial is about. A mock's call record holds
  only the current test's calls: the shared vitest config
  (`packages/config/vitest.config.ts`) sets `mockReset`, which empties every mock's
  record before each test. An assertion that nothing was called since `beforeAll` or an
  earlier test therefore passes whatever the code did. Count such calls in a variable
  the file owns, and give each call a distinct answer so a repeat shows in what the
  caller received, as the cassette-scope pin in
  `apps/api/src/slices/models/adapters/integration.setup.test.ts` does.
- In `@hushbox/scripts`, every test file is armed with a guard that fails the file
  when its final teardown finds `HB_RUN_CLAIM` other than as the file received it
  (`scripts/lib/vitest/run-claim-restored.ts`): a suite that registers a run of its
  own must start from no claim, and a hook that clears the variable puts back what it
  found — the empty string where there was nothing. Vitest's `unstubEnvs` restores
  stubs before each test and never after the last, so a per-test stub, and a raw
  assignment from anywhere, is still in the variable at teardown; only the hook that
  made the change can undo it.
- An invariant over all inputs is a property test: `fast-check` generates the inputs, the
  test states the law, and a failure prints the smallest input that breaks it. The
  property lives beside the module it holds, in a `*.property.test.ts` file, with the
  generator defined in the same file or in the module's own test-support. The run count
  and the seed are pinned for the whole runner by the shared property-test setup
  (`packages/shared/src/testing/property-tests.ts`), which a package that generates
  inputs loads from its vitest config: a property that declares no count runs the pinned
  count, never the library's default, and a test declares a lower count only where its
  generator makes the pinned count too expensive, with the reason beside it. Read a
  failure from its shrunk counterexample, and pin that input as an example test beside
  the property so the regression stays named.

### Where a mutant runs

A mutant — a line deleted, a predicate narrowed, a fault planted to watch a test go red —
runs only where no other process can load it: in a copy of the files outside the
repository, or as a test case that injects the faulty behaviour. Other agents work in the
same checkout at the same time (`docs/AGENT-RULES.md` §Your Role), and their bring-ups,
seeds and test runs execute whatever the working tree holds, so a mutant made in tracked
source runs in every one of them. A comparison against HEAD follows the same rule: read
HEAD's version with `git show HEAD:<path>` into a directory outside the repository, and
leave the working file as it stands.

### A deletion that turns no test red

Deleting a line and running the suite is the quick proof that the line is load-bearing,
and the inference runs one way. Red proves the line has behaviour. Green proves only that
the fixture set does not reach the line — never that the line is inert; a suite green
because the code does nothing and a suite green because nothing exercises the code print
the same output. Read a surviving mutant — the deletion nothing caught — as a missing
fixture: construct the input that reaches the line and run again. Conclude inertness
only when no such input exists, and write the conclusion with the scope it was
established over ("unreachable through inputs of shape X"), as `docs/AGENT-RULES.md`
§Communication requires of every negative existence claim.

### Proving a gate's tests

A gate's test suite is judged by the mutants it kills, and deleting a predicate is the
coarsest mutant. For each predicate the gate applies, change it the narrowest way its
shape survives — flip one comparison, drop one alternative, widen one glob — and watch a
test go red; a pin that dies only when the whole predicate is deleted has proven the
predicate's presence, not its edge. Assert the value a branch decides; an assertion that
the input was accepted or refused speaks for the outer gate and for nothing inside it.
Read each fixture against the predicate it exists to exercise: a fixture that never
contains the construct the predicate is about is inert, and every assertion over it
passes for a reason unrelated to the gate.

### What a property proves

A round-trip property constrains invertibility, never correctness. An implementation
that returns its input untouched, one that ignores the key or the label in both halves,
and one that collapses domain separation all round-trip perfectly, so a symmetric break
is invisible to the property by construction and only an asymmetric one reddens it.
Example tests that assert a specific input against a specific output close that gap —
for a codec, frozen vectors (`packages/crypto/src/primitives/format-vectors.test.ts`,
beside the properties in `packages/crypto/src/wrap/wrap.property.test.ts`) — so the
property and the examples are complements, and neither supersedes the other.

A property is as strong as the inputs its generator reaches, and reach is counted, never
inferred. The library biases its primitive generators toward boundaries, and the bias
does not survive composition into a domain type: a record built from primitives lands
on its boundaries rarely, so a property over it runs its cases against the middle of the
domain and reports a green about the middle. Count what a composed generator produces at
each boundary before trusting it; where a boundary goes unreached, a weighted branch
that draws the endpoints deliberately is the fix. A declared constraint and a binding
one are different things: an array arbitrary's declared maximum length is only a
ceiling on what the library's size setting chooses (`size` on the arbitrary, `baseSize`
globally), so a property over "long enough to compress" inputs can run every case on
short ones and never compress once; an integer arbitrary given only a minimum takes the
library's default maximum, far inside the safe-integer range the function under test
admits. Draw and count; a declared bound is not evidence.

A reach figure is a fact about the file's generators as configured together, never about
one generator: a record's fields consume one shared draw stream, so widening one field
moves what an unchanged neighbour produces. A counted reach therefore belongs in the
run's report, dated, and never in an assertion — a pinned count reddens on any
neighbouring edit while nothing broke. An assertion over reach, where one is written,
pins a threshold — some draw exceeds the ceiling — because a threshold survives a
rearrangement and fails only when the reach genuinely collapses.

## When to write an E2E test

Write or extend a Playwright E2E test when any of these hold:

- The change adds or materially alters a user-facing flow — a sequence of UI interactions
  crossing client and server, not a single component's behaviour.
- The change touches a critical-path flow: auth and registration, payments and billing,
  messaging and streaming, sharing and membership, data deletion, key rotation.
- The behaviour is observable only at integration seams unit and integration tests
  cannot reach: WebSocket reconnect and replay, multi-tab, realtime presence, upload
  pipelines.
- A major feature bug reached users despite green unit and integration coverage — guard
  that bug class at the level that would have caught it.

Logic fully exercisable at unit or integration level, styling and copy changes, and
error states already pinned by integration tests stay below E2E. Extend an existing suite
rather than adding a standalone spec; suite runtime is a shared budget. E2E money
assertions use the vocabulary in `e2e/helpers/exact-money.ts`, which derives expected
amounts from what the running system served and makes a hand-written amount a compile
error.

## Debugging E2E failures

`e2e/report/<latest>/` is the single source of truth; `/debug-e2e` investigates it.
