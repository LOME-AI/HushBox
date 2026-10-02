# Task Orchestration

How `pnpm test`, `pnpm lint`, `pnpm typecheck`, and the repo-wide gates execute. Turbo
is the cache authority throughout — per package for the first three, per repository for
the gates; what differs is who schedules the work. Nothing here needs tuning — every
knob is derived or measured at run time, and the ledgers that inform scheduling are
hints only: correctness never depends on them.

## The two shapes

**Tests consolidate** (`scripts/test-batch.ts`): one `vitest run` executes every
cache-missed package as projects sharing a single global worker pool, so the file —
not the package — is the unit of scheduling. The coordinator asks turbo which `#test`
tasks missed (`--dry-run=json`), turbo launches the misses, each package's test
script registers over loopback TCP (`HB_TEST_BATCH_PORT`) and waits, the batch runs
once, and each task exits with its package's verdict so turbo caches it under the
hash it computed before execution began. That verdict is the package's own only while
the batch exits clean: once the batch exits non-zero, a package with no failure
attributed to it fails too, with a reason saying exactly that, and caches nothing —
asked per package, so one recognised failure never certifies its neighbours. A red
package you did not touch is therefore the batch's failure, not a phantom in the
package. A run-then-stamp design would poison the
cache; registration-before-batch is what makes it sound. Files are dispatched
longest-first from vitest's own duration cache (`scripts/lib/vitest/lpt-sequencer.ts`).

**Lint and typecheck pool** (`scripts/turbo-pool.ts`): the opposite shape, because
typed lint builds one TypeScript program per package — consolidation would duplicate
programs, not share them (ESLint's own `--concurrency` duplicates the project service
per worker thread and measured _slower_ at 2 workers than 1). So each package stays
its own `turbo <task> --filter=<pkg>` invocation — a normal turbo run that hashes and
caches itself — and the wrapper owns whatever turbo leaves undecided about those
invocations, including release order (longest first, from observed walls), concurrency,
and the arguments the tool behind the task runs with (`lint` carries
`--max-warnings=0`, so warn-severity findings fail the build).

