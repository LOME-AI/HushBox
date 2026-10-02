# Development

## Commands

All workflow commands go through pnpm scripts. If you repeatedly need a raw command,
propose a new pnpm script instead of running it directly. Scripts self-wrap in the env
loader and start the local stack on demand, so the first command of a session may start
Docker containers.

- `pnpm dev` — full local stack. `pnpm dev:restart` recovers a wedged one.
- `pnpm cron:fire <schedule>` — fires one deployed cron schedule on the running dev stack
  and returns once its handler has finished; with no argument it prints the schedule
  names. A schedule otherwise fires locally only at its real cadence.
- `pnpm test` — everything, with the coverage gate. `pnpm test:<package>` filters to
  one package: the unfiltered package run, and the figure that settles per-file
  coverage.
- The red-green cycle's commands: `pnpm test:watch <test-file>` runs one test file,
  coverage-free. `pnpm test:file <test-file> [<test-file>...]` runs the named test files
  once with coverage over the module each sits beside (`--source <path>` names another),
  and reports a lower bound, not the file's coverage — at or
  above the per-file threshold is a conclusive pass, because adding test files can only
  raise a source file's numbers; below it, 0% included, is inconclusive, because another
  test file may cover the rest, and `pnpm test:<package>` settles it. Mechanics:
  `docs/TESTING.md`.
- `pnpm lint` / `lint:fix` / `typecheck` / `format`, plus the standalone gates
  `pnpm arch:check`, `pnpm lint:duplication`, `pnpm lint:unused`, `pnpm privacy`,
  `pnpm verify:bundle`, `pnpm verify:licenses`, `pnpm verify:doc-paths`,
  `pnpm verify:design-tokens`. `pnpm lint:pkg`, `typecheck:pkg` and `test:pkg` take a package
  name. What each gate checks and when it runs: `docs/BUILD-AND-CI.md`.
- `pnpm concurrency` — the lane count every scheduling derivation would open and where
  each number came from, and the parallelism mechanisms that derive no count. Reads
  only, starts no work.
- `pnpm db:generate` — writes a migration from schema edits; `db:migrate` applies;
  `db:reset` wipes; `db:seed`; `db:studio`. Migration rules: `packages/db/CLAUDE.md`.
- `pnpm weights:seed` / `weights:publish` — the on-device model artifacts, local store
  and production bucket. `pnpm dev` runs the seed.
- `pnpm e2e` (full) / `e2e:quick` / `e2e:<suite>` — read `e2e/CLAUDE.md` first.
- `pnpm mobile:test` — the Maestro flows against Android emulators (`mobile:test:smoke`
  for the short set). It runs on Linux only and needs what `pnpm install` cannot deliver:
  `/dev/kvm`, Docker, and a JVM on `PATH` for the Gradle build; it installs the Android
  SDK and Maestro itself on first run. Both are shortfalls of this script against
  `docs/CODE-RULES.md` §Platform Agnostic, which holds for it as for every other script —
  a gap to close, not an exemption.
- `pnpm cards` — the CLI over a run's `status.md` question cards; `pnpm cards --help` is the
  statement of its verbs. Every read and write of that file by an agent goes through it.
- `pnpm docket` — the audit console and CLI over `docs/audits/`; `pnpm docket --help`
  is the statement of the CLI. Working a finding as an agent: `docs/audits/CLAUDE.md`.
- `pnpm generate:env` / `verify:env` — the env files. `pnpm generate:readme` and
  `pnpm generate:skills` — the generated files below.

## Local stack

Three local stacks exist — `development`, `test` and `e2e` — and every command addresses
exactly one, selected by its env mode: `HB_ENV_MODE`, or `--env-mode <mode>` on the
wrapper that runs it. A command that names no mode addresses `development`; `pnpm test`
and `pnpm e2e` name theirs. Each stack has its own database, bucket and Redis logical
database, so a dev session, a test run and an E2E run never share data and run side by
side. Vendors reached through a port adapter are faked under `pnpm dev`; the only live
calls are credential-free reads of public vendor data — the OpenRouter model catalog and
the on-device model weights — so no production credential is ever needed. What each stack
runs, where this checkout's ports are, a stack that stopped by itself, and the commands
that reclaim one: `docs/LOCAL-STACK.md`.

## Environment

| File                    | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| **Generated env files** | One set per local stack, generated, git-ignored. No secrets. |
| **Cloudflare Secrets**  | Production secrets stored in Workers.                        |
| **GitHub Secrets**      | Production secrets for workflows.                            |

Env files are generated per env mode with `pnpm generate:env` and validated with
`pnpm verify:env`; the six modes, the local stack each resolves, and the files each
writes: `docs/LOCAL-STACK.md` §Env modes and stacks. Env vars exist only as `env.config`
registry entries (see CODE-RULES).

## Generated files

