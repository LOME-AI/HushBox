# Build and CI

The gates a change passes on its way to `main`, the hooks that run them locally, the
build steps that produce deployable artifacts, and their production deploy. Local
commands: `docs/DEVELOPMENT.md`.
Scheduling and caching of the gates: `docs/TASK-ORCHESTRATION.md`.

## Git hooks

- **Pre-commit** regenerates the derived files that are committed — the readme and its
  assets, env blocks, the ops-dispatch workflow, db migrations, the iOS deployment
  target, skills — re-stages them, then runs the privacy gate over the staged diff. No
  formatter and no linter run here; the privacy gate is the exception because a leak is
  cheaper to fix before it enters history than after.
- **Pre-push** runs `lint:duplication`, `lint:unused`, `lint`, `typecheck`,
  `arch:check`, `verify:licenses`, `verify:doc-paths`, `verify:design-tokens`,
  `docket --validate`, two gitleaks scans and the privacy gate over the pushed range, in
  parallel, then the full test suite. The two scans ask different questions: the range
  scan asks whether the commits being pushed introduce a secret; the tree scan, one per
  pushed ref over the tree its tip publishes, materialised from git objects
  (`scripts/gitleaks-scan.ts`), asks whether that published tree holds one. They
  diverge for a secret that entered the tree outside the pushed range — a pull, a
  rebase, a cherry-pick — and for one committed and removed within it. Prettier rides `lint` as an ESLint rule and formats code only: comment text passes through it unreflowed and unmeasured, and no gate measures a comment's width. Of a comment's references, `lint` proves that a `{@link}` symbol and a backticked path resolve (`comments/resolvable-cross-reference`; which tokens count as paths: `packages/config/eslint-extensions/README.md`); the line a `file:line` names is proven by reading it. A comment edit is proven by reading the whole comment against `docs/CODE-RULES.md` §When to Comment; a green formatter is no evidence about it.
  `pnpm format` and `pnpm format:check` run Prettier over the tree less what
  `.prettierignore` exempts — run records under `docs/runs/`, audit findings, vendored
  and generated output, each entry with its reason beside it. Prettier named an exempt
  path matches no file and exits 0 reporting every matched file formatted, so a
  formatting check is evidence only for a path the ignore file admits; a run record is
  proven by reading it, never by `prettier --check`.
- `pnpm privacy` runs the privacy gate over the working tree, staged or not — the state
  the commit, push and CI stages cannot see. It is advisory by construction: it reads its
  allowlist from the working tree rather than from git.
- A scoped check (`pnpm lint:pkg`, `typecheck:pkg`, `test:pkg` with a package name)
  applies the gate's rules at the gate's severities to the package it names: the shared
  ESLint config carries every rule it enables at error severity, and every build-failing
  lint path adds `--max-warnings=0` (`scripts/lib/lint-tool-args.ts`) as the backstop
  for a warn-level rule a plugin upgrade introduces. Anything that reaches ESLint by
  another route — a package's own `eslint .`, an editor — resolves the same rules
  without that flag, and resolves them only from inside the package: the root config
  ignores every subdirectory, so `eslint <path>` issued from the repo root against a file
  inside a package inspects nothing and exits 0 — a pass that is no evidence. Lint a
  package's files from that package, which `pnpm lint:pkg <package>` does. The same
  silent pass covers two file classes ESLint reads from no directory: package-root tool
  configs (`*.config.ts` — the shared config exempts them as tool config written against
  plugin APIs; the repo root withdraws that exemption for its own configs only) and
  YAML, for which no parser is registered. Naming one on the command line prints "File
  ignored" and exits 0, so no lint verdict speaks for them. A tool config is proven by
  `pnpm typecheck` — each package's `tsconfig.json` includes its root configs — and by
  the run that loads it; a workflow or action file has no gate beyond CI's
  generated-block drift check and is proven by running it. What a scoped
  run cannot do is stand in for the gate: it covers one
  package's files where the gate covers every lint root, so a green scoped run speaks
  for that package and for nothing else. `pnpm lint:pkg <package> --force` refuses a
  cached verdict.

## CI gates

CI runs the same Docker Compose infrastructure as local development (`pnpm db:up`),
never service containers defined in workflow YAML — `docker-compose.yml` is the single
source of truth, so the test environment is identical locally and in CI.
Trusted runs cache the images the compose file names (`scripts/compose.ts`), except
those it pins by digest: a saved digest reference reloads untagged on Docker's classic
image store and compose pulls it anyway, so those images are pulled on every run. A
pinned image moves only when its reference in `docker-compose.yml` changes, which the
`docker-compose` entry in `.github/dependabot.yml` proposes.

