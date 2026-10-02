# Local Stack

The three local stacks, the slot a checkout runs them on, the claim registry that decides
what is alive, and the commands that end what is not. How `pnpm test`, `pnpm lint` and
`pnpm typecheck` schedule their work is `docs/TASK-ORCHESTRATION.md`; writing and running
tests is `docs/TESTING.md`.

## Env modes and stacks

A stack is one data plane — a Postgres database, a MinIO bucket and a Redis logical
database — plus the app processes a mode runs against it. Three exist, named
`development`, `test` and `e2e`, and every command addresses exactly one through its env
mode. Six env modes exist, and the relation from mode to stack lives in one place,
`scripts/lib/stack/stack-mode.ts`: `development` runs the development stack; `test` and
`ciVitest` both resolve the test stack and differ only in the values they generate; `e2e`
and `ciE2E` both resolve the e2e stack; `production` runs no stack and the loader loads
no env file under it — generation under it writes only `.env.production`, git-ignored,
holding every frontend-destined production value, secrets included, read from the
invoking shell.
Under the two CI modes the workflow writes the env files itself and `pnpm ensure-stack` is
a no-op (`scripts/ensure-stack-cli.ts`).

The selector — `HB_ENV_MODE` in the ambient environment, or `--env-mode <mode>` on the
env loader (`scripts/with-env.ts`), the run-claim wrapper (`scripts/with-run-claim.ts`)
and `pnpm ensure-stack` — chooses which stack's files load. Once loaded, the files
overwrite `HB_ENV_MODE` with the mode that generated them (`pnpm generate:env` writes
it), and the loader keys the classification clearing on that declared mode, never on the
selector. The two disagree in CI as a matter of course: the job generates under
`ciVitest` and runs `pnpm test`, which selects `test` — the same stack loads, and the
process runs as `ciVitest`. The root scripts already carry the selector — `pnpm test`
and its filters name
`test`, `pnpm e2e` and its suites name `e2e` — and a command that names no mode addresses
`development`. That default is deliberate — the one place `docs/CODE-RULES.md`
§Environment Detection does not reach — and its reason and re-entry condition are
recorded in `docs/DECISIONS.md` §Recorded exceptions.

One checkout's three stacks share one compose project — one Postgres cluster, one Redis,
one MinIO volume (`scripts/lib/stack/compose-env.ts`). Inside it each stack owns its own
database and bucket, the development stack under the unsuffixed names every consumer
already reads and the other two under names suffixed with the stack
(`scripts/lib/stack/stack-database.ts`, `scripts/lib/stack/stack-bucket.ts`), and its own
Redis logical database behind the Serverless Redis HTTP proxy's token pools
(`scripts/lib/stack/srh-tokens.ts`). So `pnpm dev`, `pnpm test` and `pnpm e2e` never share
data and run side by side on one checkout, and anything that ends the containers —
`pnpm db:down`, the idle daemon — ends every stack on the slot at once, while
`pnpm db:reset` wipes every stack's data.

What the three stacks do share is the processes in front of those stores. One Redis proxy
container serves all three, so isolation here is of data and not of availability: a stack's
rows are its own, and a fault in that one process reaches every stack at once. A command that
recreates a shared container therefore interrupts runs on the other two stacks, which is why
every compose invocation resolves its project directory the same way (§Writing a script that
starts a process, binds a port, or removes state).

## The slot and its ports

Every checkout — every git worktree included — holds one slot: a number from a bounded pool
that fixes the checkout's compose project name and its host-port band
(`scripts/lib/stack/port-plan.ts`). `pnpm generate:env` claims the slot and writes it into
the generated files as `HB_STACK_SLOT`; nothing defaults it, so a command that finds none
set stops and says to run the generator. Within the band, each container service has one
port per slot, shared by the three stacks. The app servers a stack starts — Vite,
Wrangler, the sandbox origin and the rest — have a band per stack, so a dev session and an
E2E run on one checkout bind different ports; the test stack starts no app server and
binds no host port of its own.

This checkout's values are in the generated, git-ignored `.env.scripts` (the `HB_*_PORT`
vars) for the development stack, and in `.env.scripts.<stack>` for the other two.

## Generated files