`README.md` is built from `README.template.md` via `pnpm generate:readme`. A skill
holding a `SKILL.template.md`, and every agent definition (template
`.claude/agent-templates/<name>.md`, output `.claude/agents/<name>.md`), are built from
that template and the shared fragments it injects via `pnpm generate:skills`; an agent's
model and effort come from its category in `.claude/agent-templates/model-categories.json`.
Edit the source, never the output; pre-commit regenerates both.

## Doc index — read eagerly when the task touches it. Lazily point out stale information in these docs as you notice.

Every on-demand doc is listed here with the trigger for reading it. A fact no listed
doc's purpose covers gets a new doc and a new line here, never a line in a loaded doc
(`docs/CODE-RULES.md` §Doc Lifecycle).

- `docs/TESTING.md` — writing or running any test: coverage mechanics, filters,
  browser-mode installs, cassettes, property tests, when to write an E2E test
- `docs/LOCAL-STACK.md` — the local stack: which stack a command addresses, adding an env
  mode or a variable the environment flags derive from, this checkout's slot and ports, a
  stack that stopped by itself, a reclaim command that refused
  or exited non-zero, interrupting a composite command, and writing a script that starts a
  long-lived process, binds a port, or removes state another run might own
- `docs/SCHEDULES.md` — the Worker's cron schedules: what each runs, the check-in that
  pages on a missed run, the dev ticker, firing a schedule from a spec
- `docs/BUILD-AND-CI.md` — a failing hook or CI gate, a red or skipped production deploy,
  the build lease, bundle verification, real-service evidence in CI, the on-device model
  artifacts, or bumping `@huggingface/transformers` (the bump obligates a prediction-canary
  re-pin)
- `docs/JOBS.md` — adding a job type, changing a handler, a stuck or dead job row, or a
  jobs auditor page
- `docs/REALTIME.md` — the conversation room, stream cursors and replay, socket caps, or
  session and link revocation
- `docs/DATA-MODEL.md` — reading or adding a table outside your slice, or any change that
  touches deletion
- `docs/BILLING.md` — billing domain work, including settlement mechanics, and catalog
  admission: which models the catalog sells, exposes, or hides, and why
- `docs/BILLING-BEHAVIOURS.md` — adding, changing, or retiring a billing behaviour, or
  looking up what a behaviour id means; its ids are what the behaviour ledger's rows cite,
  so a behaviour added or retired here moves its row in the same change
- `packages/config/behaviour-ledger.json` — writing, renaming, or deleting a test a billing
  behaviour's row cites, or asking which gate would catch a given behaviour's break. It
  proves the cited proof exists at the claimed layer, not that the test still asserts
  anything
- `docs/RATE-LIMITING.md` — adding any route, changing a limit, identity, class default,
  or exemption, or touching the counting script or its failure posture
- `docs/CACHING.md` — adding any route, changing a storable route's lifetime or tag, or
  touching the default-deny cache-policy stage
- `docs/NOTIFICATIONS.md` — any notification, push, or service-worker work
- `docs/DOCUMENTS.md` — runnable documents: document-panel rendering and execution, the
  sandbox origin, or the system prompt's document guidance
- `docs/TASK-ORCHESTRATION.md` — changing how `pnpm test`/`lint`/`typecheck` execute,
  worker counts or pool concurrency, the scheduling ledgers, or turbo task caching
- `docs/CI-CASSETTES.md` — recording or replaying CI cassettes (AI inference and web search)
- `docs/PUBLICATION.md` — the staging→public sync, the merge queue gate, contributor-PR
  CI phases, a public push that skipped its check jobs, or why a change hasn't appeared
  on the public repo yet
- `docs/DECISIONS.md` — before proposing a service, a mechanism, a gate, a lint rule, a
  doc mechanism or a dependency, and before reopening anything declined: the register of
  refusals and recorded exceptions with their re-entry conditions
- `docs/GROWTH-MEASUREMENT.md` — analytics, attribution or marketing-measurement work, a
  campaign tag, the growth dashboard or its roles, or any change near the privacy
  policy's website-measurement promises
- `docs/BACKUPS.md` — the backup workflow and its cadence, the retention ceiling, the
  staleness auditor, or restoring from a backup
- `docs/SECRETS.md` — adding a GitHub secret or a `secret()` registry entry, or
  responding to a leaked or lost credential; its inventory is generated from the
  declarations in code, never edited by hand
- `docs/runbooks/secrets/` — one file per credential family, reached through the file
  `docs/SECRETS.md`'s inventory names
- `docs/runbooks/infra/` — one file per operated surface: provisioning it, proving it,
  or recovering it
- `ops/README.md` — writing, labelling or running an ops script
- `docs/DESIGN.md` — any UI, visual, or user-facing copy work, and any change to a `.tsx`
  or `.astro` file: the accessibility conventions live there
- `docs/PRODUCT.md` — brand, voice, and audience for any copy
- `docs/CONTRIBUTING.md` — human onboarding and setup
