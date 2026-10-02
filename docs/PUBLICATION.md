# Publication

How HushBox code becomes public. Two repositories, one codebase: maintainers work in a
private staging repo; the public repo is what outside contributors fork and PR against.
A bot is the only writer of public `main`. Publication is scheduled, green-gated, and
decoupled from when anyone actually worked.

Why this shape:

- **Timing privacy.** Commit dates in this repo are normalized to day resolution, but
  GitHub records the server-side moment of every push. Publishing on a schedule means
  the public event stream discloses only that the schedule fired.
- **Always-green public `main`.** The mirror advances only to a commit whose full suite
  is green, so public `main` is green by construction, not by discipline.
- **An undo window.** Anything that reaches a public repo is effectively permanent
  (clones, archives, no garbage-collection guarantee on dangling commits). Work in
  staging is still recoverable; work on public `main` is not.

## Topology

```
outside contributor ──fork──> PUBLIC repo ──merge queue (squash)──> public main
                                                                        │
                                                        inbound sync (bot)
                                                                        ▼
maintainer ──push anytime──> STAGING main ──scheduled mirror (bot)──> public main
```

- **Staging** (`HushBox-staging`, private) — where all maintainer work happens.
  Maintainers' clones of the public repo route pushes here automatically (see
  §Maintainer setup); nothing else changes about daily work.
- **Public** (`HushBox`) — carries `main`, release tags, and version claims
  (`refs/version-claims/v<X.Y.Z>`, `docs/BUILD-AND-CI.md` §The production deploy). A
  ruleset restricts updates and creations on `main` to the sync bot alone; force pushes
  are blocked; no human, including admins, can push it. The claims record which numbers
  are taken: pruning them lets a deploy reuse a number, and a ruleset refusing their
  creation fails every deploy at its `version-claim` job.
- **Outbound mirror** — a scheduled workflow in staging (`0 0 * * *` UTC, pinned;
  never timezone-tracking) fast-forwards public `main` to the newest staging commit
  whose `ci.yml` push run in staging succeeded with every borrowable job concluded
  success (`isBorrowable` in `scripts/lib/publication/api.ts`), searching back a bounded
  number of first-parent commits
  (`MIRROR_SCAN_DEPTH` in `scripts/publish-mirror.ts`). Past that bound it finds
  nothing and publishes nothing — a green run, no auditor issue — so a suite left red
  for longer than the scan depth stalls publication silently (see the runbook's
  no-signal symptom). It refuses — loudly — rather than force-push when a
  fast-forward is impossible. A `workflow_dispatch` trigger publishes immediately when
  needed; using it discloses that moment, which is the accepted trade for urgency. A
  dispatch publishes from the trunk whatever branch the dispatch dialog was pointed at:
  publishing a chosen branch's tip would put unmerged work on public irreversibly.
- **Inbound sync** — when a contributor PR merges on public, the bot brings public
  `main` into staging immediately, so staging is always a superset.
- **Invariant** — public `main` is always an ancestor of staging `main`. A scheduled
  read-only auditor checks this and the mirror's freshness, and opens an issue on the
  staging repo when either fails. An unresolved auditor issue means publication is
  stalled: what looks published to you may not be.

## The contributor PR lifecycle

1. Contributor forks the public repo and opens a PR against `main`. Nothing about
   their workflow is unusual; their clone needs no setup beyond `pnpm install`
   (which also normalizes their commit dates to day resolution — contributing to
   HushBox does not publish your working hours).
2. **Phase 1 CI** runs on the PR (first-time contributors need a maintainer's
   approval click, per repo settings): the full gate set and test suite in
   `test` mode — development values on the job's own data plane, mocked vendor
   seams, no secrets; evidence verification only for the object-store seams, whose
   endpoint is the local emulator — on GitHub-hosted runners. Superseded runs are
   cancelled automatically.
3. A maintainer reviews and approves, then queues the PR ("merge when ready").
   Queueing is the authorization: it is the only act that lets this code near
   secrets — and the queue runs the PR's own tree, including any edit it makes under
   `.github/workflows/`, so a workflow-file diff is a security diff. Review it with
   the same scrutiny as code before queueing.
4. **Phase 2 CI** runs in the merge queue (`merge_group`): the full suite in real-CI
   mode with the restricted CI credentials, evidence verification on, plus the
   alignment gate — a required check that confirms staging and public are in sync
   before any merge proceeds (guards a race where a sync-in-flight change could be
   silently reverted).