Each stack has three generated, git-ignored files: the backend's `apps/api/.dev.vars`, the
frontend's `.env.<mode>`, and the scripts' `.env.scripts`. The backend and scripts files
carry no suffix for the development stack and `.<stack>` for the others, following
wrangler's own convention of an unsuffixed default beside a per-stack sibling; the frontend
file is named for the stack the mode runs, or for the mode itself where it runs none
(`generatedEnvPaths` in `scripts/generate-env.ts`). `pnpm generate:env` writes one mode's
files (`--mode <mode>`, default `development`); every local `pnpm dev` and `pnpm test:*`
regenerates them on its way in and leaves an unchanged file untouched, so concurrent runs
never rewrite each other's. The env loader reads the three files of the stack its mode
addresses, then removes from the process each classification variable — a registry entry
the environment flags of `createEnvUtilities()` derive from (`CLASSIFICATION_VARIABLES` in
`packages/shared/src/env/env.ts`) — for which the generating mode states no value. A mode's silence
is therefore a denial enforced at load, never an inheritance: a CI runner's ambient `CI`
cannot survive into a command whose files a non-CI mode wrote. A new env mode states a value for each classification
variable or accepts the deletion; a variable the flags derive from joins that set, or a
runner's value stays in place. The values themselves come from the env registry, never
from an edit to a generated file (`docs/CODE-RULES.md` §Registries).

## What `pnpm dev` starts

`pnpm dev` brings the stack up, refreshes the model catalog, seeds the database and the
on-device model artifacts, then starts the dev servers. Bring-up (`pnpm ensure-stack`,
`scripts/lib/stack/ensure-stack.ts`) regenerates the env files, starts the containers,
creates the stack's database when the cluster lacks it, migrates, starts the idle daemon
when none is alive, and ends with the read-only world audit, so the classification it
prints is of the stack the command is about to use. Under the `e2e` env mode, bring-up
also recreates the stack's data plane before it creates and migrates the database: it
drops the database, flushes the Redis logical database, and empties the media bucket, the
Worker's wrangler local store and, on Linux, the browsers' temporary directory
(`scripts/lib/stack/data-plane-reset.ts`), so every E2E run migrates and seeds from empty.
The reset reaches only the E2E stack's own stores. It refuses while a process holds the
wrangler local store open, which only Linux can report; elsewhere it proceeds. Running
after bring-up: Vite,
Wrangler, the document sandbox origin (a static server serving the runnable-document
renderers under their real CSP), Postgres (Docker), Neon Proxy (WebSocket → Postgres),
Redis, Serverless Redis HTTP (Upstash REST emulator), and MinIO (R2 emulator), plus a
ticker that fires the Worker's deployed cron schedules at their real cadence, in UTC. The
ticker is off under the `e2e` env mode, where a spec fires the schedule it needs instead
(`docs/SCHEDULES.md` §Firing a schedule from a spec). The only live vendor calls are
credential-free reads of public data — the OpenRouter model catalog (at startup and on
the hourly schedule) and the on-device model weights (until the download cache under
`scripts/.cache/` holds them).

## The E2E RAM root

On Linux, the E2E stack keeps the state a run rebuilds and a disk would stall — the
Worker's wrangler local store, the preview servers' bundle snapshots, the browsers'
temporary directory and Playwright's output directory — in one directory per checkout on
the shared-memory tmpfs, outside the repository (`scripts/lib/stack/ram-root.ts`). On
macOS and Windows no root exists, and each of those stays at its disk location. Why the
platforms differ, and what would change it: `docs/DECISIONS.md` §Recorded exceptions.

The root is named for a digest of the checkout's path, and its owner file records that
path and the mount namespace the root was claimed in, rewritten on every claim. E2E
bring-up and the Playwright runner each refuse, before starting anything, a root that is
not on tmpfs or lacks the free space `ramRootRequiredBytes` sizes for the run's worker
count; the refusal names what to raise. A root whose checkout is gone is reclaimed as
§Run claims: what is alive describes.

## Run claims: what is alive

