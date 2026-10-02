# Operations Scripts

Production-affecting scripts triggered by PR labels and gated by the
`production` GitHub Environment. Scripts in this directory may read prod
credentials from the runner env at deploy time.

## Trust model

| Layer                                                             | Protects against                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Branch protection + CODEOWNERS on `ops/` and `.github/workflows/` | Sneaking new scripts into the allowlist or weakening the runner |
| `production` environment with required reviewer                   | Any merged script running without explicit per-run approval     |

## Adding a script

1. Write the script in `ops/<domain>/<verb>.ts`. Dispatch via `pnpm tsx`.
2. **Make it idempotent.** Re-running with the same inputs must be safe.
   The runner re-runs on retry; non-idempotent scripts are unsafe.
3. **Dependency-inject at network boundaries** so tests can mock the
   signing/fetch surface without real credentials. Pattern: see
   `ops/r2/configure-cors.ts`.
4. Colocate `<verb>.test.ts`. Cover XML/payload shape, missing-env
   validation, and error responses. 95% line + branch coverage per
   `docs/CODE-RULES.md`.
5. Add an entry to `ops/manifest.yml` declaring `name`, `file`, `phase`,
   `description`, and `requires_secrets` — plus `dispatch_only: true` if
   neither deploy phase is a safe moment to run it (see below). Editing the
   manifest requires CODEOWNERS approval.
6. If the script needs new secrets, add them to
   `packages/shared/src/env/env.config.ts` with `secret(...)` for production
   mode and run `pnpm generate:env` to update workflow YAML.
7. Open the PR. After merge, `.github/workflows/sync-ops-labels.yml`
   creates the matching `run-script:<name>` label in the repo — none for a
   `dispatch_only` entry.

## Running a script

1. On the PR that needs the script to run, apply the `run-script:<name>`
   label. Type `run-script:` in the labels dropdown for autocomplete with
   per-script descriptions.
2. On merge to `main`, the deploy job in `.github/workflows/ci.yml`:
   - Resolves the merge commit's PR labels.
   - Validates each `run-script:` label against `ops/manifest.yml`.
     Unknown names hard-fail the deploy.
   - Validates each script's `requires_secrets` are present in the runner
     env (fail-fast on missing secrets — usually means someone forgot
     `pnpm generate:env`).
   - Pauses for `production` environment approval.
   - Runs pre-deploy scripts → deploys Worker → runs post-deploy scripts.
3. Any failure halts the chain. Re-running all jobs, or pushing again,
   claims a new version and re-does everything from the top — which is why
   scripts must be idempotent. Re-running only the deploy job keeps the
   failed run's version, and the deploy's guards refuse it before any script
   that already ran runs again (`docs/BUILD-AND-CI.md` §Recovering a red
   deploy).

A `dispatch_only` script has no label. Run it from Actions → **Run ops
script** (`.github/workflows/run-ops-script.yml`), which resolves the same
manifest entry and validates the same secrets under the same `production`
approval.

## Phases

- **`pre-deploy`** — runs before the new Worker deploys. Use for additive
  / backward-compatible changes (adding CORS origins, adding DB columns
  the new Worker reads, adding feature flags).
- **`post-deploy`** — runs after the new Worker is live. Use for
  destructive or rollback-sensitive changes (removing CORS origins,
  dropping DB columns).

When in doubt, choose `post-deploy` — destructive ordering is the safer
default.

## Dispatch-only scripts

`dispatch_only: true` marks an entry no deploy may carry. It mints no
`run-script:` label, and the deploy's label resolver fails the deploy if
someone creates and applies one by hand. The entry keeps its `phase`, which
the manual runner reads to locate it, and it stays in the manual dropdown:
killing the label must not kill the safe path.

Re-sealing every user's stored key material is the case that earns the flag.
A `pre-deploy` label runs the pass before the Worker deploys, so every row
moves to the next key while the Worker comes up with the live key its deploy
uploads, which opens none of them — and because no deploy takes the API down,
the pass races live traffic. The
working sequence takes the API down first, which only a human dispatching the
manual workflow can do; `docs/runbooks/secrets/opaque-kek.md` is that sequence.

## Local invocation

Scripts in `ops/` are normal CLI tools. The label system is for
orchestration in CI; the script itself runs anywhere with the right env
vars set. See each script's header comment for a local-invocation
example.

## Naming and colocation

- Top-level subdirectories group by domain: `ops/r2/`, `ops/db/`,
  `ops/keys/`, etc.
- Filenames are `kebab-case.ts` matching the `name` in the manifest with
  the domain prefix dropped: `ops/r2/configure-cors.ts` ↔
  `name: configure-r2-cors`.
- Tests live next to source: `configure-cors.test.ts`.
- Shared CLI helpers live in `ops/lib/` (`run-cli.ts` for argv parsing). This tree
  is deliberately self-contained: nothing under `ops/` imports from `scripts/`,
  because a relative reach into a workspace this manifest does not declare compiles
  sources the typecheck task never hashed (`docs/TASK-ORCHESTRATION.md` §Cache
  soundness).