- lint + `arch:check`
- typecheck + migration drift — an uncommitted `packages/db/drizzle/` diff fails
- generated-block drift — regenerates env blocks and the ops-dispatch workflow, then diffs
  `.github/workflows/` and `apps/api/wrangler.toml`
- skills drift — regenerates every templated skill and agent definition, then refuses any
  modified or untracked file under `.claude/skills/` or `.claude/agents/`
- duplication (jscpd) · unused (knip)
- gitleaks — gates only the jobs that publish, so a red scan blocks the release while
  every other job runs to its own verdict
- licences — every dependency's licence is on the allowlist in `packages/config/licenses.json`,
  or named in that file's exceptions with its reason
- doc paths — every backticked, root-anchored, placeholder-free path cited in a `CLAUDE.md`
  anywhere in the tree, or in a `docs/**/*.md` outside a record directory (one holding
  records rather than descriptions of the current system; the list of record is in
  `scripts/verify-document-paths.ts`), names an entry the worktree holds or an ignore rule
  covers. Agent definitions and skill files are outside its reach; a path in one is
  proven by reading it. A line reference on a citation is stripped before the check, so the gate proves
  the path and never the cited line; in a record directory it proves neither. A `file:line`
  citation is proven by reading the line.
- privacy sweep — the whole tree, plus commit dates over the range the event introduced
- test — AI calls replay from cassettes while the request is unchanged; a changed or
  uncached request makes one real call and records it in the same run
  (`docs/CI-CASSETTES.md`). The job installs Chromium and Firefox for the vitest files
  that launch a real browser.
- build + bundle verification