Every command that goes through the wrappers holds a run claim for its lifetime: a
directory in a machine-scoped registry — a per-user directory under the operating
system's temporary directory (`scripts/lib/claims/registry.ts`) — with a sibling lock file
on which the run holds an OS advisory lock. The claim records what the run holds: its
slot, ports, databases, buckets, containers, compose project, directories, sockets, and
the process groups it spawned. Children inherit it through the environment
(`HB_RUN_CLAIM`), so one `pnpm dev` or `pnpm test` is one run however many processes it
fans out to. A run is alive exactly while its lock is held. The kernel drops the lock the
instant the process dies, however it dies, so liveness is a kernel fact with no clock in
it: there is no heartbeat, no timestamp, no time-to-live and no central index — a pass
enumerates the registry once and tries every lock. A clock may bound how long something
waits; it never decides whether a run is alive. The registry keeps its lock files, because
unlinking one would race the lock it guards; the directory grows by one small file per run
and nothing prunes it.

Every resource a pass meets is in one of three states, and the state alone decides what
may happen to it:

- **Owned and live** — a live claim names it. Nothing touches it, ever, whatever its age.
- **Owned and expired** — a claim names it and that run's lock is free. This is what a
  reclaimer reclaims: the next pass that reaches it ends it.
- **Unowned** — no claim names it, which is what a process that held no run claim leaves
  behind. It is reported, with a line naming the command that would reclaim it and the
  condition under which it will, and left standing.

A claim record that cannot be read is unknown, never absent. The pass carries it as
unread, reclaims nothing on its account — the resource it might name could be live — and
reports it, and a dry run exits non-zero for it exactly as for an unowned resource.

An age never enters a liveness decision. What an age decides is how long an unowned
resource is reported before the next pass takes it: past a fixed boundary
(`UNOWNED_RECLAIM_AFTER_MS` in `scripts/lib/claims/resource-age.ts`, sized far beyond any
legitimate hold) an established age licenses the removal, and an age that could not be
read leaves the resource standing. This is a limit on accumulation, not a test of whether
anything is alive.

Some kinds of resource sit outside the ownership rule, each for its own reason, and the
reasons license different future exceptions:

- **The E2E output aside** — `scripts/e2e-clean.ts` renames Playwright's output directory
  aside before a run and removes the aside before it returns. An aside whose renaming run is
  gone is removed by the next run rather than reported, because nothing ever reads one and
  the only actor that would retry its removal is the run that made it. A live run's aside is
  spared.
- **A vitest cache generation** — `scripts/lib/vitest/cache-sweep.ts` spares a generation a
  live run holds and otherwise keeps it by age alone (`CACHE_MAX_AGE_MS`), because a
  generation is rebuildable: the cost of removing one early is a rebuild, never data.
- **A wrangler local store inside the checkout** — belongs to the stack mode its directory
  names, never to a run, so no claim names one. A store whose directory names no stack
  mode is emptied by the next bring-up and left standing without write permission, so a
  later write that names no persist target fails there instead of refilling it. The E2E
  stack's store is emptied by every E2E bring-up as well (§What `pnpm dev` starts).
- **An E2E RAM root** — belongs to the checkout its owner file names, never to a run, so
  no claim names one. The next stack bring-up removes a root whole once no directory
  stands at that checkout path, if the root records the mount namespace the scan runs in
  and nothing holds it open. A root claimed in another namespace, or recording none, is
  left standing: a container and its host can share one RAM filesystem, and a path absent
  in one can be a live checkout in the other.

## Reclaiming

Each reclaimer classifies through the same ownership reading and ends only what its claim
licenses; a non-zero exit from one means something stands that it did not end, and the
line it printed for that resource is the repair. That exit is a report, not a failure.

- `pnpm dev:clean` — ends what a finished run of this checkout left behind (its listeners,
  its process trees, its socket) and reports what nothing accounts for. `--dry-run`
  classifies every resource and changes nothing — this is the world audit that bring-up
  also runs. `--all` reclaims this checkout's own live runs too. `--unowned` is permission
  to end a listener no claim accounts for.
- `pnpm dev:restart` — `pnpm dev:clean --all`, then `pnpm dev`. The recovery for a wedged
  stack.
