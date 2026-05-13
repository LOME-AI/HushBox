# Operations Scripts

Production-affecting scripts triggered by PR labels and gated by the
`production` GitHub Environment. Scripts in this directory may read prod
credentials from the runner env at deploy time.

## Trust model

| Layer | Protects against |
|---|---|
| Branch protection + CODEOWNERS on `ops/` and `.github/workflows/` | Sneaking new scripts into the allowlist or weakening the runner |
| `production` environment with required reviewer | Any merged script running without explicit per-run approval |

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
   `description`, and `requires_secrets`. Editing the manifest requires
   CODEOWNERS approval.
6. If the script needs new secrets, add them to
   `packages/shared/src/env.config.ts` with `secret(...)` for production
   mode and run `pnpm generate:env` to update workflow YAML.
7. Open the PR. After merge, `.github/workflows/sync-ops-labels.yml`
   creates the matching `run-script:<name>` label in the repo.

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
3. Any failure halts the chain. Re-running re-does everything from the
   top — which is why scripts must be idempotent.

## Phases

- **`pre-deploy`** — runs before the new Worker deploys. Use for additive
  / backward-compatible changes (adding CORS origins, adding DB columns
  the new Worker reads, adding feature flags).
- **`post-deploy`** — runs after the new Worker is live. Use for
  destructive or rollback-sensitive changes (removing CORS origins,
  dropping DB columns, rotating keys).

When in doubt, choose `post-deploy` — destructive ordering is the safer
default.

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
- Shared CLI helpers come from `scripts/lib/` (e.g.,
  `../../scripts/lib/run-cli.js` for argv parsing). Don't duplicate.