5. The queue squash-merges. The contributor gets the Merged badge and contribution
   credit (authorship is preserved; the graph keys on the commit author's email).
6. The inbound sync carries the merge into staging.

Safety properties, all structural: pushing new commits to a queued PR dequeues it
(the code that merges is the code that was queued); new commits dismiss stale
approvals; re-queueing requires write access, so no outside contributor can re-enter
the queue themselves.

### When the queue fails a PR

The PR is dequeued and returns to normal PR state with the failing run attached. The
contributor fixes, the maintainer re-reviews and re-queues. Known gaps between the
phases:

- The build, E2E, and mobile jobs run only in phase 2 (`ci.yml` gates them on the
  event), so a fork PR can be green while its build is broken; that surfaces when a
  maintainer queues it, never earlier.
- A PR that changes an AI request can be green in phase 1 (the mock accepts any
  request) and still fail or spend in phase 2, where the request is real. A changed
  request records a fresh cassette in the queue run itself; at worst the same request
  is recorded once more by a later trusted run — one extra charged call, never a
  failure.

### When a problem ships

- **A merged contributor PR is wrong** — it is already public; fix forward with a
  revert PR through the same queue. There is no undo on public history.
- **Maintainer work in staging is wrong** — if it has not been mirrored yet, rewrite
  freely; that is the undo window. After the mirror has published it, fix forward.

## Two-phase CI reference

|           | Phase 1 (`pull_request`)                                                  | Phase 2 (`merge_group`) + staging/main pushes                        |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Runners   | GitHub-hosted (free for public repos)                                     | The repo's configured runners                                        |
| Env mode  | `test` (development values, mocked vendor seams)                          | `ciVitest` / `ciE2E` (real calls)                                    |
| Secrets   | None                                                                      | Restricted CI set                                                    |
| Evidence  | Object-store seams only — local emulator, no credential read              | Every declared name (`verify:evidence`)                              |
| Cassettes | Not used (mock provider)                                                  | R2 store, record-on-miss                                             |
| Jobs      | All gate jobs (including the whole-tree privacy sweep) and the test suite | Those, plus the jobs `ci.yml` gates on the event: build, E2E, mobile |

Workflows are shared between both repos and branch on the event and on
`github.repository` compared against a repository variable — never a hardcoded slug.
Deploy, inbound sync, and releases run only in public; the scheduled outbound mirror
runs only from staging (a scheduled workflow fires in every repo that carries the
file — the repository guard is what stops the public copy).

At provisioning the CI privacy sweep goes red exactly once, by design: the push that
creates public `main` reports no starting commit, and the commit-date backstop refuses
an unbounded range rather than guessing one. Nothing depends on that run; the next push
carries a real range and the sweep passes.

## Green borrowing

A push to public `main` whose commit staging's own `ci.yml` push run already proved (the
mirror's predicate, §Topology) skips the check jobs that proof covers. The `borrow` job
reads staging's run (`scripts/green-borrow.ts`), and the `verdict` job judges the skips
before anything publishes: a failed or cancelled check refuses, and a skipped one passes
only when the borrow succeeded (`scripts/deploy-verdict.ts`). The borrowable jobs, those
whose verdict is a function of the commit alone, are listed in
`scripts/lib/publication/borrowed-jobs.ts`; every other job — the secret scan, the
privacy sweep, the version and the build among them — runs on every push. A public push
showing skipped check jobs is this working.

Only a commit staging has already run can borrow: a mirror publication always can, while
a merge-queue squash is minted on public, so its landing push runs every check. Any state
the borrow cannot establish also runs every check, so a broken borrow costs time, never
correctness. The borrow reads staging with the sync App's credentials held in the public
repository (`docs/runbooks/secrets/github-app-key.md`): a missing credential marks the
`borrow` job with an error annotation, and a key GitHub refuses shows only in that job's
summary.

## The cassette store

AI-call cassettes live in one R2 bucket shared by both repos and every branch —
replacing per-repo, branch-scoped Actions cache. A request is recorded once, ever, by
whichever trusted run first misses; there is no eviction. Store-unreachable degrades
to cold-cache behavior (record live, loud log line). Fork PRs run the mock provider
and never reference the store or its credential. Mechanics: `docs/CI-CASSETTES.md`.

## Maintainer setup

Nothing manual. `pnpm install` in a clone of the public repo detects (a) that
`origin` is the canonical public repo and (b) that you can reach staging, then sets
the push URL of `origin` to staging. Fetch stays on public; `git push` goes to
staging. Forks and clones without staging access are untouched. The pre-push hook
additionally refuses a push aimed directly at the public repo from a routed clone.

## Stalled-mirror runbook

Symptoms: the auditor issue is open; public `main` has not advanced past its
schedule; a contributor asks why a merged fix is not in a release. One symptom has no
signal at all behind it: **public `main` is far behind and every mirror run is
green.** Past the search bound (`MIRROR_SCAN_DEPTH` in `scripts/publish-mirror.ts`)
the mirror publishes nothing and exits successfully, and the auditor's freshness
check reads the mirror's own successful runs — so a stall past the bound raises no
issue and reds no run. Step 2 below tells you a green run that published nothing is
normal; it is normal only while public `main` is within the bound of staging's trunk.
Count the commits between them first.

1. Read the auditor issue — it states which check failed (ancestry or freshness).
2. Check the outbound mirror's latest run in staging's Actions tab. **Nothing
   publishable** is not a red run: the run succeeds and says in its log that it
   published nothing. Only staging's own `ci.yml` push run makes a commit publishable
   (§Topology); a green pull-request run, a push run still in progress, or one whose job
   listing came back incomplete counts for nothing. Fix the suite: the mirror publishes
   the newest proven commit, so an unproven head only delays the commits after the last
   proven one. A red run states its refusal reason; the two expected ones are
   **non-fast-forward** (public `main` has a commit staging lacks — the inbound sync
   failed or lagged; run it, then re-run the mirror) and **a failed staging read** (the
   scoped token mint, or the run or job listing, was refused or malformed; the log names
   which). A refused mint points at the sync App's key, its installation on staging, or
   its "Actions" read permission (`docs/runbooks/secrets/github-app-key.md`).
3. Never resolve a non-fast-forward by force-pushing public. The ruleset blocks it;
   the block is the design working, not an obstacle.
4. After any fix, re-run the mirror via `workflow_dispatch` and confirm the auditor
   issue closes on its next pass.