**Outside both shapes: the skill tree.** `.claude/skills/**` matches no workspace glob, so no
vitest project and no package tsconfig reaches it. It runs as its own lane of `pnpm test`
(the `node:test` files, discovered by node's own naming convention) and of `pnpm typecheck`,
composed alongside the package work by `scripts/run-checks.ts` — which runs every lane it is
given whatever an earlier one returned, and names the failing ones (`FAILED: skills`).

## Derived values

- **Vitest workers** (`scripts/lib/vitest/workers.ts`): the pool's derivation below,
  with a test file as the unit — a fork holds a file, not a package. The units are
  every recorded test file still in the tree, whatever the run is about to execute:
  a package spread over many short files would otherwise resolve to very few lanes
  and run slower than the repository-wide answer. The ceiling is the parallelism the
  machine reports; the memory bound is the ladder below. Every consumer that declares
  a vitest worker ceiling takes it from that one derivation, and
  `packages/config/vitest.config.ts` states which declaration a run resolves. Every
  launcher that starts vitest — the consolidated batch, a package's own test script,
  and the watch script — records its run into the one vitest ledger, stamped with the
  shape that produced it, so a developer's package run informs the next derivation
  exactly as a batch does. A ledger naming no test file opens the ceiling, unguarded,
  and the derivation reports itself as cold-start. The workerd projects (the
  `vitest.workers.config.ts` files) take no count from the derivation and file no row:
  launched beside a node suite they run as siblings inside that run's measured tree,
  so their memory is already in the peak it files; launched alone they are inside
  nobody's — the exclusion is recorded in `docs/DECISIONS.md`.
- **Pool concurrency** (`scripts/lib/pool/schedule.ts`): the fewest lanes at which
  the run is as short as it can be. Each task about to run is charged the median of
  its recorded walls — a never-measured task the largest wall in the set, which opens
  a lane for it rather than burying it — and the tasks are placed longest-first into
  each candidate lane count, from the work-bound floor (summed walls over the longest
  wall, a lower bound on the answer) upward; the scan stops at the first count whose
  makespan is the longest task's own wall, and a set no count brings there opens one
  lane per task. All inputs are walls from one source, so external load stretches
  them together and the answer holds on a machine that is never idle. Lanes past
  that point idle — measured, wall time was flat from 4 lanes to 10 while peak memory
  nearly doubled — so the only thing more lanes buy is a memory bill, and the count
  is then lowered while the memory ladder's figure for it overruns the budget. The
  ceiling is the detected performance-core count (`scripts/lib/pool/machine.ts`): on
  a hybrid CPU thread count overstates how many single-threaded, cache-hungry lint
  programs can run at speed. Where topology cannot be read the ceiling falls back to
  `⌈threads/2⌉`; Windows deliberately carries no detection code, because no CI runner
  exists to prove it. Cold start (no task in the set measured) starts from the
  ceiling, is lowered by the same ladder where rows exist, and reports itself as
  cold-start; the run records the walls the next derivation uses.
- **Memory** (`scripts/lib/pool/memory.ts`): a run's peak is the proportional set
  size summed over the orchestrator's own process tree — everything it spawns
  descends from it, so processes a per-task tracker cannot see stay inside the
  accounting. Proportional rather than resident, because workers share one loaded
  module graph and a resident-set sum counts each shared page once per worker. The
  budget a run plans against is the share its parent handed down via
  `HB_MEMORY_BUDGET_KB` — pre-push measures free memory once and splits it between
  lint and typecheck, which run concurrently and would otherwise each plan against
  the whole of it — or, absent one, `0.8 ×` available memory. The projection is a
  ladder of whole runs: each retained run files the peak its tree held and the lane
  count live at that instant, and a candidate count is priced at the worst peak any
  count at or below it recorded — on the line between two neighbouring rungs, on the
  line down to the run's own baseline below the narrowest, and flat at the worst
  figure on record above the widest. Nothing is extrapolated, nothing is composed
  from per-task peaks, and nothing is scaled. The pool lowers its count while that
  figure overruns the budget. The ladder reads rows of every shape — a batch, a
  package run and a watch run alike — because a whole peak read across shapes can
  only over-read, the direction a bound may err in. It claims what widths have held,
  never what they will hold: above the widest rung the record widens only as an
  admitted run files a wider one. Where no row carries a peak, a baseline and a lane
  count the count is unguarded and the derivation says so; what that run records
  bounds the next. Only Linux's per-process accounting is read, so on macOS and
  Windows no peak is recorded and the ladder never binds — a reading may degrade,
  never make the pool platform-dependent.
- **Ledgers** live in `.cache/hushbox-turbo-pool/<machine-fingerprint>/<task>/`
  (git-ignored) — outside `node_modules`, whose tree `pnpm install` and
  `pnpm clean` both delete, which took the learned state with it and left every
  run starting blind. A ledger is a directory of one file per run, folded oldest
  first at read: a run writes only its own file, where a whole-file read-modify-write
  lost rows whenever two runs of one task overlapped. The fingerprint hashes the
  machine's shape — platform, arch and CPU model — and not the numbers an allocation
  decides, so two allocations of one machine share a store and so do two machines of
  one shape; a checkout driven by two shapes gives each its own files. A run file
  carries the walls of the units it ran (release order and the work bound) and the
  run's whole-tree observation (the memory ladder), stamped with the shape of the
  invocation that produced it. Retention is what makes the store answer for every
  shape: it keeps the newest runs of each shape at each lane count, a bounded number
  per shape, and for every unit still in the tree the newest runs that measured it —
  enough for the median wall to have a real reading between two extremes — while a
  row carrying no shape stamp ages against every run. A width that vanishes from the
  ladder is retention repairing the record, not data lost. A store in a superseded
  shape — one whole file, or a separate package-rooted store — is folded ahead of the
  run files and then culled. Deleting a store costs one cold-start run, nothing
  more.

  `pnpm concurrency` prints each derivation's current answer — lane counts,
  their state, and the machine underneath — without running anything.

## Cache soundness

Typed lint and typecheck read sibling packages from source (workspace exports point
at `.ts`), so both tasks depend on `topo` in `turbo.json` — a dependency's type
change must miss the dependent's cache. ESLint's own `--cache` is deliberately not
used: its per-file key tracks no cross-file type dependencies, and typescript-eslint
recommends against it for typed rules.

`topo` covers the packages a manifest declares. A compiler program is bounded by its
`include` and its imports, not by the manifest, so a relative reach into a workspace the
manifest does not declare compiles sources the task never hashed: a cached green
certifies the declared closure, not every source the program compiled. The lint and
typecheck CI jobs restore no turbo cache (`.github/workflows/ci.yml`), so the exposure is
a local replay, never a shipped verdict.

A task hashes what its `inputs` name plus its package manifest and `turbo.json`. The
lockfile is not automatic — turbo's documentation says otherwise, and its source and a
direct experiment agree against it — so a task with narrow input globs whose verdict
depends on installed dependency versions names `pnpm-lock.yaml` itself.

An `inputs` glob resolves against the package running the task, so a file outside
that package's tree is named through `$TURBO_ROOT$` — the `build` task's root env
files, for example. Unanchored, the glob matches nothing and nothing says so: the
task hashes without the file, and a change to it replays the old output (a
regenerated env served a bundle baked with the previous `VITE_*` values).
`scripts/build-web-bundle.test.ts` pins the anchor. Because the root env glob also
takes in the per-worktree ports file, the build hash is worktree-specific — free for
the local cache, a cross-worktree miss for any remote one.

## Repo-wide gates

`pnpm arch:check`, `pnpm lint:duplication`, and `pnpm privacy` scan the whole tree
rather than a package, and each is a cached turbo root task. The name a caller types is
a wrapper that invokes the task, and the task runs the root script of its own name
(`arch:scan`, `duplication:scan`, `privacy:check`) — wrapper and runner cannot share a
name without the wrapper calling itself. Which gates cache is exactly the set of root
tasks `turbo.json` declares.

`$TURBO_DEFAULT$` as the input set is what makes them cacheable at all. It is
gitignore-aware: tracked files, untracked non-ignored files and every workspace package
tree, while leaving out `node_modules`, `.git`, `.turbo` and whatever the task itself
just wrote. A filesystem glob (`**/*`) walks all of those and rehashes the task's own
output, so it can never hit — presenting as a slow gate rather than a broken one.
`turbo.json` carries the declaration and the residual unsoundness it accepts;
`scripts/turbo-root-tasks.test.ts` fails if a later edit reintroduces one of the silent
failure modes.

## Constraints discovered the hard way

- Concurrent `loadConfigFromFile` calls hang or silently exit 0 (vite 8) — every
  config-loading loop is sequential, documented at each site.
- The root vitest config loads scripts libs under Node's native loader, where a
  static `./x.js` specifier does not resolve to `x.ts` — cross-lib imports reachable
  from the config use explicit-URL dynamic imports.
- pnpm re-inserts `--` before forwarded args, so wrappers recognize their own flags
  positionally-blind (`--force` anywhere) and forward everything else.
- Turbo hashes forwarded tool arguments into the task hash, so a `--dry-run=json`
  plan taken without them reads cache status for a **different** command — a coordinator
  acting on that plan silently skips packages the tool never saw. A coordinator hands its
  dry run the same tool-arg tail its spawns carry, derived once, never assembled twice.
- A composed check line (`scripts/run-checks.ts`: `:: <lane> <program> [args]` groups)
  that ends in `::end` refuses anything a caller appends, because pnpm merges the
  appended tail into the script line before the runner sees either — `pnpm typecheck --
--force` would reach only the last lane. Put the argument on the lane that answers it,
  spelled as the refusal prints: a forced whole-repository typecheck is `pnpm exec tsx
scripts/turbo-pool.ts typecheck --force`. A composition without `::end` keeps
  forwarding to its last lane, which is what `pnpm test -- --force` relies on.
- Turbo never caches failures, deliberately: the environment is not in the hash.
- A timing loop that discards stderr cannot tell a fast pass from an instant failure,
  and reports the failure as a pass. Pass a file list as separate arguments rather than
  one unquoted variable: zsh does not word-split an unquoted expansion, so
  `eslint $FILES` hands ESLint one argument naming nothing and exits non-zero at once.

## Rejected (do not re-propose without new evidence)

Nx migration (re-entry: sustained >20% gap between batch makespan and the slowest
package alone) · ESLint `--concurrency` (per-worker program duplication, measured
regression at 2 workers) · one repo-wide eslint invocation (18 flat configs; would
serialize or duplicate) · eslint `--cache` with typed rules (unsound) · caching
failed tasks (environment not hashed — a false red would pin) ·
lane selection by a makespan simulation with no stopping rule (its predicted
makespan keeps improving with lanes that measured walls show buy nothing; the
shipped scan stops at the fewest lanes reaching the longest task's wall) ·
composing a memory projection from per-task peaks, and a calibration ratio
over that sum (high-water marks do not coincide, and the ratio measured that
same error against the peaks it was meant to predict) · extending the widest
memory rung by its own cost per lane (a per-lane line through a single point on
a curve measured nowhere past it) · per-task RSS sampling for the memory cap (a 1 Hz
per-task-tree sampler under-read typecheck's largest packages by roughly
half; the whole-tree sampler replaced it) · whole-system memory delta as
attribution (the quietest observed window swung by more than several
commands' entire footprint) · V8 heap ceilings (`--max-old-space-size`
measured slower and barely lighter, and killed the largest package outright) ·
affected-selection for the repo-wide gates (`turbo query affected` misreports root
tasks upstream, and the failure direction is a gate that silently does not run;
re-entry: the upstream defect is fixed and re-verified here).