A job that runs tests addresses a stack of its own, and generated env files are named per
stack (the default `development` stack's are unsuffixed). Every step is a process of its
own, so a job states its stack once in its `env` block as `HB_ENV_MODE` and generates
that stack's files with `pnpm generate:env --mode=<mode>`; a job whose stated stack and
generated stack disagree fails `scripts/root-chain-stacks.test.ts`. A Postgres cluster is
born with only the default stack's database, and the bring-up that creates a missing one
locally returns at its CI guard, so such a job runs `scripts/stack-database-ready.ts`
before `pnpm db:migrate`; a job that migrates without it fails
`scripts/ci-stack-database.test.ts`.

No workflow runs the test suite or the lint gates on macOS or Windows, by decision.
`docs/CODE-RULES.md` §Platform Agnostic is therefore held by review, not by a gate: a
claim that a script, hook or tooling path works on a platform stays inferred until someone
runs it there. A green CI run is evidence for Linux — and, for the scripts the iOS release
build calls, macOS — and for nothing else.

A scheduled gate that dies before reaching a verdict looks, from outside, like one
that reached a failing verdict — a red run nobody opens — and only the first means
nothing measured anything. What separates them is what the run left behind: a gate
that reached a verdict published it as an artifact, pass or fail. A read-only auditor
(`scripts/gate-auditor.ts`, on its own schedule in `.github/workflows/gate-auditor.yml`)
reads each watched gate's newest finished run and opens one issue, titled
"A scheduled gate produced no verdict", naming the run that left none; it closes the
issue when every gate leaves one. A gate that runs and reports a failing verdict is
working and is not reported there. Which gates are watched, and which are excused
because no outside reader can open their verdict — the auditor itself among them —
the auditor module states.

Contributor-PR CI phases and the staging→public sync are in `docs/PUBLICATION.md`.

## A verdict on your own file

The gates are held to one isolation property: a red result in a file you never touched
does not change the verdict a check returns about your own, and where a mechanism
cannot hold it, its output says so instead of passing silently. Coverage is the case a
developer meets: the consolidated test run is one vitest invocation, so a test file
failing anywhere in it is inside the same run as your package. The run still writes its
coverage map and judges every package against the per-file thresholds, under a
`PARTIAL COVERAGE` banner naming how many test files failed; the figures for the
sources a failing test would have reached past the point it failed are short, never
inflated, so a package with no failing file gets its full verdict. A
`COVERAGE NOT EVALUATED` banner means the run wrote no map at all, and that verdict is
silent about coverage rather than green on it (`scripts/lib/vitest/coverage-scope.ts`
states both). A missing or short coverage figure on a package with no failing file
therefore points at the run, not the package: find the failing file the banner counts.

## A verdict on a file no gate reads

A gate's green speaks for the files it examined, and its output for "examined nothing"
is its output for "examined this and found it clean": a tool handed a file outside its
scope reports a pass, never a refusal. Whole trees sit outside every lint root, by a
decision the root ESLint config records: that config ignores every subdirectory and
every dot-directory, each workspace package lints only its own tree, so a root-level
dot-directory — `.claude/` among them — is in no lint root, and the vendored
frontend-design skill scripts under it are exempt by a named ignore carrying their
provenance. No lint rule is measured there — the module-size cap included — and a
package typecheck likewise says nothing about a file its `tsconfig.json` never includes.
The file classes ESLint reads from no directory even inside a package, and the scoped-run
trap, are in §Git hooks. Before taking a lint verdict as evidence about a file, establish
that the tool read it: `eslint --print-config <file>`, run from the package, prints the
resolved configuration for a file the config examines and `undefined` for one it
ignores.

## Reading an unused-export finding

`pnpm lint:unused` (knip) flags an export nothing imports, including the barrel line that
re-exports it. Read findings from a full-repo run and filter by path: a run scoped with
`--workspace <dir>` cannot see consumers outside that workspace, so it reports live
exports as unused, and acting on it deletes them. What a finding permits — delete, record
as unwired work, or tag an exemption — is `docs/CODE-RULES.md` §Never Hide Problems.

## Real external services in CI

`pnpm verify:evidence --require=<name>` fails a CI job unless a `service_evidence` row
proves the named seam was exercised for real, rather than merely that its code path ran.
The names are the registry in `packages/db/src/evidence.ts`; every declared name is
required by a step in `.github/workflows/ci.yml`, arch-enforced, so a name cannot exist
before its proof does, and a seam nothing can prove yet is recorded in
`docs/DECISIONS.md` §Recorded exceptions instead. Which job and which phase requires a
name is the `if:` on its step. Two kinds of proof exist:

- **Credentialed vendor calls** run only after review, with the restricted CI
  credentials (what each grants: `docs/SECRETS.md`). OpenRouter is two names because its
  seams fail independently: `openrouter-inference` replays a record-on-miss cassette, and
  a warm-cache replay counts because the cassette holds bytes a real call produced;
  `openrouter-catalog` is an uncassetted live read, so only a live read satisfies it.
- **The object-store pair** (`r2-storage`, `r2-gc`) runs in both phases, pull requests
  included, because the endpoint is the job's local MinIO and no credential is read. Its
  row proves the adapter built a request a compatible S3 endpoint accepted — never that
  Cloudflare accepted anything.

A test that writes an evidence row opens the database through `evidenceDatabaseUrl`
(`packages/db/src/test-db.ts`), never the suite's ordinary handle: every vitest worker
retargets `DATABASE_URL` at a per-worker clone that teardown drops, while
`verify:evidence` opens the stack's own database in a later process, so a row written
through the ordinary handle is gone before anything looks for it and the step fails
exactly as it fails when the test never ran. A test that fakes the HTTP transport writes
no row at all. `arch:check` refuses both the wrong handle and the faked transport.

## Building the web bundle

Each built output — the web dist and the admin dist — has a lease of its own, held by
whoever writes it. The writers are exactly the package scripts wrapped in
`scripts/with-build-lease.ts` (`pnpm build` and `pnpm build:e2e` among them). A second
writer is refused with a message naming the holder: that refusal is a live lease, not a
broken build — re-run once the holder exits. The lease is an OS advisory lock on the
lease file, so the kernel releases it the instant the holder exits, killed or not;
nothing expires and nothing is left to clean up. The web package's own `build` script
(`vite build`), invoked directly, writes without a lease. A local `pnpm e2e` builds
through `build:e2e` before serving, so it meets the same refusal.

`pnpm verify:bundle` verifies an already-built `apps/web` dist; name other dist
directories as arguments. Bundle verification is invoked, never ambient: `apps/admin` and
`apps/sandbox` verify themselves at build, and the web dist is verified by workflow steps
— the merged bundle before upload, the pre-merge dist Android packages, the mobile OTA
bundles. Presence in the guard's app map declares the app's targets; it is not coverage.

## The React build the end-to-end suite runs

The web and admin bundles run React's production build in every `vite build`, the
end-to-end build included, and the marketing site's end-to-end build keeps development
React (ruled 2026-09-25). The two apps mount with `createRoot` and never hydrate, so each
pins the production build in its own Vite config, and the e2e modes' `NODE_ENV` registry
value (`packages/shared/src/env/env.config.ts`), which is also the Worker's environment
identity, stays the development value. The marketing islands hydrate, and development
React's hydration attribute comparison is the suite's hydration check: the end-to-end
console guard (`e2e/helpers/page-guardrails.ts`) has no allowance for a hydration
mismatch message. The web and admin apps' development-only React warnings therefore never
reach that guard. Bundle verification refuses an app chunk carrying React's development
build, and an end-to-end build whose marketing islands lack it (`scripts/verify-bundle.ts`).

## The marketing preview build

The marketing site builds twice. The second build (`admin-preview:build` in
`apps/marketing`, config `astro.config.preview.mjs`) has the base `/preview`, and
`admin-preview:assets` (`scripts/lib/bundling/admin-preview.ts`) copies it into the
admin app's static-asset directory under that prefix, minus the on-device speech engine;
the admin build depends on that copy (`apps/admin/turbo.json`), so the assets Worker
serves the copy beside the SPA. It exists because the admin growth dashboard's click
overlay frames a marketing page and reads its DOM, and every public marketing page denies
framing — a copy on the admin origin can be framed same-origin while the public site's
headers stay exactly as they are. The beacon's hostname guard keeps the copy from
counting, pinned by `apps/marketing/src/page-tests/admin-preview.test.ts`. Design:
`docs/GROWTH-MEASUREMENT.md`.

## On-device model artifacts

`pnpm weights:seed` fills the local R2 store with the on-device model artifacts
(prediction and speech weights, tokenizers, configs, voice blobs). Downloaded bytes cache
under `scripts/.cache/`, and a receipt inside the stack's wrangler local store makes an
unchanged artifact set a no-op; `pnpm dev` runs it, and on a fresh checkout it is a
one-time download of hundreds of megabytes. `pnpm e2e:prepare` runs the speech-only
scope, `pnpm weights:seed:e2e`, into a store the E2E bring-up has just emptied, receipt
included (`docs/LOCAL-STACK.md` §What `pnpm dev` starts), so every E2E run writes that
set again from the download cache. E2E autocomplete
runs behind a deterministic stub predictor, so no E2E test requests the prediction
weights. CI caches that download — never the seeded store, which does not outlive the
job — under a key hashed from the artifact manifest
(`scripts/lib/model-weights/manifest.ts`), so any artifact change refetches.
`pnpm weights:publish` is the production counterpart: it writes the same set to the R2
bucket and skips every object already published. Against an unseeded store the route
serving those artifacts answers 404. In-browser autocomplete then stays silent,
reporting nothing anywhere. Read-aloud reports: the cause reaches the browser console
where the failure becomes the generic error state, and the speech engine
(`packages/ui/src/components/accessibility/lib/tts-engine.ts`) refuses to load when
every worker slot fails warmup with the same error.

The prediction worker (`apps/web/src/lib/prediction/prediction.worker.ts`) carries a
load-time canary: a fixed greedy generation compared against a pinned token sequence,
which holds only for the ONNX Runtime build that produced it; on a mismatch the worker
refuses to serve, so a wrong runtime yields silence rather than wrong completions. The
same canary runs in CI as a browser-mode vitest against the real runtime and the seeded
weights, so a bump of `@huggingface/transformers`, or anything else that moves
`onnxruntime-web` in `pnpm-lock.yaml`, reddens the run and prints the sequence the new
runtime produces; re-pinning is copying that sequence into the constant in the same change.

## The production deploy

Only a push to public `main` deploys, and a release tag `v<X.Y.Z>` means that version
shipped and proved it. Every publishing job needs each check it rests on to have
succeeded; the `verdict` gate stands for the check jobs (`docs/PUBLICATION.md` §Green
borrowing).

**Numbers are claimed before the build.** The `version-claim` job takes the next number
(`scripts/compute-next-version.ts`) by creating `refs/version-claims/v<X.Y.Z>` on public.
Claims run one at a time and the push is create-only, so no two runs share a number.
Readers that date shipped code, the legal effective dates among them, read release tags,
never claims. A run whose commit is behind a commit already holding a number claims
none, and its deploy skips: shipping it would be a downgrade.

**Each number ships once, in order.** Deploys queue one at a time. Before publishing
anything, the deploy refuses a version not strictly newer than the one the API Worker
serves (`scripts/deploy-order-guard.ts`), because the native client applies any server
version that differs from its own, lower included. It also refuses a version whose
over-the-air bundle R2 already holds, because a re-upload would hand that version's
clients different bytes under the same number. The version and the bundle checksums ride
the API Worker's code upload, as its secrets do (`docs/SECRETS.md` §Rules), so they go
live with the code that serves them.

**A release is tagged only when every surface proves it.** After the uploads, the deploy
checks that the API serves the version with an over-the-air manifest matching the
published bundles, then that web, sandbox and admin serve it
(`scripts/verify-deployed-surfaces.ts`): web and sandbox by the version stamped in their
files, the admin and sandbox Workers by the release tag on the Worker version carrying
all their traffic, and the admin origin by redirecting an unauthenticated request to the
account's Access team. A failed check, an unresolvable hostname included, leaves
production serving the new code with the release untagged.

### Recovering a red deploy

A failed deploy burns its number. Re-run all jobs, or push again: either claims a fresh
number, higher than anything the failed attempt left live, and runs the whole chain.
Re-running only the failed deploy job keeps its number, which the guards refuse once
anything was published under it. Never delete a published bundle, or write a claim or a
tag by hand, to force a number through: the guards are what keep one number to one set
of bytes.