- `pnpm docker:cleanup` — compose projects and containers. It removes a project only when
  the project names this clone, no worktree of the clone holds a live run, and every live
  record was readable; a container no claim names is reported until it has stood past the
  boundary, then removed. `--dry-run` reports only.
- `pnpm db:down` — stops the slot's containers (`scripts/stack-teardown.ts`). Named volumes
  survive, so the next bring-up is not a fresh database. It refuses while another run is
  live on the slot, and so does `pnpm db:reset`, which also wipes the volumes.
- `pnpm clean` — removes the installed and built tree (`scripts/clean.ts`). It refuses while
  a run of this checkout is alive; `--ignore-live-claims` overrides.

A refusal disregards the asker's own run and counts both halves of the reading — the runs
the registry names and the records it could not read — so a command refuses when either
is non-empty (`scripts/lib/stack/teardown-guard.ts`).

A pass that reports a process tree **left running** is reporting a refusal it is right to
make. Ending a tree needs more than the tree being there and its run being over: the pass
reads the run's identity out of the live processes themselves, and a tree carrying none
cannot be shown to belong to the run whose record names it. A process-group id is reissued,
so acting on that record would end whatever now answers to the number. The tree this applies
to by design is the idle daemon, which is started without the identity of the run that
started it precisely so it can outlive that run.

## A stack that stopped by itself

A stack whose containers are gone while its volumes remain was ended by the idle daemon,
by design. One daemon runs per slot (`scripts/lib/stack/idle-killer.ts`,
`scripts/lib/stack/idle-killer-daemon.ts`); it holds its exclusivity by binding a loopback
port and is started by bring-up when none is alive. It polls the claim registry, and after
a fixed run of consecutive polls in which no run holds a claim on the slot it stops the
containers — a compose down that keeps every volume, so the next `pnpm dev` or `pnpm test`
resumes the same databases. The count is kept in memory, never as a persisted deadline,
and a listener on a port is deliberately not consulted: a process that holds no run claim
does not keep the stack up. A teardown that fails is written to a file that outlives the
daemon. The daemon is started without its parent's lifeline or claim, which is why it
survives the run that started it.

## Writing a script that starts a process, binds a port, or removes state

- **Launch.** A root manifest entry whose head runs one of this repository's own modules
  starts `node --import tsx <file>`, never `tsx <file>`: the second forks, leaving a hop
  above the process that holds the teardown lifeline, so a killed command orphans its
  tree. `scripts/root-chain-head.test.ts` derives the rule from the manifest and fails any
  entry that breaks it.
- **A child that outlives its call** is started only through
  `scripts/lib/spawn/long-lived.ts`. It records the child's process group and ports in the
  run's claim before waiting for readiness, so a run killed mid-start still accounts for
  what it began; a child running that module ends its own tree when its connection to the
  parent's lifeline ends; and the module owns the platform difference between POSIX
  process groups and Windows job objects. A daemon meant to outlive the run starts without
  the inherited lifeline and claim — the idle daemon is the canonical case.
- **A port** comes from the stack's port plan and is claimed by the entry point that binds
  it — `scripts/dev.ts` for the development servers, the E2E runner for the e2e stack —
  never by the wrapper, which cannot know whether what it runs binds anything and whose
  speculative claim would make a dead run's orphan read live. A claim on a port a run never
  bound is a resource no reclaimer may touch.
- **Removing state** another run might own goes through the ownership reading
  (`scripts/lib/claims/ownership.ts`): end what is owned and expired, report what is
  unowned, and treat a record you could not read as a run that might be live. A command
  that ends something on the slot asks the teardown guard first. A clock may bound waiting;
  it never decides liveness.
- **The lifeline is a Unix socket** in the temporary directory, and the platform caps a
  socket path at about a hundred bytes; an address that would not fit is refused before any
  child starts, because a truncated name is no longer unique. On Windows the lifeline is a
  named pipe and has no such limit.

## Interrupting a command

A command composed of lanes by `scripts/run-checks.ts` — `pnpm dev:restart` is one, and so
is `pnpm test` — stops at the first interrupt: the lane that was running ends, nothing
after it starts, the summary says `STOPPED: interrupted, so nothing after it was run`, and
the exit is non-zero. A second interrupt gets the signal's default action and ends the
command at once.
